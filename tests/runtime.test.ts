import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent, AgentError, git, CommandError, gitFailureReason } from "../src/runtime.js";

test("Git failures report operation, exit status and category without arguments or stderr", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "git-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "git"), '#!/bin/sh\necho "fatal: secret-token already checked out at private-path" >&2\nexit 128\n', { mode: 0o700 });
  await assert.rejects(git(root, ["worktree", "add", "private-path", "private-branch"], { PATH: root }, AbortSignal.timeout(5000)), error => {
    assert.ok(error instanceof CommandError);
    assert.deepEqual(error.diagnostic, { code: "command_failed", phase: "checkout", operation: "git_worktree", exitCode: 128, signal: null, reason: "branch_in_use" });
    assert.doesNotMatch(JSON.stringify(error), /secret-token|private-path|private-branch/);
    return true;
  });
  await assert.rejects(git(root, ["status"], { PATH: path.join(root, "missing") }, AbortSignal.timeout(5000)), error => {
    assert.ok(error instanceof CommandError);
    assert.equal(error.diagnostic.reason, "spawn_failed");
    return true;
  });
});

test("Git stderr classifications cover actionable checkout failures", () => {
  for (const [message, reason] of [
    ["Your local changes would be overwritten", "uncommitted_changes"],
    ["Unable to create '/private/index.lock': File exists", "git_locked"],
    ["Authentication failed for https://secret@github.com/private", "git_auth"],
    ["Could not resolve host: github.com", "git_network"],
    ["invalid reference: origin/HEAD", "invalid_git_state"],
    ["unknown private error", "git_failed"],
  ]) assert.equal(gitFailureReason(message!), reason);
});


// Exercise the actual Codex SDK/CLI JSONL boundary without contacting a model.
for (const scenario of ["success", "failure", "incomplete", "cancel"] as const) {
  test(`Codex subprocess handles ${scenario} with durable resume and safe events`, async t => {
    const { readFile } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "codex-protocol-"));
    const previousBinary = process.env.CODEX_BINARY;
    t.after(async () => {
      if (previousBinary === undefined) delete process.env.CODEX_BINARY; else process.env.CODEX_BINARY = previousBinary;
      await rm(root, { recursive: true, force: true });
    });
    const executable = path.join(root, "codex");
    process.env.CODEX_BINARY = executable;
    const trace = path.join(root, "trace.json");
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({args:process.argv.slice(2),input,home:process.env.CODEX_HOME}));
  console.log(JSON.stringify({type:'thread.started',thread_id:'codex-thread'}));
  if (${JSON.stringify(scenario)} === 'cancel') { setInterval(() => {}, 1000); return; }
  if (${JSON.stringify(scenario)} === 'failure') { console.log(JSON.stringify({type:'turn.failed',error:{message:'401 private-prompt secret-token'}})); return; }
  console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Done'}}));
  if (${JSON.stringify(scenario)} === 'success') console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
});
`, { mode: 0o700 });
    const controller = new AbortController();
    let created = false;
    const options = { root, directory: root, env: { PATH: process.env.PATH!, HOME: root, CODEX_HOME: path.join(root, "codex-home"), CODEX_API_KEY: "test-key" },
      model: "chosen-model", prompt: "private-prompt", signal: controller.signal,
      onCreated: async (id: string) => { assert.equal(id, "codex-thread"); created = true; if (scenario === "cancel") controller.abort(); },
    };
    if (scenario === "success") {
      assert.equal(await runAgent(options), "Done");
      assert.equal(await runAgent({ ...options, id: "codex-thread" }), "Done");
      const recorded = JSON.parse(await readFile(trace, "utf8"));
      assert.ok(recorded.args.includes("resume"));
      assert.ok(recorded.args.includes("codex-thread"));
      assert.ok(recorded.args.includes("chosen-model"));
      assert.equal(recorded.home, options.env.CODEX_HOME);
      assert.match(recorded.input, /commit your changes/);
    } else {
      await assert.rejects(runAgent(options), error => {
        assert.ok(error instanceof AgentError);
        assert.equal(error.diagnostic.code, scenario === "cancel" ? "turn_cancelled" : "codex_failed");
        if (scenario === "failure") assert.equal(error.diagnostic.reason, "provider_auth");
        if (scenario === "incomplete") assert.equal(error.diagnostic.reason, "incomplete_stream");
        assert.doesNotMatch(JSON.stringify(error), /private-prompt|secret-token/);
        return true;
      });
    }
    assert.equal(created, true);
  });
}
