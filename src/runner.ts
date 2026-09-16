import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Codex, type ThreadEvent, type Thread } from "@openai/codex-sdk";
import { sessionId } from "./contracts.js";

type Engine = {
  startThread: (...args: Parameters<Codex["startThread"]>) => Pick<Thread, "runStreamed">;
  resumeThread: (...args: Parameters<Codex["resumeThread"]>) => Pick<Thread, "runStreamed">;
};
export type Snapshot = { threadId?: string; messageId: string; status: "running" | "completed" | "failed" | "cancelled"; response?: string };
export function statePath(root: string, id: string) { return path.join(root, ".codex-host", sessionId(id), "state.json"); }
export async function inspect(root: string, id: string): Promise<Snapshot | null> {
  try { return JSON.parse(await readFile(statePath(root, id), "utf8")) as Snapshot; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function save(root: string, id: string, state: Snapshot) {
  const file = statePath(root, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

export async function runTurn(options: {
  root: string; id: string; messageId: string; prompt: string;
  env: Readonly<Record<string, string | undefined>>; signal: AbortSignal;
  emit: (event: ThreadEvent) => Promise<void>; engine?: Engine;
}): Promise<Snapshot> {
  const { root, id, messageId, prompt, env, signal, emit } = options;
  const directory = path.join(root, "sessions", sessionId(id));
  const codexHome = path.join(root, ".codex-host", id, "codex");
  await mkdir(directory, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  if (!options.engine && !env.CODEX_API_KEY) throw new Error("CODEX_API_KEY required");
  const engine = options.engine ?? new Codex({
    apiKey: env.CODEX_API_KEY,
    codexPathOverride: process.env.CODEX_BINARY || "codex",
    // Do not inherit API_TOKEN or other service credentials into agent commands.
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? root, CODEX_HOME: codexHome },
  });
  const previous = await inspect(root, id);
  const threadOptions = {
    workingDirectory: directory, skipGitRepoCheck: true,
    sandboxMode: "workspace-write" as const, approvalPolicy: "never" as const,
    networkAccessEnabled: false, ...(env.CODEX_MODEL ? { model: env.CODEX_MODEL } : {}),
  };
  const thread = previous?.threadId ? engine.resumeThread(previous.threadId, threadOptions) : engine.startThread(threadOptions);
  const state: Snapshot = { threadId: previous?.threadId, messageId, status: "running" };
  await save(root, id, state);
  try {
    const stream = await thread.runStreamed(prompt, { signal });
    let completed = false;
    for await (const event of stream.events) {
      if (event.type === "thread.started") {
        state.threadId = event.thread_id;
        await save(root, id, state);
      }
      if (event.type === "item.completed" && event.item.type === "agent_message") state.response = event.item.text;
      if (event.type === "turn.completed") completed = true;
      if (event.type === "turn.failed" || event.type === "error") throw new Error("Codex turn failed");
      await emit(event);
    }
    if (!completed) throw new Error("Codex stream ended without completion");
    state.status = "completed";
  } catch {
    state.status = signal.aborted ? "cancelled" : "failed";
  }
  await save(root, id, state);
  return state;
}
