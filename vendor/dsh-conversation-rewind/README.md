# dsh-conversation-rewind

Same-Session, append-only conversation branches and safe user-message editing for the DeepSeek Harness web UI.

[中文说明](README.zh.md) · [DSH plugins](https://github.com/topics/dsh-plugin)

## Features

- Adds an **Edit history message** action directly beside Copy under each editable user message. Editing is inline in that message row; no modal is opened.
- Replaces the former history-switching form with a visual **Branches** tree. Only the final message of each semantic branch is clickable; intermediate messages are static tree nodes.
- Clicking a branch endpoint is a client-only, read-only view of that existing path. It does not send a message, call a Provider, wake an Agent, write the inbox, append a replacement, or truncate the Session.
- Branch browsing stays in the original Session: the Session ID and browser URL stay unchanged, and no child Session is created.
- Uses DSH Surface replacement metadata to hide the selected message, its old reply, and the later active path from both the current transcript and future model context.
- Keeps the durable event log append-only. Historical events are retained for audit/recovery; the plugin appends a replacement marker instead of rewriting or deleting them.
- Sends the edited text as a real new user turn so the assistant response is regenerated.
- Confirming an edit starts a new sibling branch from that message in the original Session and regenerates its reply; later messages are not offered as an editing option.
- Permanently guards its internal edit trigger so it is cancelled before provider dispatch, including orphan recovery after a restart.

## Same-Session semantics

1. The plugin validates a completed, replay-safe user turn and rechecks the live Session before committing an edit.
2. A guarded internal turn appends a DSH `SurfaceOp` replacement over the selected message through the current active tail.
3. The internal trigger and shadowed path never enter the provider request.
4. After that internal turn is fully idle, the edited message is queued as an ordinary user turn in the same Session.
5. The new message and response are append-origin events, so the edited message can be edited again later.

The edit confirmation replaces the active path from the selected message, then queues only the edited text as a new ordinary user turn. The old message remains in the append-only history as a sibling branch; later messages are not replayed by the edit operation. Branch browsing never performs this replacement workflow.

## Safety boundaries

Only a completed turn containing exactly one direct, ordinary, plain-text user message is editable. Current injected context that precedes the target stays on the original Surface; context after the target must be a Host-owned regenerated system snapshot or skill catalog. Targets with attachments, non-text blocks, multiple direct user messages, an open/running turn, ambiguous inbox history, or unsafe later turns are hidden or rejected.

Editing currently requires the Session to be live in this DSH process. The operation fails closed if the Surface or inbox changes concurrently. A partial-result error identifies the original Session and replacement event if the Surface replacement committed but a later checkpoint failed. The inline editor immediately invalidates its old message snapshot and reloads the Session before exposing edit actions again.

Branches containing attachments, ambiguous user-role context, or another unsafe-to-replay turn remain visible in the tree. They can still be browsed when their endpoint exists, but their messages are not offered for editing.

Editing changes conversation history only. Branch browsing is read-only. Neither operation restores workspace files or reverses tool calls, commands, network requests, or any other external side effects.

## Requirements

- DeepSeek Harness `>=0.1.0-rc.6`
- Node.js `^22.19` or `>=24`
- DSH Web profile

## Install

```bash
dsh plugin --profile web add \
  https://github.com/DTSFO/dsh-conversation-rewind/archive/refs/tags/v0.1.7.tar.gz
dsh web
```

Remove with:

```bash
dsh plugin --profile web remove dsh-conversation-rewind
```

## Use

1. Open a completed Session in DSH Web.
2. Click **Edit history message** beside Copy under the target user message. The editor appears in that message row; revise the text, then click **Confirm** or **Cancel**. Confirm creates a new sibling branch in the same Session.
3. Open the **Branches** view to inspect the message tree. Click only a branch endpoint to browse that existing path in Chat.
4. While browsing, sending is disabled and the Session stays unchanged. Return to the active endpoint before sending or editing.
5. The old path remains in the append-only log; only an edit confirmation creates a replacement and regenerated reply.

## Development and testing

```bash
pnpm install
pnpm run check
dsh plugin --profile web add /absolute/path/to/dsh-conversation-rewind
dsh web
```

`pnpm run check` runs TypeScript checks, ESLint, unit tests, and the production build.

## Known limitations

- Editing is deliberately limited to replay-safe, single-message, plain-text user turns.
- Editing does not replay later user inputs; use the message tree to choose an existing historical branch instead.
- Branch browsing is a read-only client projection; it cannot reconstruct Chat rows the host does not expose in its current window.
- Non-endpoint messages are shown as static tree nodes; Host calls for a non-endpoint are rejected with `BRANCH_NOT_ENDPOINT`.
- The Session must be open and live in the current Host process.
- Workspace and external side effects are not rewound.
- This release targets the DSH Web UI and DSH `0.1.0-rc.6` APIs.

MIT
