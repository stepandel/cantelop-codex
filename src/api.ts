import { defineApi } from "@cantelop/sdk/api";
import { readPrompt, sessionId, type Command } from "./contracts.js";

export default defineApi<Command>(({ app, env, router }) => {
  const worker = (id: string) => app.sessions.open({ id, workspaceSlug: env.WORKSPACE_SLUG || "codex", keepAliveSeconds: 300 });
  router.route("GET", "/health", () => Response.json({ status: "ok" }));
  function route(method: "GET" | "POST", path: string, handler: (request: Request) => Promise<Response>) {
    router.route(method, path, async ({ request }) => {
      if (!env.API_TOKEN || request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try { return await handler(request); }
      catch (error) {
        const status = error instanceof RangeError ? 413 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 503;
        return Response.json({ error: status === 503 ? "Service unavailable" : "Invalid request" }, { status });
      }
    });
  }
  async function dispatch(id: string, command: Command) {
    const message = await worker(id).dispatch(command);
    return Response.json({ sessionId: id, messageId: message.id, events: `/events?sessionId=${id}` }, { status: 202 });
  }
  route("POST", "/sessions", async request => dispatch(crypto.randomUUID(), { type: "run", prompt: await readPrompt(request) }));
  route("POST", "/sessions/messages", async request => {
    const id = sessionId(new URL(request.url).searchParams.get("sessionId"));
    return dispatch(id, { type: "run", prompt: await readPrompt(request) });
  });
  for (const type of ["inspect", "cancel"] as const) {
    route("POST", `/sessions/${type}`, async request => dispatch(sessionId(new URL(request.url).searchParams.get("sessionId")), { type }));
  }
  route("GET", "/events", request => worker(sessionId(new URL(request.url).searchParams.get("sessionId"))).events(request));
});
