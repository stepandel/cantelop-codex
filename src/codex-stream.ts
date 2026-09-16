import type { ThreadEvent } from "@openai/codex-sdk";
import type { Progress } from "./contracts.js";

/** Translate SDK snapshots into the console's progress protocol without raw tool data. */
export class CodexProgress {
  private readonly text = new Map<string, string>();
  private readonly tools = new Map<string, string>();
  accept(event: ThreadEvent): Progress[] {
    if (event.type === "turn.started") return [{ type: "status", data: { phase: "codex_busy" } }];
    if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return [];
    const item = event.item;
    if (item.type === "agent_message") {
      const previous = this.text.get(item.id) ?? "";
      this.text.set(item.id, item.text);
      if (previous === item.text) return [];
      return [{ type: item.text.startsWith(previous) ? "text.delta" : "text.replace",
        data: { partId: item.id, text: item.text.startsWith(previous) ? item.text.slice(previous.length) : item.text } }];
    }
    if (item.type === "reasoning") return [{ type: "status", data: { phase: "codex_reasoning" } }];
    if (!["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) return [];
    const status = "status" in item ? item.status === "in_progress" ? "running" : item.status === "failed" ? "error" : item.status
      : event.type === "item.completed" ? "completed" : "running";
    if (this.tools.get(item.id) === status) return [];
    this.tools.set(item.id, status);
    return [{ type: "tool.status", data: { partId: item.id, tool: item.type, status } }];
  }
}
