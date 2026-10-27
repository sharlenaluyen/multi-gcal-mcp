#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConnectedAliases, getAccountInfo, withRetry, createAuditLogger } from "google-mcp-accounts";
import { createToolDefiner, jsonResult, aliasEnumHint, markUntrusted, UNTRUSTED_NOTICE } from "./mcp.js";
import {
  calendarClientFor,
  assertCanListCalendars,
  buildEventBody,
  buildEventPatch,
  notifiedAttendees,
  summarizeEvent,
  diffEvent,
  buildRsvpAttendees,
  RESPONSES,
  MAX_SUMMARY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_ATTENDEES,
} from "./calendar.js";

const server = new McpServer({ name: "multi-gcal-mcp", version: "1.0.0" });

// Shared ~/.google-mcp/audit.log, every line tagged with this server's name.
const logAuditEvent = createAuditLogger("multi-gcal-mcp");

// MCP tool annotations: hints that let the client (Claude Desktop) decide
// which calls to auto-approve and which always need the user's OK. The
// confirm flags are set by the model, so the client's approval prompt is the
// real human check - these hints are what drive it.
const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
// Emails other people (invites, updates, cancellations, RSVPs) - can't be unsent.
const NOTIFIES_OTHERS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const TOOL_ANNOTATIONS = {
  list_accounts: { readOnlyHint: true, openWorldHint: false },
  list_calendars: READ_ONLY,
  list_events: READ_ONLY,
  search_events: READ_ONLY,
  create_event: NOTIFIES_OTHERS,
  update_event: NOTIFIES_OTHERS,
  delete_event: NOTIFIES_OTHERS,
  respond_to_event: NOTIFIES_OTHERS,
};
const defineTool = createToolDefiner(server, TOOL_ANNOTATIONS);

const calendarId = z
  .string()
  .max(1024)
  .default("primary")
  .describe('Calendar id from list_calendars; "primary" is the account\'s main calendar');
const eventId = z.string().min(1).max(1024).describe("Event id from list_events or search_events");
const timeBound = z.string().max(64).optional();

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

defineTool(
  "list_accounts",
  "List every Google account connected to this server, with its alias, any nicknames, and email address. A nickname can be passed anywhere an alias is accepted. Always call this first if you don't already know the aliases.",
  {},
  async () => {
    const accounts = getConnectedAliases().map((alias) => {
      const info = getAccountInfo(alias);
      return { alias, nicknames: info.nicknames, email: info.email };
    });
    return jsonResult({ accounts });
  }
);

defineTool(
  "list_calendars",
  `List the calendars an account is subscribed to (id, name, access role, primary flag).${aliasEnumHint()}`,
  { account: z.string() },
  async ({ account }) => {
    const info = getAccountInfo(account);
    const calendar = calendarClientFor(account);
    assertCanListCalendars(info);
    const { data } = await withRetry(() => calendar.calendarList.list({ maxResults: 250 }));
    const calendars = (data.items || []).map((c) => ({
      id: c.id,
      name: markUntrusted(c.summaryOverride || c.summary),
      access_role: c.accessRole,
      primary: Boolean(c.primary),
      time_zone: c.timeZone,
    }));
    return jsonResult({ notice: UNTRUSTED_NOTICE, account: info.alias, email: info.email, calendars });
  }
);

async function listEvents({ account, calendar_id, query, time_min, time_max, max_results }) {
  const info = getAccountInfo(account);
  const calendar = calendarClientFor(account);
  const { data } = await withRetry(() =>
    calendar.events.list({
      calendarId: calendar_id,
      q: query,
      timeMin: time_min,
      timeMax: time_max,
      maxResults: max_results,
      singleEvents: true, // expand recurring events into their instances
      orderBy: "startTime",
    })
  );
  return jsonResult({
    notice: UNTRUSTED_NOTICE,
    account: info.alias,
    email: info.email,
    calendar_id,
    time_zone: data.timeZone,
    count: (data.items || []).length,
    events: (data.items || []).map(summarizeEvent),
  });
}

defineTool(
  "list_events",
  `List events on one calendar in a time window, soonest first, with recurring events expanded. time_min defaults to now. Times are RFC 3339, e.g. 2026-11-03T00:00:00-08:00.${aliasEnumHint()}`,
  {
    account: z.string(),
    calendar_id: calendarId,
    time_min: timeBound.describe("Earliest end time to include (RFC 3339). Defaults to now."),
    time_max: timeBound.describe("Latest start time to include (RFC 3339)"),
    max_results: z.number().int().min(1).max(100).default(25),
  },
  async ({ account, calendar_id, time_min, time_max, max_results }) =>
    listEvents({
      account,
      calendar_id,
      time_min: time_min || new Date().toISOString(),
      time_max,
      max_results,
    })
);

