import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handle, type Dependencies } from "../src/worker.js";
import { agentEnvironment, checkout, git, CommandError } from "../src/runtime.js";
import type { Command } from "../src/contracts.js";
const env = { GITHUB_TOKEN: "test-only", CODEX_API_KEY: "test-openai", GITHUB_REPOSITORIES: "owner/repo" };
const model = "gpt-5.6-terra";
test("issue comment follow-ups retain conversation and deduplicate by comment identity", async t => {
  const h = await harness(t);
  const { issueReplyMarker, issueSessionId } = await import("../src/contracts.js");
  const comment: Command = { type: "issue_comment", deliveryId: "d1", repository: "owner/repo", number: 9, commentId: 123, body: "proceed", association: "OWNER" };
  assert.equal((await h.run(comment, "missing")).type, "ignored");
  assert.equal(h.runs.length, 0);
  await h.run({ type: "rule", repository: "owner/repo", model }, "rule");
  await h.run({ type: "issue", deliveryId: "opened", issue: { repository: "owner/repo", number: 9, title: "Fix", body: "Fix", association: "OWNER" } }, "initial");
  await h.run({ type: "rule", repository: "owner/repo", model: "different/model" }, "rule2");
  const result = await h.run(comment, "followup");
  assert.equal(result.type, "completed");
  assert.equal(result.sessionId, await issueSessionId("owner/repo", 9));
  assert.equal(h.runs[1]?.id, "codex-1");
  assert.equal(h.runs[1]?.model, model);
  assert.match(h.runs[1]!.prompt, /proceed/);
  assert.match(String((h.comments[1] as unknown[])[2]), /cantelop-agent-reply/);
  await h.run({ ...comment, deliveryId: "redelivery" }, "duplicate");
  assert.equal(h.runs.length, 2);
  assert.equal(h.comments.length, 2);
  for (const ignored of [{ ...comment, commentId: 124, association: "NONE" }, { ...comment, commentId: 125, body: issueReplyMarker }]) {
    assert.equal((await h.run(ignored, `ignored-${ignored.commentId}`)).type, "ignored");
  }
  h.deps.runAgent = async () => { throw new Error("private provider failure"); };
  const failure = { ...comment, commentId: 126 };
  assert.equal((await h.run(failure, "failure")).type, "failed");
  h.deps.runAgent = async () => { assert.fail("failed comment must not replay"); };
  assert.equal((await h.run({ ...failure, deliveryId: "retry" }, "failure-repeat")).type, "failed");
  assert.equal(h.comments.length, 2);
});
async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantelop-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs: Parameters<Dependencies["runAgent"]>[0][] = [];
  const comments: unknown[] = [];
  const deps: Dependencies = {
    async checkout() { return root; },
    async runAgent(options) { runs.push(options); if (!options.id) await options.onCreated("codex-1"); return "Done"; },
    async comment(...args) { comments.push(args); },
  };
  return { root, deps, runs, comments, run: (command: Command, id: string) => handle(root, command, id, env, new AbortController().signal, deps) };
}
test("persists selected model and Codex conversation across follow-ups", async t => {
  const h = await harness(t);
  await h.run({ type: "create", spec: { sessionId: "one", model, repository: "owner/repo", prompt: "Start" } }, "m1");
  await h.run({ type: "prompt", sessionId: "one", prompt: "Continue" }, "m2");
  assert.equal(h.runs.length, 2);
  assert.deepEqual(h.runs[1]?.model, model);
  assert.equal(h.runs[1]?.id, "codex-1");
  const status = await h.run({ type: "inspect", sessionId: "one" }, "m3");
  assert.equal((status.data as { status: string }).status, "completed");
});
test("issue model comes from API rule; redeliveries cannot rerun or repost", async t => {
  const h = await harness(t);
  const issue: Command = { type: "issue", deliveryId: "d1", issue: { repository: "owner/repo", number: 7, title: "Bug", body: "Fix", association: "OWNER" } };
  assert.equal((await h.run(issue, "m1")).type, "ignored");
  await h.run({ type: "rule", repository: "owner/repo", model }, "m2");
  assert.equal((await h.run(issue, "m3")).type, "completed");
  await h.run({ ...issue, deliveryId: "d2" }, "m4");
  assert.equal(h.runs.length, 1);
  assert.equal(h.comments.length, 1);
  assert.deepEqual(h.runs[0]?.model, model);
});
test("failed side effects are not automatically replayed", async t => {
  const h = await harness(t);
  h.deps.runAgent = async () => { throw new Error("secret provider error"); };
  const command: Command = { type: "create", spec: { sessionId: "failed", repository: "owner/repo", model, prompt: "Start" } };
  const failed = await h.run(command, "m1");
  assert.equal(failed.type, "failed");
  assert.equal(JSON.stringify(failed).includes("secret provider error"), false);
  h.deps.runAgent = async () => { assert.fail("must not rerun"); };
  assert.equal((await h.run(command, "m1")).type, "failed");
});
test("checkout diagnostics survive persistence and follow-up failure events", async t => {
  const h = await harness(t);
  await h.run({ type: "create", spec: { sessionId: "diagnostic", repository: "owner/repo", model, prompt: "Start" } }, "m1");
  const diagnostic = { code: "command_failed", phase: "checkout", operation: "git_worktree", exitCode: 128, reason: "branch_in_use" } as const;
  h.deps.checkout = async () => { throw new CommandError(diagnostic); };
  const result = await h.run({ type: "prompt", sessionId: "diagnostic", prompt: "Retry" }, "m2");
  assert.equal(result.type, "failed");
  assert.deepEqual((result.data as { diagnostic: unknown }).diagnostic, diagnostic);
  assert.match((result.data as { error: string }).error, /already checked out/);
  const saved = await h.run({ type: "inspect", sessionId: "diagnostic" }, "m3");
  assert.deepEqual((saved.data as { diagnostic: unknown }).diagnostic, diagnostic);
  assert.equal(h.runs.length, 1);
});
test("unclassified failures identify the worker phase without exposing exception text", async t => {
  const h = await harness(t);
  h.deps.checkout = async () => { throw new Error("private filesystem error"); };
  const result = await h.run({ type: "create", spec: { sessionId: "phase", repository: "owner/repo", model, prompt: "Start" } }, "m1");
  assert.deepEqual((result.data as { diagnostic: unknown }).diagnostic, { code: "command_failed", phase: "checkout" });
  assert.doesNotMatch(JSON.stringify(result), /private filesystem/);
});
test("API and webhook secrets are absent from agent subprocess environment", () => {
  const actual = agentEnvironment("/workspace", { ...env, SESSION_DATABASE_AUTH_TOKEN: "private-db", SESSION_DATABASE_URL: "https://private-db.example", API_TOKEN: "private-api", GITHUB_WEBHOOK_SECRET: "private-webhook", ANTHROPIC_API_KEY: "unused", OPENAI_API_KEY: "unused" });
  assert.equal(actual.SESSION_DATABASE_AUTH_TOKEN, undefined);
  assert.equal(actual.SESSION_DATABASE_URL, undefined);
  assert.equal(actual.API_TOKEN, undefined);
  assert.equal(actual.GITHUB_WEBHOOK_SECRET, undefined);
  assert.equal(actual.ANTHROPIC_API_KEY, undefined);
  assert.equal(actual.OPENAI_API_KEY, undefined);
  assert.equal(actual.CODEX_API_KEY, "test-openai");
  assert.equal(actual.CODEX_HOME, "/workspace/.agent-api/codex");
  assert.equal(actual.XDG_DATA_HOME, undefined);
  assert.equal(actual.XDG_CONFIG_HOME, undefined);
});
test("OpenAI key is required even when another provider key exists", () => {
  assert.throws(() => agentEnvironment("/workspace", { GITHUB_TOKEN: "test", OPENAI_API_KEY: "unused" }), /OpenAI credentials/);
});

