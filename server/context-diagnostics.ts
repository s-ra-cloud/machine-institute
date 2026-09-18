/**
 * Safe context-size diagnostics. Values are serialized UTF-8 byte estimates;
 * no request text, tool arguments, identifiers, or other potentially sensitive
 * content is included in the result.
 */
type DiagnosticRequest = {
  messages?: Array<Record<string, any>>;
  tools?: unknown[];
  [key: string]: unknown;
};

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function toolNameForResult(messages: Array<Record<string, any>>, result: Record<string, any>): string {
  const id = result.tool_call_id;
  if (typeof id !== "string") return "";
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    const call = message.tool_calls.find((candidate: any) => candidate?.id === id);
    if (call) return String(call?.function?.name ?? "");
  }
  return "";
}

export function describeToolContext(request: DiagnosticRequest, state?: string): string {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const stateIndex = state === undefined ? -1 : messages.reduce((found, message, index) =>
    message.role === "user" && message.content === state ? index : found, -1);
  const sizes = {
    instructions: 0,
    schemas: bytes(request?.tools ?? []),
    state: 0,
    repair: 0,
    assistant: 0,
    evidence: 0,
    retrieval: 0,
    other: 0,
    protocol: 0,
    total: bytes(request),
  };

  messages.forEach((message, index) => {
    const size = bytes(message);
    if (message.role === "system") sizes.instructions += size;
    else if (index === stateIndex) {
      sizes.state += size;
    } else if (message.role === "assistant") sizes.assistant += size;
    else if (message.role === "tool") {
      if (/read_(?:tool_result|reproduction_context)/i.test(toolNameForResult(messages, message))) {
        sizes.retrieval += size;
      } else {
        sizes.evidence += size;
      }
    } else if (
      message.role === "user"
      && index > 0
      && /continue|repair|unfinished|recover|logbook|stop:/i.test(String(message.content ?? ""))
    ) {
      sizes.repair += size;
    } else {
      sizes.other += size;
    }
  });

  const categorized = sizes.instructions + sizes.schemas + sizes.state + sizes.repair
    + sizes.assistant + sizes.evidence + sizes.retrieval + sizes.other;
  sizes.protocol = Math.max(0, sizes.total - categorized);
  return Object.entries(sizes).map(([key, value]) => `${key}=${value}`).join(",");
}