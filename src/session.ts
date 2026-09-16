import { defineSessionBehaviour } from "@cantelop/sdk/session";
import type { Command, Event } from "./contracts.js";
import { inspect, runTurn } from "./runner.js";

export default defineSessionBehaviour<Command, Event>(async ({ message, session, env, activity, output }) => {
  const root = process.cwd();
  if (message.payload.type === "inspect") {
    await output.send({ type: "session", messageId: message.id, data: { active: activity.active, snapshot: await inspect(root, session.id) } });
    return;
  }
  if (message.payload.type === "cancel") {
    await output.send({ type: "cancellation.requested", messageId: message.id, data: { requested: activity.cancel() } });
    return;
  }
  if (activity.active) {
    await output.send({ type: "busy", messageId: message.id, data: { error: "A turn is already running; retry when it finishes." } });
    return;
  }
  const prompt = message.payload.prompt;
  activity.start(async ({ signal, output: stream }) => {
    const emit = (type: string, data: unknown) => stream.send({ type, messageId: message.id, data });
    try {
      await emit("started", {});
      const state = await runTurn({ root, id: session.id, messageId: message.id, prompt, env, signal,
        emit: event => emit("codex.event", event),
      });
      if (!signal.aborted) await emit(state.status, state);
    } catch {
      if (!signal.aborted) await emit("failed", { error: "Codex worker failed; check runtime configuration." });
    }
  }, { timeoutMs: 30 * 60 * 1000 });
});