test("inspection remains available during work; cancellation persists failure", async t => {
  const h = await harness(t);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  h.deps.runAgent = async ({ signal }) => {
    started();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return "unreachable";
  };
  const command: Command = { type: "create", spec: { sessionId: "cancel", repository: "owner/repo", model, prompt: "start" } };
  const pending = handle(h.root, command, "cancel-1", env, controller.signal, h.deps);
  await ready;
  const live = await handle(h.root, { type: "inspect", sessionId: "cancel" }, "inspect-live", env, AbortSignal.timeout(500), h.deps);
  assert.equal((live.data as { status: string }).status, "running");
  controller.abort();
  assert.equal((await pending).type, "failed");
  const failed = await h.run({ type: "inspect", sessionId: "cancel" }, "inspect-failed");
  assert.equal((failed.data as { diagnostic: { code: string } }).diagnostic.code, "turn_cancelled");
  h.deps.runAgent = async () => "Recovered";
  assert.equal((await h.run({ type: "prompt", sessionId: "cancel", prompt: "continue" }, "cancel-2")).type, "completed");
  const recovered = await h.run({ type: "inspect", sessionId: "cancel" }, "inspect-recovered");
  assert.equal((recovered.data as { diagnostic?: unknown }).diagnostic, undefined);
});

for (const override of [false, true]) {
  test(`issue uses ${override ? "repository override" : "default model"} and preserves it for follow-ups`, async t => {
    const h = await harness(t);
    const fallback = "gpt-5.6-sol";
    if (override) await h.run({ type: "rule", repository: "owner/repo", model }, "rule");
    const issue: Command = { type: "issue", deliveryId: "default-delivery", issue: { repository: "owner/repo", number: 8, title: "Bug", body: "Fix", association: "OWNER" } };
    const result = await handle(h.root, issue, "issue", { ...env, GITHUB_ISSUE_MODEL: fallback }, new AbortController().signal, h.deps);
    assert.equal(result.type, "completed");
    assert.equal(h.runs[0]?.model, override ? model : fallback);
    await h.run({ type: "prompt", sessionId: result.sessionId!, prompt: "Continue" }, "follow-up");
    assert.equal(h.runs[1]?.model, override ? model : fallback);
  });
}

