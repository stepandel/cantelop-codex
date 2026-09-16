# Codex on Cantelop

Host the Codex coding harness on [Cantelop](https://cantelop.com), with a web
console, GitHub repository tasks, streamed progress, persistent conversations,
queued follow-ups, steering, cancellation, and optional API-readable session state.

Adapted from [cantelop-agents-api-example](https://github.com/stepandel/cantelop-agents-api-example)
at commit `363673b0a76cec9fdda1adf4c8f57e49c6641e61`. The API, console and scheduling
follow that example; Codex and an OpenAI API key replace OpenCode and OpenRouter.
The pinned Codex TypeScript SDK and CLI are both `0.146.1`.

## Local setup

Requirements: Node.js 22.12+ (Node 22 recommended), npm, Cantelop CLI, Bun,
Docker with Linux amd64 support, an OpenAI API key with access to your chosen
Codex model, and a fine-grained GitHub token scoped to the intended repositories.
Use Contents read/write and Issues read/write for issue automation.

```sh
npm ci
cp .env.example .env
# Set the required values below.
npm run check
npm run dev
```

| Setting | Purpose |
| --- | --- |
| `API_TOKEN` | Random secret for console and API access. |
| `CODEX_API_KEY` | OpenAI API key used by Codex. |
| `GITHUB_TOKEN` | Repository checkout, agent commits/pushes, issue replies. |
| `GITHUB_REPOSITORIES` | Comma-separated allowlist, e.g. `your-name/your-repo`. |
| `GITHUB_WEBHOOK_SECRET` | Separate random secret for webhook signatures; required by the manifest. |
| `GITHUB_ISSUE_MODEL` | Model for issue tasks, default `gpt-5.6-terra`; select one available to your account. |
| `WORKSPACE_SLUG` | Shared persistent workspace, default `codex`. |
| `SESSION_DATABASE_URL` | Optional remote libSQL database URL. |
| `SESSION_DATABASE_AUTH_TOKEN` | Optional database credential. |

Generate secrets separately with `openssl rand -hex 32`. The Docker image installs
Codex. For host-only development, install `@openai/codex@0.146.1` globally and run
`cantelop dev`. Use an isolated development environment: the hosted agent can run
commands with access to the runtime's files and network.

Open http://localhost:8787/, choose **Settings**, and save your API token. Create
a session with an allowed repository, an exact Codex model ID, and a prompt.
Model access is validated by Codex when it runs; this app does not substitute
another model. Follow-ups retain the selected model and Codex thread.

The console provides **Queue**, **Steer**, **Stop**, **Inspect**, and **Reconnect**.
Queue waits behind earlier turns. Steer cancels the active turn and runs the new
instruction before ordinary queued turns. Stop leaves pending messages saved.
The console stores its token, defaults and local transcript in browser localStorage;
use **Forget token** to clear the credential on a shared computer.

## HTTP API

All routes except `/`, `/health`, and signature-verified `/webhooks/github`
require `Authorization: Bearer API_TOKEN`. Set these variables in your terminal;
editing `.env` does not export them into other terminals.

```sh
export BASE_URL=http://localhost:8787
export API_TOKEN='YOUR_API_TOKEN'
export REPOSITORY='your-name/your-repo'
export MODEL='gpt-5.6-terra'

request=$(curl --fail-with-body -sS "$BASE_URL/sessions" \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg repository "$REPOSITORY" --arg model "$MODEL" \
    '{repository:$repository,model:$model,prompt:"Explain the architecture. Do not modify files, commit, or push."}')")
printf '%s\n' "$request" | jq .
export SESSION_ID=$(printf '%s' "$request" | jq -r .sessionId)
curl -N --fail-with-body "$BASE_URL$(printf '%s' "$request" | jq -r .stream)" \
  -H "Authorization: Bearer $API_TOKEN"
```

HTTP 202 means dispatch succeeded, not that the turn completed. The response
includes `sessionId`, `messageId`, a turn-specific `stream` URL and a session-wide
`events` URL. A turn stream closes on its terminal application event. Disconnecting
does not cancel work. Reconnect with `Last-Event-ID` within Cantelop's retention
window, and deduplicate using event IDs.

Continue the conversation:

```sh
request=$(curl --fail-with-body -sS "$BASE_URL/sessions/messages" \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg id "$SESSION_ID" \
    '{sessionId:$id,mode:"queue",prompt:"Which tests cover the main behavior?"}')")
curl -N --fail-with-body "$BASE_URL$(printf '%s' "$request" | jq -r .stream)" \
  -H "Authorization: Bearer $API_TOKEN"
```

Use `mode: "steer"` to interrupt and follow up. POST `/sessions/cancel` or
`/sessions/inspect` with `{ "sessionId": "…" }`, then subscribe to the returned
stream for the result. Inspection includes the latest snapshot and durable inbox.

| Route | Behavior |
| --- | --- |
| `POST /sessions` | Create from `{repository, model, prompt}`. |
| `POST /sessions/messages` | Follow up with `{sessionId, prompt, mode?}`. |
| `POST /sessions/cancel` | Cancel active work with `{sessionId}`. |
| `POST /sessions/inspect` | Inspect through the runtime using `{sessionId}`. |
| `GET /events?sessionId=…` | Session-wide Cantelop stream. |
| `GET /turns/events?sessionId=…&messageId=…` | Filtered SSE for one request. |
| `GET /sessions` | Database session list; supports repository, status, limit and cursor. |
| `GET /sessions/inspect?sessionId=…` | Database snapshot without waking runtime. |
| `GET /turns/inspect?sessionId=…&messageId=…` | Database turn outcome for replay recovery. |
| `POST /sessions/reindex` | Repair the session index from Workspace snapshots. |
| `PUT /github/issue-rules` | Set `{repository, model}` for issue tasks. |
| `POST /webhooks/github` | Signed GitHub issue events. |

Progress events include `queued`, `started`, `status`, `text.delta`, `text.replace`,
and `tool.status`. Terminal events include `completed`, `failed`, `cancelled`,
`ignored`, `configured`, and inspection `session`. Use `completed.data.response`
as the final answer. Assistant text can contain several blocks; track `partId`.
Codex may emit text at item boundaries rather than token-by-token. Tool arguments,
outputs and reasoning text are not forwarded; tool type/status and reasoning
activity are shown instead.

## API-readable state with libSQL

Set `SESSION_DATABASE_URL` and, when required, `SESSION_DATABASE_AUTH_TOKEN` in
`.env`, then run:

```sh
npm run db:setup
```

Deploy the same database settings to the App. The worker writes Workspace snapshots
and indexes them in `agent_sessions`; turn admission, progress and outcomes are
indexed in `agent_turns`. The API reads these tables directly, so listing sessions
or retrieving the latest outcome does not start an agent runtime. The console can
browse sessions from other browsers and recover terminal results after event
replay expires. Without a database, local browser history, live streams and runtime
inspection remain available; database routes return 503.

This index stores latest session snapshots and per-request outcomes. It is not a
full transcript database and does not sync Codex's internal logs. Full Codex history
stays in the Workspace. Assistant/tool intermediate events lost after replay expiry
cannot be reconstructed from this index. Turn records currently do not retain all
original prompts. There is no automatic retention policy.

Database session writes are required when configured: a failed write can fail the
turn. Workspace snapshots remain available for repair; turn indexing logs failures
and is best effort. POST `/sessions/reindex` to backfill session snapshots after an
outage. It does not rebuild all historical turn records. For a local workspace,
`npm run db:setup -- /absolute/workspace/path` also backfills snapshots.

## GitHub issue automation

Create a repository webhook pointing to `https://YOUR_APP_URL/webhooks/github`:
use JSON, the configured webhook secret, and **Issues** plus **Issue comments**.
New issues opened by OWNER, MEMBER or COLLABORATOR authors start an issue session.
New non-bot comments from those roles continue an existing issue session; pull
request comments and this agent's marked replies are ignored.

The worker asks Codex to implement, test, commit and push its agent branch, then
posts a summary back to the issue. Each issue has a deterministic session ID.
Receipt files prevent duplicate deliveries from automatically rerunning completed
or ambiguously interrupted side effects. API-created sessions do not post comments.
No automatic pull request creation or merging is implemented.

## Deployment

Choose an app slug in `cantelop.json`, then:

```sh
cantelop login
cantelop app create -slug YOUR_APP_SLUG
cantelop app list
npm run env:upload -- APP_ID
cantelop doctor
npm run build # dry-run build only
cantelop deploy
```

Use the App ID (`app_…`) from the list for environment upload. The script reads
`.env`, uploads only declared settings, sends secrets through stdin and does not
print their values. Blank optional values are skipped; missing required settings
stop the upload. `.env` is not automatically uploaded by deployment.

## Runtime and recovery

Each API session has its own Cantelop actor and durable inbox (up to 100 pending
messages). Actors share one Workspace and run concurrently. Each actor still
orders its own turns. There is no application-wide workspace lock.

Repositories have a shared clone at `repositories/OWNER/REPO`, with separate
working trees at `worktrees/OWNER/REPO/SESSION_ID` on `agent/SESSION_ID` branches.
Follow-ups reuse their worktree, including unfinished edits. New session branches
fetch the remote default HEAD into a session-specific ref. Concurrent initial
clones publish one complete clone and discard redundant temporary clones.
Issue rules are saved per repository to avoid lost updates across repositories.

Agent instructions request commits before finishing. Commits and pushes should
still be checked in GitHub; a successful model turn does not prove a push occurred.

Durable files live under `.agent-api/`: session snapshots, inboxes, receipts, issue
rules, and Codex history under `codex/` (`CODEX_HOME`). A saved `codexThreadId` is
passed to `resumeThread()` on subsequent turns. Processes are ephemeral; these
files persist. Active turns time out after 30 minutes. Queued messages survive
restart and are drained when another work request arrives. Previously running
messages are marked interrupted and are not automatically replayed.

Legacy `.agent-api/workspace.lock` directories are ignored. Stop workers running
the old version before upgrading. If an old session branch is still checked out
in the shared clone, preserve/commit its edits and switch that clone to another
branch before resuming the session; Git otherwise refuses to attach that branch
to a new worktree. No edits are automatically reset or moved. Existing Codex thread
IDs remain usable. Legacy `issue-rules.json` remains a read fallback.

Backfill reads atomic snapshots without rewriting them or blocking agent work.
A sudden process kill can still prevent a final event or database update.

This is a single trusted-operator service. The API token accesses every session,
and repository allowlisting does not isolate shell commands or files. To match
the example's unattended coding behavior, Codex runs with `danger-full-access`
and approval policy `never`; Cantelop provides the outer sandbox. The agent can
access network, GitHub/model credentials and shared files. API, webhook and database
credentials are excluded from the Codex subprocess environment. This is not a
multi-tenant isolation design.

## Changes from the initial scaffold

The API now requires `repository` and `model` on session creation and accepts
`sessionId` in JSON bodies for follow-ups, inspection and cancellation. The old
`.codex-host/` snapshots are not migrated; start new sessions with this version.
`CODEX_MODEL` is replaced by per-session `model` and `GITHUB_ISSUE_MODEL`.

## Development

```sh
npm run check
npm run build
```

Tests cover API authentication, webhook verification, queue/steering/cancellation,
concurrent worktree isolation, SQL persistence/recovery, console behavior, SSE transport and
the actual Codex SDK boundary with a fake CLI. They do not contact live OpenAI or
GitHub services. Docker and authenticated live runs are separate deployment checks.

Sources: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) and the linked
Cantelop example. The app is its own HTTP API, not an OpenAI API-compatible endpoint.
