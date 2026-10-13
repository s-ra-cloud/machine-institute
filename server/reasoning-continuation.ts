/** Opaque transport state only. Never render, archive, or use as scientific evidence. */
export function reasoningContinuation(message: any): Record<string, unknown> {
  if (Array.isArray(message?.reasoning_details) && message.reasoning_details.length)
    return { reasoning_details: message.reasoning_details };
  if (typeof message?.reasoning === "string") return { reasoning: message.reasoning };
  if (typeof message?.reasoning_content === "string") return { reasoning_content: message.reasoning_content };
  return {};
}

export function hasReasoningContinuation(message: any): boolean {
  return Object.keys(reasoningContinuation(message)).length > 0;
}

export function isDeepSeekV4(model: string): boolean {
  return /^deepseek\/deepseek-v4-(pro|flash)(?:-|$)/.test(model);
}