test("model failure gives actionable UI feedback and persists safe diagnostics", async t => {
  const h = await harness(t);
  const { AgentError } = await import("../src/runtime.js");
  h.deps.runAgent = async () => { throw new AgentError({ code: "codex_failed", phase: "prompt", reason: "model_not_found" }); };
  const result = await h.run({ type: "create", spec: { sessionId: "bad-model", repository: "owner/repo", model: "unavailable-model", prompt: "Hello" } }, "bad-model-1");
  assert.equal(result.type, "failed");
  assert.match((result.data as { error: string }).error, /Start a new session.*model ID/);
  const stored = await h.run({ type: "inspect", sessionId: "bad-model" }, "inspect-1");
  assert.equal((stored.data as { diagnostic: { reason: string } }).diagnostic.reason, "model_not_found");
});

test("steering preserves the previous task, model and conversation", async t => {
  const h = await harness(t);
  await h.run({ type: "create", spec: { sessionId: "one", model, repository: "owner/repo", prompt: "Fix the API" } }, "m1");
  await h.run({ type: "prompt", sessionId: "one", prompt: "Start with tests", mode: "steer" }, "m2");
  assert.equal(h.runs[1]?.id, "codex-1");
  assert.equal(h.runs[1]?.model, model);
  assert.match(h.runs[1]!.prompt, /Fix the API/);
  assert.match(h.runs[1]!.prompt, /takes precedence\):\nStart with tests/);
  const stored = await h.run({ type: "inspect", sessionId: "one" }, "m3");
  assert.equal((stored.data as { requestPrompt: string }).requestPrompt, "Start with tests");
});

test("webhook and API turns persist stream identity and tool summaries", async t => {
  const h = await harness(t);
  h.deps.runAgent = async options => {
    for (const status of ["running", "completed"]) await options.onProgress?.({
      type: "tool.status", data: { partId: "tool-1", tool: "command_execution", status, input: "not persisted" },
    });
    return "Done";
  };
  await h.run({ type: "rule", repository: "owner/repo", model }, "rule");
  const commands: Command[] = [
    { type: "create", spec: { sessionId: "api-tools", repository: "owner/repo", model, prompt: "Start" } },
    { type: "issue", deliveryId: "delivery", issue: { repository: "owner/repo", number: 99, title: "Fix", body: "", association: "OWNER" } },
  ];
  for (const [i, command] of commands.entries()) {
    const result = await h.run(command, `message-${i}`);
    const snapshot = (await h.run({ type: "inspect", sessionId: result.sessionId! }, "inspect")).data as import("../src/session-db.js").StoredSession;
    assert.equal(snapshot.messageId, `message-${i}`);
    assert.deepEqual(snapshot.tools, [{ partId: "tool-1", tool: "command_execution", status: "completed" }]);
    await h.run({ type: "prompt", sessionId: result.sessionId!, prompt: "Continue" }, `followup-${i}`);
    const next = (await h.run({ type: "inspect", sessionId: result.sessionId! }, "inspect")).data as import("../src/session-db.js").StoredSession;
    assert.equal(next.messageId, `followup-${i}`);
    assert.equal(next.tools?.length, 1);
  }
});

