import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readSSE } from "../src/sse.js";
import { turnStream } from "../src/turn-stream.js";
const encode = new TextEncoder();

test("SSE decoding handles split UTF-8, CRLF and multiline data", async () => {
  const bytes = encode.encode('id: cursor:1\r\nevent: text.delta\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\n');
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const frames = [];
  for await (const frame of readSSE(body)) frames.push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.id, "cursor:1");
  assert.deepEqual(JSON.parse(frames[0]!.data), { text: "你好" });
});

test("turn stream filters other requests, strips transport metadata and closes upstream on terminal", async () => {
  let cancelled = false;
  const frame = (messageId: string, type: string, n: number) => encode.encode(`id: cursor:${n}\ndata: ${JSON.stringify({ message_id: "activity-owner", source_sandbox_id: "private-sandbox", data: { type, messageId, data: { text: "hello" } } })}\n\n`);
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(frame("other", "completed", 1)); c.enqueue(frame("wanted", "queued", 2)); c.enqueue(frame("wanted", "text.delta", 2)); c.enqueue(frame("wanted", "completed", 3)); }, cancel() { cancelled = true; } });
  const response = turnStream(new Response(source), "wanted");
  const output = await response.text();
  assert.match(output, /event: queued/);
  assert.match(output, /event: text.delta/);
  assert.match(output, /id: cursor:3\nevent: completed/);
  assert.doesNotMatch(output, /private-sandbox|other|source_sandbox_id/);
  assert.equal(cancelled, true);
});

test("disconnect cancels a pending upstream read", async () => {
  let cancelled = false;
  const response = turnStream(new Response(new ReadableStream({ cancel() { cancelled = true; } })), "wanted");
  const reader = response.body!.getReader();
  const pending = reader.read();
  await delay(5);
  await reader.cancel();
  await pending;
  assert.equal(cancelled, true);
});

test("cancelled is a terminal turn event", async () => {
  let cancelled = false;
  const data = JSON.stringify({ message_id: "owner", data: { type: "cancelled", messageId: "wanted", data: { cancelled: true } } });
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode.encode(`id: 1\ndata: ${data}\n\n`)); }, cancel() { cancelled = true; } });
  const output = await turnStream(new Response(source), "wanted").text();
  assert.match(output, /event: cancelled/);
  assert.equal(cancelled, true);
});


test("Codex progress deduplicates snapshots and excludes tool payloads and reasoning", async () => {
  const { CodexProgress } = await import("../src/codex-stream.js");
  const map = new CodexProgress();
  const text = (value: string) => map.accept({ type: "item.updated", item: { type: "agent_message", id: "a", text: value } });
  assert.deepEqual(text("Hello"), [{ type: "text.delta", data: { partId: "a", text: "Hello" } }]);
  assert.deepEqual(text("Hello"), []);
  assert.deepEqual(text("Hello world"), [{ type: "text.delta", data: { partId: "a", text: " world" } }]);
  assert.deepEqual(text("Correction"), [{ type: "text.replace", data: { partId: "a", text: "Correction" } }]);
  const tool = map.accept({ type: "item.completed", item: { id: "tool", type: "command_execution", command: "secret command", aggregated_output: "private output", status: "completed" } });
  assert.deepEqual(tool, [{ type: "tool.status", data: { partId: "tool", tool: "command_execution", status: "completed" } }]);
  const reasoning = map.accept({ type: "item.updated", item: { id: "r", type: "reasoning", text: "private reasoning" } });
  assert.deepEqual(reasoning, [{ type: "status", data: { phase: "codex_reasoning" } }]);
});
