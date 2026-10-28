import { URL } from "url";
import { google } from "googleapis";
import {
  getAccountInfo,
  createAuthClient,
  missingScopes,
  REQUIRED_SCOPES,
  shortScope,
} from "google-mcp-accounts";
import { markUntrusted } from "./mcp.js";

// Cache one authed calendar client per account (keyed by main alias) per process run.
const clientCache = new Map();

export function calendarClientFor(name) {
  const { alias } = getAccountInfo(name);
  if (clientCache.has(alias)) return clientCache.get(alias);
  const auth = createAuthClient(alias, {
    OAuth2: google.auth.OAuth2,
    requiredScopes: REQUIRED_SCOPES.calendar,
  });
  const calendar = google.calendar({ version: "v3", auth });
  clientCache.set(alias, calendar);
  return calendar;
}

// calendar.events can't list calendars; that one call needs
// calendar.calendarlist.readonly too.
export function assertCanListCalendars(info) {
  const missing = missingScopes(info, REQUIRED_SCOPES.calendarList);
  if (missing.length) {
    throw new Error(
      `Account "${info.alias}" hasn't granted ${missing.map(shortScope).join(", ")}, which listing calendars needs. ` +
        `Re-authorize it with: node auth.js ${info.alias}  (in google-mcp-accounts). Other tools work with calendar_id "primary".`
    );
  }
}

// --- Input validation -----------------------------------------------------
export const MAX_SUMMARY_LENGTH = 1024;
export const MAX_DESCRIPTION_LENGTH = 8192; // Google's own cap on event descriptions
export const MAX_LOCATION_LENGTH = 1024;
export const MAX_ATTENDEES = 100;
export const MAX_ATTACHMENTS = 25; // Google's own cap per event
export const MAX_ATTACHMENT_TITLE_LENGTH = 256;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// RFC 3339 date-time; the offset is optional only when a time zone is given.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;
// Deliberately strict: one plain address, no display name, no list.
const EMAIL = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;

export function assertEmail(value) {
  const email = String(value || "").trim();
  if (email.length > 320 || !EMAIL.test(email)) {
    throw new Error(`"${value}" isn't a single plain email address.`);
  }
  return email.toLowerCase();
}

// Google Calendar only accepts Google Drive files as attachments, so the URL
// must be a Drive/Docs link - anything else is refused before Google sees it.
const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com"]);