defineTool(
  "search_events",
  `Free-text search of one calendar's events (matches title, description, location, attendees). Searches upcoming events unless time_min is given.${aliasEnumHint()}`,
  {
    account: z.string(),
    query: z.string().min(1).max(500),
    calendar_id: calendarId,
    time_min: timeBound.describe("Earliest end time to include (RFC 3339). Defaults to now."),
    time_max: timeBound.describe("Latest start time to include (RFC 3339)"),
    max_results: z.number().int().min(1).max(100).default(25),
  },
  async ({ account, query, calendar_id, time_min, time_max, max_results }) =>
    listEvents({
      account,
      calendar_id,
      query,
      time_min: time_min || new Date().toISOString(),
      time_max,
      max_results,
    })
);

// ---------------------------------------------------------------------------
// Write - every one of these can email other people, so each is a dry run
// unless explicitly confirmed, and none is ever auto-retried (a retry after
// a timeout could send a second invite or cancellation).
// ---------------------------------------------------------------------------

const eventFields = {
  summary: z.string().max(MAX_SUMMARY_LENGTH),
  start: z
    .string()
    .max(64)
    .describe(
      "YYYY-MM-DD for an all-day event, or an RFC 3339 date-time like 2026-11-03T15:00:00-08:00 (offset optional if time_zone is given)"
    ),
  end: z
    .string()
    .max(64)
    .optional()
    .describe("Same format as start. Defaults to 1 hour after start, or the next day for all-day events."),
  time_zone: z.string().max(64).optional().describe('IANA time zone, e.g. "America/Los_Angeles"'),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  location: z.string().max(MAX_LOCATION_LENGTH).optional(),
  attendees: z
    .array(z.string().max(320))
    .max(MAX_ATTENDEES)
    .optional()
    .describe("Guest email addresses. Every guest gets an email invitation from Google."),
};

function writeError(action, info, detail, err) {
  logAuditEvent({
    action,
    account: info.alias,
    email: info.email,
    outcome: "error",
    detail: { ...detail, error: err?.message },
  });
  return err;
}

defineTool(
  "create_event",
  `Create a calendar event. By default this is a DRY RUN: it returns exactly what would be created and who Google would email an invitation to, and does NOT contact Google. Pass confirm_create: true only once the preview has been reviewed and approved - guests are emailed immediately and that can't be undone.${aliasEnumHint()}`,
  {
    account: z.string(),
    calendar_id: calendarId,
    ...eventFields,
    confirm_create: z
      .boolean()
      .default(false)
      .describe(
        "Must be explicitly true to actually create the event. False (default) returns a preview only."
      ),
  },
  async ({ account, calendar_id, confirm_create, ...fields }) => {
    const info = getAccountInfo(account);
    const body = buildEventBody(fields);
    const emailed = (body.attendees || []).map((a) => a.email).filter((e) => e !== info.email.toLowerCase());
    const detail = { calendar_id, summary: body.summary, start: body.start, attendees: emailed };

    if (!confirm_create) {
      logAuditEvent({
        action: "create_event",
        account: info.alias,
        email: info.email,
        outcome: "dry_run",
        detail,
      });
      return jsonResult({
        dry_run: true,
        would_create: { calendar_id, ...body },
        invitations_emailed_to: emailed,
        note: "Re-call with confirm_create: true to actually create this event.",
      });
    }

    const calendar = calendarClientFor(account);
    try {
      const { data } = await calendar.events.insert({
        calendarId: calendar_id,
        sendUpdates: emailed.length ? "all" : "none",
        requestBody: body,
      });
      logAuditEvent({
        action: "create_event",
        account: info.alias,
        email: info.email,
        outcome: "created",
        detail: { ...detail, event_id: data.id },
      });
      return jsonResult({ created: summarizeEvent(data), invitations_emailed_to: emailed });
    } catch (err) {
      throw writeError("create_event", info, detail, err);
    }
  }
);

defineTool(
  "update_event",
  `Change an existing event's title, time, description, location, or guest list. Fields left out keep their current value; attendees, if passed, replaces the whole guest list. By default this is a DRY RUN that returns a before/after of every changed field and who Google would email about the change. Pass confirm_update: true only once that's been reviewed.${aliasEnumHint()}`,
  {
    account: z.string(),
    calendar_id: calendarId,
    event_id: eventId,
    ...eventFields,
    summary: eventFields.summary.optional(),
    start: eventFields.start.optional(),
    confirm_update: z
      .boolean()
      .default(false)
      .describe(
        "Must be explicitly true to actually change the event. False (default) returns a preview only."
      ),
  },
  async ({ account, calendar_id, event_id, confirm_update, ...fields }) => {
    const info = getAccountInfo(account);
    if (Object.values(fields).every((v) => v === undefined)) {
      throw new Error("Nothing to change - pass at least one field.");
    }

    const calendar = calendarClientFor(account);
    const { data: current } = await withRetry(() =>
      calendar.events.get({ calendarId: calendar_id, eventId: event_id })
    );
    const patch = buildEventPatch(current, fields);
    const changes = diffEvent(current, patch);
    // Everyone on the old or new guest list hears about the change.
    const emailed = [
      ...new Set([...notifiedAttendees(current, info.email), ...notifiedAttendees(patch, info.email)]),
    ];
    const detail = { calendar_id, event_id, fields: changes.map((c) => c.field), attendees: emailed };

    if (!confirm_update) {
      logAuditEvent({
        action: "update_event",
        account: info.alias,
        email: info.email,
        outcome: "dry_run",
        detail,
      });
      return jsonResult({
        dry_run: true,
        notice: UNTRUSTED_NOTICE,
        event: summarizeEvent(current),
        changes,
        updates_emailed_to: emailed,
        note: changes.length
          ? "Re-call with confirm_update: true to apply these changes."
          : "Nothing would change - the event already has these values.",
      });
    }
    if (changes.length === 0) return jsonResult({ unchanged: true, event_id });

    try {
      const { data } = await calendar.events.patch({
        calendarId: calendar_id,
        eventId: event_id,
        sendUpdates: emailed.length ? "all" : "none",
        requestBody: patch,
      });
      logAuditEvent({
        action: "update_event",
        account: info.alias,
        email: info.email,
        outcome: "updated",
        detail,
      });
      return jsonResult({ updated: summarizeEvent(data), changes, updates_emailed_to: emailed });
    } catch (err) {
      throw writeError("update_event", info, detail, err);
    }
  }
);

