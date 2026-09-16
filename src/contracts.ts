export type Command = { type: "run"; prompt: string } | { type: "inspect" } | { type: "cancel" };
export type Event = { type: string; messageId: string; data: unknown };

export function sessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    throw new TypeError("Invalid sessionId");
  }
  return value;
}

export async function readPrompt(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Missing JSON body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64_000) { await reader.cancel(); throw new RangeError("Body too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || typeof body !== "object" || !("prompt" in body) ||
      typeof body.prompt !== "string" || !body.prompt.trim()) throw new TypeError("Invalid prompt");
  return body.prompt;
}