export function normalizeAttachments(list) {
  if (!list) return [];
  if (list.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (${list.length}, max ${MAX_ATTACHMENTS}).`);
  }
  const seen = new Set();
  const out = [];
  for (const { file_url, title } of list) {
    let url;
    try {
      url = new URL(String(file_url || "").trim());
    } catch {
      throw new Error(`"${file_url}" isn't a URL. Pass the file's Drive link (webViewLink).`);
    }
    if (url.protocol !== "https:" || !DRIVE_HOSTS.has(url.hostname)) {
      throw new Error(
        `"${file_url}" isn't a Google Drive link. Calendar can only attach Drive files - pass the file's webViewLink from the Drive server.`
      );
    }
    assertLength("attachment title", title, MAX_ATTACHMENT_TITLE_LENGTH);
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push({ fileUrl: url.href, ...(title ? { title } : {}) });
  }
  return out;
}

export function normalizeAttendees(list) {
  if (!list) return [];
  const unique = [...new Set(list.map(assertEmail))];
  if (unique.length > MAX_ATTENDEES) {
    throw new Error(`Too many attendees (${unique.length}, max ${MAX_ATTENDEES}).`);
  }
  return unique;
}

// "2026-11-03T23:30:00-08:00" -> "2026-11-04T00:30:00-08:00": one hour later,
// written in the same offset as the start so the preview reads naturally.
function addHourKeepingOffset(start) {
  const offset = HAS_OFFSET.exec(start)[1];
  const sign = offset.startsWith("-") ? -1 : 1;
  const offsetMinutes =
    offset === "Z" ? 0 : sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const local = new Date(Date.parse(start) + 60 * 60 * 1000 + offsetMinutes * 60 * 1000);
  return local.toISOString().slice(0, 19) + offset;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Turns tool arguments into the API's start/end objects. A YYYY-MM-DD start
// makes an all-day event (end defaults to the next day; Google's all-day end
// is exclusive). A date-time start needs an offset or a time_zone, and its
// end defaults to one hour later.
export function buildEventTimes({ start, end, time_zone }) {
  if (DATE_ONLY.test(start)) {
    const endDate = end ?? addDays(start, 1);
    if (!DATE_ONLY.test(endDate))
      throw new Error(`An all-day event's end must also be YYYY-MM-DD, got "${end}".`);
    if (endDate <= start) throw new Error(`end (${endDate}) must be after start (${start}).`);
    return { start: { date: start }, end: { date: endDate } };
  }
  if (!DATE_TIME.test(start)) {
    throw new Error(
      `start "${start}" isn't YYYY-MM-DD or an RFC 3339 date-time like 2026-11-03T15:00:00-08:00.`
    );
  }
  if (!HAS_OFFSET.test(start) && !time_zone) {
    throw new Error(`start "${start}" has no UTC offset; add one (e.g. -08:00) or pass time_zone.`);
  }
  let endTime = end;
  if (endTime === undefined) {
    if (!HAS_OFFSET.test(start)) throw new Error("Pass end explicitly when start has no UTC offset.");
    endTime = addHourKeepingOffset(start);
  }
  if (!DATE_TIME.test(endTime)) throw new Error(`end "${endTime}" isn't an RFC 3339 date-time.`);
  if (!HAS_OFFSET.test(endTime) && !time_zone) {
    throw new Error(`end "${endTime}" has no UTC offset; add one or pass time_zone.`);
  }
  // With offsets both parse to instants; without, both are in time_zone and
  // compare as strings.
  const after =
    HAS_OFFSET.test(start) && HAS_OFFSET.test(endTime)
      ? Date.parse(endTime) > Date.parse(start)
      : endTime > start;
  if (!after) throw new Error(`end (${endTime}) must be after start (${start}).`);
  const tz = time_zone ? { timeZone: time_zone } : {};
  return { start: { dateTime: start, ...tz }, end: { dateTime: endTime, ...tz } };
}

function assertLength(field, value, max) {
  if (value != null && String(value).length > max) {
    throw new Error(`"${field}" is too long (${String(value).length} chars, max ${max}).`);
  }
}

// The request body for events.insert / the patch for events.patch. Only
// fields that were passed are included, so a patch never blanks out
// something it wasn't asked to change.
export function buildEventBody({
  summary,
  description,
  location,
  start,
  end,
  time_zone,
  attendees,
  attachments,
}) {
  assertLength("summary", summary, MAX_SUMMARY_LENGTH);
  assertLength("description", description, MAX_DESCRIPTION_LENGTH);
  assertLength("location", location, MAX_LOCATION_LENGTH);
  const body = {};
  if (summary !== undefined) body.summary = summary;
  if (description !== undefined) body.description = description;
  if (location !== undefined) body.location = location;
  if (start !== undefined) Object.assign(body, buildEventTimes({ start, end, time_zone }));
  else if (end !== undefined)
    throw new Error("Pass start along with end, so the new times can be checked together.");
  if (attendees !== undefined) body.attendees = normalizeAttendees(attendees).map((email) => ({ email }));
  if (attachments !== undefined) body.attachments = normalizeAttachments(attachments);
  return body;
}

// Adapts buildEventBody's output for events.patch against `current`:
// - only `end` given: keep the current start (and its time zone) so the new
//   end can still be checked against it;
// - switching between all-day and timed: null the other form, or Google
//   rejects a start that has both `date` and `dateTime`.
export function buildEventPatch(current, fields) {
  const resolved = { ...fields };
  if (resolved.end !== undefined && resolved.start === undefined) {
    resolved.start = current.start?.dateTime || current.start?.date;
    resolved.time_zone ??= current.start?.timeZone;
  }
  const patch = buildEventBody(resolved);
  for (const key of ["start", "end"]) {
    if (!patch[key]) continue;
    if (patch[key].date) patch[key].dateTime = null;
    else patch[key].date = null;
  }
  return patch;
}