defineTool(
  "delete_event",
  `Delete an event. By default this is a DRY RUN that shows the event and who would get a cancellation email. Pass confirm_delete: true only once that's been reviewed. If this account organizes the event, every guest gets a cancellation; if it's only a guest, the event is removed from this calendar and nobody is emailed.${aliasEnumHint()}`,
  {
    account: z.string(),
    calendar_id: calendarId,
    event_id: eventId,
    confirm_delete: z
      .boolean()
      .default(false)
      .describe("Must be explicitly true to actually delete. False (default) returns a preview only."),
  },
  async ({ account, calendar_id, event_id, confirm_delete }) => {
    const info = getAccountInfo(account);
    const calendar = calendarClientFor(account);
    const { data: current } = await withRetry(() =>
      calendar.events.get({ calendarId: calendar_id, eventId: event_id })
    );
    const isOrganizer = Boolean(current.organizer?.self);
    const emailed = isOrganizer ? notifiedAttendees(current, info.email) : [];
    const detail = {
      calendar_id,
      event_id,
      start: current.start,
      organizer: isOrganizer,
      attendees: emailed,
    };

    if (!confirm_delete) {
      logAuditEvent({
        action: "delete_event",
        account: info.alias,
        email: info.email,
        outcome: "dry_run",
        detail,
      });
      return jsonResult({
        dry_run: true,
        notice: UNTRUSTED_NOTICE,
        would_delete: summarizeEvent(current),
        cancellations_emailed_to: emailed,
        note: "Re-call with confirm_delete: true to actually delete this event.",
      });
    }

    try {
      await calendar.events.delete({
        calendarId: calendar_id,
        eventId: event_id,
        sendUpdates: emailed.length ? "all" : "none",
      });
      logAuditEvent({
        action: "delete_event",
        account: info.alias,
        email: info.email,
        outcome: "deleted",
        detail,
      });
      return jsonResult({ deleted_event_id: event_id, cancellations_emailed_to: emailed });
    } catch (err) {
      throw writeError("delete_event", info, detail, err);
    }
  }
);

defineTool(
  "respond_to_event",
  `Accept, decline, or tentatively accept an event this account was invited to. Google tells the organizer. By default this is a DRY RUN; pass confirm_send: true to actually send the response.${aliasEnumHint()}`,
  {
    account: z.string(),
    calendar_id: calendarId,
    event_id: eventId,
    response: z.enum(RESPONSES),
    comment: z.string().max(1000).optional().describe("Optional note to the organizer"),
    confirm_send: z
      .boolean()
      .default(false)
      .describe("Must be explicitly true to actually respond. False (default) returns a preview only."),
  },
  async ({ account, calendar_id, event_id, response, comment, confirm_send }) => {
    const info = getAccountInfo(account);
    const calendar = calendarClientFor(account);
    const { data: current } = await withRetry(() =>
      calendar.events.get({ calendarId: calendar_id, eventId: event_id })
    );
    const { attendees, previous } = buildRsvpAttendees(current, info.email, response, comment);
    const detail = { calendar_id, event_id, response, previous, organizer: current.organizer?.email };

    if (!confirm_send) {
      logAuditEvent({
        action: "respond_to_event",
        account: info.alias,
        email: info.email,
        outcome: "dry_run",
        detail,
      });
      return jsonResult({
        dry_run: true,
        notice: UNTRUSTED_NOTICE,
        event: summarizeEvent(current),
        would_change_response: { from: previous, to: response, comment },
        organizer_notified: current.organizer?.email,
        note: "Re-call with confirm_send: true to send this response.",
      });
    }

    try {
      const { data } = await calendar.events.patch({
        calendarId: calendar_id,
        eventId: event_id,
        sendUpdates: "all",
        requestBody: { attendees },
      });
      logAuditEvent({
        action: "respond_to_event",
        account: info.alias,
        email: info.email,
        outcome: "responded",
        detail,
      });
      return jsonResult({ event_id: data.id, response, previous });
    } catch (err) {
      throw writeError("respond_to_event", info, detail, err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
