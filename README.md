# multi-gcal-mcp

A local MCP server that lets Claude read and manage **Google Calendar across
several Google accounts** through one connection. It runs on your own
computer (stdio) and plugs into the Claude desktop app.

Accounts come from the shared [google-mcp-accounts](../google-mcp-accounts)
login, the same one the Gmail, Drive, and Docs/Sheets/Slides servers use.
Authorize each Google account once there, and this server can use it.

## Tools

Read:
- `list_accounts`: connected accounts, their aliases, nicknames, and emails
- `list_calendars`: calendars an account is subscribed to (id, name, access role)
- `list_events`: events in a time window, soonest first, recurring events expanded
- `search_events`: free-text search (title, description, location, attendees)

Write. **Every one of these defaults to a dry run** and needs an explicit
confirm flag to touch your calendar:

| Tool | Confirm flag | What the preview shows |
| --- | --- | --- |
| `create_event` | `confirm_create: true` | The exact event, and every guest Google will email an invitation to |
| `update_event` | `confirm_update: true` | A field-by-field before/after, and everyone who'll get an update email |
| `delete_event` | `confirm_delete: true` plus the preview's `etag` | The event, who'll get a cancellation (only if this account is the organizer), a warning if the id is a whole recurring series, and an `etag`. If the event changes after the preview, nothing is deleted and a fresh preview is returned |
| `respond_to_event` | `confirm_send: true` | Your response changing from X to Y, and the organizer who's notified |

Every dry run and every real write is appended to the shared audit log
(`~/.google-mcp/audit.log`, tagged `"server": "multi-gcal-mcp"`).

### Why every write gets a dry run

All four write tools can email other people: invitations, update notices,
cancellations, and RSVPs. That mail can't be unsent, so these tools follow
multi-gmail-mcp's `send_email` pattern: preview first, act only on an
explicit confirm. `respond_to_event` was the closest call, because it only
notifies the organizer. It still gets the treatment, since an RSVP is
something another person sees.

None of the writes are ever auto-retried. A retry after a timeout could send
a second invite or cancellation. Reads are retried with backoff on 429/5xx.

## Scopes

| Scope | Why |
| --- | --- |
| `calendar.events` | Read, create, change, delete, and RSVP to events. This server checks for it on every call. |
| `calendar.calendarlist.readonly` | **Needed beyond `calendar.events`, for `list_calendars` only.** `calendar.events` doesn't cover `calendarList.list` (Google's discovery doc lists only `calendar`, `calendar.readonly`, `calendar.calendarlist`, and `calendar.calendarlist.readonly` for that call). This is the narrowest of those: read-only, and limited to the list of calendars you're subscribed to. It can't read events or change any calendar's settings. |

The full `calendar` scope is deliberately **not** requested. Without
`calendar.calendarlist.readonly`, every other tool still works when you use
`calendar_id: "primary"` or a calendar id you already know. `list_calendars`
tells you to re-run `auth.js` for that alias.

## Setup

1. Set up [google-mcp-accounts](../google-mcp-accounts) and connect your
   accounts (`node auth.js <alias>`). Make sure the **Google Calendar API**
   is enabled on the Cloud project.
2. Install this server:

   ```bash
   cd multi-gcal-mcp
   npm install
   ```

   Requires Node.js 20+. This repo depends on google-mcp-accounts as a
   local folder, `"google-mcp-accounts": "file:../google-mcp-accounts"`.
   That works only while the two repos are **siblings in the same parent
   folder**. If you clone this somewhere they aren't, switch that line to a
   git dependency pinned to a tag, e.g.
   `"github:<you>/google-mcp-accounts#v1.0.0"`. The tradeoff: `file:` picks
   up shared changes immediately, and a git tag picks them up only when you
   bump it.

### Claude Desktop config

Add this under `mcpServers` in
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS),
then fully quit and reopen Claude Desktop:

```json
{
  "mcpServers": {
    "multi-gcal": {
      "command": "node",
      "args": ["/absolute/path/to/multi-gcal-mcp/src/server.js"]
    }
  }
}
```

## Input validation

- Times: `YYYY-MM-DD` (all-day) or RFC 3339 (`2026-11-03T15:00:00-08:00`).
  A time without an offset needs `time_zone`, and the end must be after the
  start. Defaults are one hour, or one day for all-day events.
- Guests: each must be one plain email address (no display names, no
  comma-lists), deduplicated, at most 100.
- Length caps: title 1,024 chars, description 8,192, location 1,024,
  search query 500, RSVP comment 1,000.

## Security notes

- **Untrusted event text.** Anyone can send you an invitation, so event
  titles, descriptions, locations, and calendar names come back wrapped in
  `<untrusted_calendar_content>` tags, with a notice telling Claude to treat
  them as data. That helps against indirect prompt injection but doesn't
  prevent it. The dry-run step and Claude Desktop's approval prompt are the
  real checks, so read them.
- **Tool annotations.** Read tools are marked read-only. All four write
  tools are marked destructive and non-idempotent, so Claude Desktop asks
  before running them.
- **Every tool call is wrapped.** A Google API error or a validation
  failure becomes a normal MCP error result and never crashes the server.
- This server never writes to `~/.google-mcp/accounts.json`. It only reads
  tokens.

## Development

```bash
npm test      # node:test - time parsing, guest validation, diffs, RSVP, tool wrapper
npm run lint
npm run format
```