test("runtime status and tool activity are inspectable before the turn finishes", async t => {
  const h = await harness(t);
  h.deps.runAgent = async options => {
    await options.onProgress!({ type: "status", data: { phase: "codex_busy" } });
    await options.onProgress!({ type: "tool.status", data: { partId: "p", tool: "command_execution", status: "running" } });
    const result = await h.run({ type: "inspect", sessionId: "live" }, "inspect");
    const stored = result.data as any;
    assert.equal(stored.status, "running");
    assert.deepEqual(stored.runtimeStatus, { phase: "codex_busy" });
    assert.equal(stored.tools[0].status, "running");
    assert.ok(stored.lastProgressAt);
    return "Done";
  };
  await h.run({ type: "create", spec: { sessionId: "live", model, repository: "owner/repo", prompt: "Start" } }, "m1");
});

test("sessions run concurrently even when a legacy workspace lock exists", async t => {
  const h = await harness(t);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(h.root, ".agent-api", "workspace.lock"), { recursive: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  h.deps.runAgent = async options => { if (options.prompt === "hold") { started(); await gate; } return "done"; };
  const first = h.run({ type: "create", spec: { sessionId: "one", repository: "owner/repo", model, prompt: "hold" } }, "parallel-1");
  await ready;
  try {
    const second = await handle(h.root, { type: "create", spec: { sessionId: "two", repository: "owner/repo", model, prompt: "second" } }, "parallel-2", env, AbortSignal.timeout(1000), h.deps);
    assert.equal(second.type, "completed");
  } finally { release(); await first; }
});

test("concurrent issue rule updates for different repositories are preserved", async t => {
  const h = await harness(t);
  const { readJSON } = await import("../src/runtime.js");
  const rulesEnv = { ...env, GITHUB_REPOSITORIES: "owner/one,owner/two" };
  await Promise.all(["one", "two"].map(repo => handle(h.root,
    { type: "rule", repository: `owner/${repo}`, model: `model-${repo}` }, repo, rulesEnv, new AbortController().signal, h.deps)));
  for (const repo of ["one", "two"]) assert.equal(await readJSON(path.join(h.root, ".agent-api", "issue-rules", "owner", `${repo}.json`)), `model-${repo}`);
});

test("concurrent initial checkouts publish one clone and preserve independent worktrees", async t => {
  const h = await harness(t);
  const { mkdir, writeFile, readFile, readdir } = await import("node:fs/promises");
  const remote = path.join(h.root, "origin");
  await mkdir(remote);
  const gitEnv = agentEnvironment(h.root, env);
  const signal = AbortSignal.timeout(15000);
  await git(remote, ["init", "-b", "main"], gitEnv, signal);
  await writeFile(path.join(remote, "file.txt"), "base");
  await git(remote, ["add", "."], gitEnv, signal);
  await git(remote, ["commit", "-m", "initial"], gitEnv, signal);
  const cloneEnv = { ...gitEnv, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_1: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_1: "https://github.com/owner/repo.git" };
  const [one, two] = await Promise.all(["one", "two"].map(id => checkout(h.root, "owner/repo", id, cloneEnv, signal)));
  assert.notEqual(one, two);
  assert.equal(await git(one!, ["branch", "--show-current"], gitEnv, signal), "agent/one");
  assert.equal(await git(two!, ["branch", "--show-current"], gitEnv, signal), "agent/two");
  await writeFile(path.join(one!, "file.txt"), "unfinished session one");
  assert.equal(await readFile(path.join(two!, "file.txt"), "utf8"), "base");
  assert.equal(await checkout(h.root, "owner/repo", "one", cloneEnv, signal), one);
  assert.equal(await readFile(path.join(one!, "file.txt"), "utf8"), "unfinished session one");
  assert.deepEqual(await readdir(path.join(h.root, "repositories", "owner")), ["repo"]);
});

test("legacy aggregate issue rules are ignored and only marked replies are filtered", async t => {
  const h = await harness(t);
  const { saveJSON } = await import("../src/runtime.js");
  const { isAgentReply, issueReplyMarker } = await import("../src/contracts.js");
  await saveJSON(path.join(h.root, ".agent-api", "issue-rules.json"), { "owner/repo": model });
  const result = await h.run({ type: "issue", deliveryId: "legacy-rule", issue: { repository: "owner/repo", number: 101, title: "Fix", body: "Fix", association: "OWNER" } }, "legacy-rule");
  assert.equal(result.type, "ignored");
  assert.equal(h.runs.length, 0);
  assert.equal(isAgentReply("Cantelop session `example`\nOrdinary comment"), false);
  assert.equal(isAgentReply(`${issueReplyMarker}\nAgent reply`), true);
});
