import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Thread, ThreadEvent } from "@openai/codex-sdk";
import { inspect, runTurn } from "../src/runner.js";
import { readPrompt, sessionId } from "../src/contracts.js";

test("rejects traversal and oversized requests", async () => {
  assert.throws(() => sessionId("../../escape"));
  await assert.rejects(readPrompt(new Request("http://local", { method: "POST", body: "x".repeat(64001) })), RangeError);
  await assert.rejects(readPrompt(new Request("http://local", { method: "POST", body: '{"prompt":" "}' })), TypeError);
});

test("persists thread before events, resumes it, and records incomplete streams as failed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-host-"));
  let events: ThreadEvent[] = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "Done" } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } },
  ];
  const thread = { runStreamed: async () => ({ events: (async function* () { yield* events; })() }) } satisfies Pick<Thread, "runStreamed">;
  let resumed = false;
  const engine = {
    startThread: () => thread,
    resumeThread: (id: string) => { assert.equal(id, "thread-1"); resumed = true; return thread; },
  };
  const base = { root, id: "session-1", messageId: "message-1", prompt: "test", env: {}, signal: new AbortController().signal, engine,
    emit: async (event: ThreadEvent) => { if (event.type === "thread.started") assert.equal((await inspect(root, "session-1"))?.threadId, "thread-1"); },
  };
  try {
    assert.equal((await runTurn(base)).response, "Done");
    events = [];
    assert.equal((await runTurn({ ...base, messageId: "message-2" })).status, "failed");
    assert.equal(resumed, true);
    assert.equal((await inspect(root, "session-1"))?.messageId, "message-2");
  } finally { await rm(root, { recursive: true, force: true }); }
});
