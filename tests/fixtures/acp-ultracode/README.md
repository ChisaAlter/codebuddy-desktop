# ACP ultracode fixtures (WP0)

Evidence notes for the reliability + workflow IA fix.

## CLI / dual-end timeouts

- GUI long-running `session/prompt` idle window: **10 minutes**, reset on POST chunks and (after fix) on GET-SSE progress for the same session.
- User/settings evidence often includes `CODEBUDDY_STREAM_TIMEOUT_MS=120000` and `CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS=120000` (CLI/env). If the CLI aborts the stream first, the GUI will surface a stream/abort error even when idle touch is correct.
- Do not treat GUI idle-only fixes as sufficient without checking CLI stream timeout on the machine.

## Event shape assumptions (code + tests)

| Signal | Meaning after fix |
|---|---|
| Bare `agentId` / `subagentId` on tool meta | **Not** a subagent |
| `isSubAgent` / `parentToolCallId` / `memberName` / `subagentType` | Explicit subagent |
| TaskCreate tool spam without team | `source: tools`, no auto-open panel |
| `teamUpdate.members` | `source: team`, may auto-open once per runId |
| Goal projection | `source: goal`, may auto-open |

## Capturing live samples

When reproducing U1/U3, export (redacted) `session/update` payloads from DevTools or logs into this folder as JSON for regression fixtures.
