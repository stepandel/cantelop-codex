# Codex on Cantelop

A starter for hosting the Codex coding harness on [Cantelop](https://cantelop.com).
The Edge API dispatches prompts to Cantelop Session actors. Each actor runs the
[Codex TypeScript SDK](https://learn.chatgpt.com/docs/codex-sdk), streams events,
and persists its Codex conversation in the durable Workspace.

## Run locally

Requirements: Node.js 22.12+, npm, Cantelop CLI, Bun, Docker running with Linux
amd64 support, and an OpenAI API key with Codex model access.

```sh
npm ci
cp .env.example .env
# Fill API_TOKEN with a random secret and CODEX_API_KEY with your API key.
npm run check
npm run dev
```

Generate an API token with `openssl rand -hex 32`. `CODEX_MODEL` is optional;
omitting it uses Codex's default. For host-only development, install
`@openai/codex@0.146.1` globally and use `cantelop dev`.

## Send a prompt

Set `API_TOKEN` in your terminal to the same value as `.env` (the file is not
automatically exported into other terminals).

```sh
export BASE_URL=http://localhost:8787
curl -fsS "$BASE_URL/health"
curl -fsS "$BASE_URL/sessions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Create a hello-world Python script and run it."}'
```

The response contains `sessionId`, `messageId`, and an `events` URL. Set
`SESSION_ID` to the returned ID and subscribe:

```sh
curl -N "$BASE_URL/events?sessionId=$SESSION_ID" \
  -H "Authorization: Bearer $API_TOKEN"
```

Events use Cantelop's streaming envelope. Application events include `started`,
`codex.event`, `completed`, `failed`, `busy`, `session`, and
`cancellation.requested`. Match application `messageId` to the dispatch response;
HTTP 202 confirms dispatch only. The session stream stays open across turns.
Reconnect using `Last-Event-ID` within Cantelop's replay retention window.

Continue the same conversation:

```sh
curl -fsS "$BASE_URL/sessions/messages?sessionId=$SESSION_ID" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Add a test for the script."}'
```

POST `/sessions/inspect?sessionId=…` or `/sessions/cancel?sessionId=…` with the
same authorization header. These return dispatch IDs; read their results from
the event stream. Inspection reports the latest saved turn plus current activity.
Cancellation requests abort the SDK subprocess; inspection supplies its persisted
outcome after cleanup. A disconnected stream does not cancel a turn.

## Deploy

Choose your app slug in `cantelop.json`, then create that app:

```sh
cantelop login
cantelop app create -slug YOUR_APP_SLUG
cantelop app list
```

Configure `API_TOKEN` and `CODEX_API_KEY` as secrets on that Cantelop App, and
optionally set `CODEX_MODEL` and `WORKSPACE_SLUG`. Use the Cantelop console or
`cantelop app secret set --help` / `cantelop app env set --help` for CLI syntax.
Local `.env` values are not automatically uploaded by this workflow.

```sh
cantelop doctor
npm run build # local build validation; does not deploy
cantelop deploy
```

Repeat the API example with the deployed URL. Container and live model execution
must be verified in your Cantelop environment; unit tests use a fake model engine.

## Design and scope

- `src/api.ts`: bearer authentication, bounded input, dispatch, event proxy.
- `src/session.ts`: one activity per actor, cancellation and inspection.
- `src/runner.ts`: Codex process, streaming, atomic state writes and thread resume.
- `sessions/SESSION_ID/`: persistent agent working directory, initially empty.
- `.codex-host/SESSION_ID/`: saved state and `CODEX_HOME`, including thread logs.
- `docker/Dockerfile`: pinned Codex CLI and basic coding tools.

The SDK and CLI are pinned to 0.146.1, matching the existing local Cantelop Codex
example. Keep these versions in sync when upgrading. This scaffold uses the SDK
for unattended turns. A rich interactive client with approval prompts would use
[Codex app-server](https://learn.chatgpt.com/docs/app-server) instead.

This is a single-operator starter: the API token accesses all sessions. Actors
have separate directories but share a Workspace; directories are not tenant
isolation. Agent tools use workspace-write permissions, network disabled, and
approval policy `never` (requests requiring approval are denied). API credentials
are excluded from the child environment; Codex receives its model credential.
Raw Codex events may include command output and workspace contents.

Overlapping prompts emit `busy` and are not queued. Turns time out after 30
minutes. Saved thread IDs support follow-ups after restart, but interrupted turns
are not automatically replayed. After an abrupt process death a snapshot can
remain `running` while inspection reports `active: false`; inspect the work before
sending a follow-up. There is no exactly-once execution guarantee or request
deduplication. This starter has no repository checkout, UI, session index, or
interactive approval endpoint yet.
