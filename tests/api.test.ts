import assert from "node:assert/strict";
import { test } from "node:test";
import type { CantelopApp } from "@cantelop/sdk/api";
import api from "../src/api.js";
import type { Command } from "../src/contracts.js";

test("auth gates dispatch and events; follow-ups reuse the requested session", async () => {
  const ids: string[] = [];
  const commands: Command[] = [];
  const app = { sessions: { open({ id }: { id: string }) {
    ids.push(id);
    return { dispatch: async (command: Command) => { commands.push(command); return { id: "msg-1" }; }, events: async () => new Response("events") };
  } } } as unknown as CantelopApp<Command>;
  const router = api.create({ app, env: { API_TOKEN: "test-secret" } });
  const request = (path: string, token = "test-secret", method = "POST") => router.handle(new Request(`https://example.com${path}`, {
    method, headers: { authorization: `Bearer ${token}` }, ...(method === "POST" ? { body: JSON.stringify({ prompt: "hello" }) } : {}),
  }));
  assert.equal((await request("/sessions", "wrong")).status, 401);
  assert.equal((await request("/events?sessionId=one", "wrong", "GET")).status, 401);
  assert.equal(ids.length, 0);
  const created = await request("/sessions");
  assert.equal(created.status, 202);
  const body = await created.json() as { sessionId: string };
  assert.equal((await request(`/sessions/messages?sessionId=${body.sessionId}`)).status, 202);
  assert.deepEqual(ids, [body.sessionId, body.sessionId]);
  assert.deepEqual(commands, [{ type: "run", prompt: "hello" }, { type: "run", prompt: "hello" }]);
  assert.equal((await request("/sessions/messages?sessionId=../escape")).status, 400);
});