// Who Google will email if this write goes through with sendUpdates: "all".
export function notifiedAttendees(event, selfEmail) {
  return (event.attendees || [])
    .filter((a) => !a.self && !a.resource && a.email?.toLowerCase() !== selfEmail?.toLowerCase())
    .map((a) => a.email);
}

// What deleting this event takes with it. Ids from list_events/search_events
// are single occurrences (singleEvents: true), but an id from anywhere else
// can be a recurring series' parent, and deleting that removes every
// occurrence, past and future.
export function deleteScope(event) {
  if (event.recurrence?.length) {
    return {
      scope: "entire_series",
      warning:
        "This id is a RECURRING SERIES, not one occurrence. Deleting it removes every occurrence, past and future. To remove just one, use that occurrence's id from list_events or search_events instead.",
    };
  }
  return { scope: event.recurringEventId ? "single_occurrence" : "single_event" };
}

// --- Display ----------------------------------------------------------------
function whenOf(t) {
  return t ? t.dateTime || t.date : undefined;
}

// Compact view of an event. Text fields the event's creator wrote are wrapped
// as untrusted, since anyone can send you an invite.
export function summarizeEvent(event) {
  return {
    id: event.id,
    status: event.status,
    summary: markUntrusted(event.summary),
    start: whenOf(event.start),
    end: whenOf(event.end),
    all_day: Boolean(event.start?.date),
    location: markUntrusted(event.location),
    description: markUntrusted(event.description),
    organizer: event.organizer?.email,
    attendees: (event.attendees || []).map((a) => ({
      email: a.email,
      response: a.responseStatus,
      ...(a.self ? { self: true } : {}),
      ...(a.organizer ? { organizer: true } : {}),
    })),
    attachments: (event.attachments || []).map((a) => ({
      title: markUntrusted(a.title),
      url: a.fileUrl,
      mime_type: a.mimeType,
    })),
    recurring_event_id: event.recurringEventId,
    html_link: event.htmlLink,
  };
}

// Field-by-field before/after for an update preview. Only fields the patch
// touches are listed.
export function diffEvent(current, patch) {
  const changes = [];
  const show = {
    summary: (e) => e.summary,
    description: (e) => e.description,
    location: (e) => e.location,
    start: (e) => whenOf(e.start),
    end: (e) => whenOf(e.end),
    attendees: (e) => (e.attendees || []).map((a) => a.email).sort(),
    attachments: (e) => (e.attachments || []).map((a) => a.fileUrl).sort(),
  };
  for (const field of Object.keys(patch)) {
    const before = show[field](current);
    const after = show[field](patch);
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ field, before, after });
  }
  return changes;
}

// --- RSVP -------------------------------------------------------------------
export const RESPONSES = ["accepted", "declined", "tentative"];

// The attendee list with only this account's responseStatus changed. The
// Calendar API replaces the whole list on patch, so everyone else's entry is
// passed back exactly as it was. Throws if this account isn't invited.
export function buildRsvpAttendees(event, selfEmail, response, comment) {
  if (!RESPONSES.includes(response)) throw new Error(`response must be one of ${RESPONSES.join(", ")}.`);
  const attendees = event.attendees || [];
  const index = attendees.findIndex((a) => a.self || a.email?.toLowerCase() === selfEmail.toLowerCase());
  if (index === -1) {
    throw new Error(`${selfEmail} isn't on this event's guest list, so there's nothing to respond to.`);
  }
  const updated = attendees.slice();
  updated[index] = { ...attendees[index], responseStatus: response };
  if (comment !== undefined) updated[index].comment = comment;
  return { attendees: updated, previous: attendees[index].responseStatus };
}
