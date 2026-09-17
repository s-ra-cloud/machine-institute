import type { ModelProviderConfig } from "./model-service";
import { ContextBudgetError, RequestContextBudget } from "./llm-context";

export interface ToolContextProtection {
  getState: () => string;
  compactUserMessage?: string;
  onDiagnostic?: (message: string) => Promise<void> | void;
}

export interface ToolContextFitOptions {
  budget: RequestContextBudget;
  protection: ToolContextProtection;
  elidedToolOutputMessage?: string;
  numberToolResults?: boolean;
}

const OLD_OUTPUT_NOTE =
  "[Earlier output elided. Use read_tool_result with the original tool call ID; do not rerun the experiment to retrieve it.]";
const OLD_ARGUMENTS_NOTE =
  "[old command arguments omitted; use read_file on the existing file and read_tool_result for evidence]";

type Message = Record<string, any>;

function clone<T>(value: T): T {
  // Requests contain JSON data only. JSON cloning also guarantees that the object
  // handed to the SDK can never be an alias of the canonical transcript.
  return JSON.parse(JSON.stringify(value)) as T;
}

function callIds(message: Message): string[] {
  return Array.isArray(message.tool_calls)
    ? message.tool_calls
      .map((call: any) => call?.id)
      .filter((id: unknown): id is string => typeof id === "string")
    : [];
}

function toolId(message: Message): string | undefined {
  return typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
}

function hasCompletedCall(messages: Message[], index: number): boolean {
  const ids = callIds(messages[index]);
  return ids.length > 0 && ids.every(id => messages.some(message => toolId(message) === id));
}

function toolResultIndex(messages: Message[], id: string): number {
  return messages.findIndex(message => toolId(message) === id);
}

function toolCallForResult(messages: Message[], index: number): Message | undefined {
  const id = toolId(messages[index]);
  if (!id) return undefined;
  return messages.find(message =>
    message.role === "assistant" && callIds(message).includes(id));
}

function isRetrievalResult(messages: Message[], index: number): boolean {
  const assistant = toolCallForResult(messages, index);
  if (!assistant) return false;
  return assistant.tool_calls.some((call: any) =>
    call?.id === toolId(messages[index]) && /read_tool_result/i.test(String(call?.function?.name ?? "")));
}

function oldOutput(message: Message, note: string): string {
  const prefix = typeof message.content === "string"
    ? message.content.match(/^\[Tool call #\d+\]\n/)?.[0] ?? ""
    : "";
  return `${prefix}${note}`;
}

function shortenedOutput(message: Message, content: string, maxChars = 700): string {
  const prefix = typeof message.content === "string"
    ? message.content.match(/^\[Tool call #\d+\]\n/)?.[0] ?? ""
    : "";
  const note = "\n[output shortened; use read_tool_result with the original tool call ID for the remaining evidence]\n";
  const available = Math.max(0, maxChars - prefix.length - note.length);
  const head = content.slice(0, Math.ceil(available * 0.65));
  const tail = content.slice(-Math.floor(available * 0.35));
  return `${prefix}${head}${note}${tail}`;
}

function compactToolOutputs(
  messages: Message[],
  note: string,
  fits: () => boolean,
  keepRecent = 8,
  includeRetrieval = true,
): boolean {
  const toolIndexes = messages
    .map((message, index) => message.role === "tool" ? index : -1)
    .filter(index => index >= 0);
  if (toolIndexes.length === 0) return false;

  const recentStart = Math.max(0, toolIndexes.length - keepRecent);
  // Old ordinary command output is cheapest to discard. Retrieval results are
  // deliberately last: they are the evidence-preserving escape hatch.
  const ordinary = toolIndexes.filter(index => !isRetrievalResult(messages, index));
  const retrieval = toolIndexes.filter(index => isRetrievalResult(messages, index));
  const ordered = [
    ...ordinary.filter(index => index < toolIndexes[recentStart] || recentStart === toolIndexes.length),
    ...ordinary.filter(index => index >= (toolIndexes[recentStart] ?? Number.MAX_SAFE_INTEGER)),
    ...(includeRetrieval ? retrieval : []),
  ];
  let changed = false;
  for (const index of ordered) {
    const message = messages[index];
    const original = typeof message.content === "string" ? message.content : "";
    const replacement = oldOutput(message, note);
    if (isRetrievalResult(messages, index) && original.length > replacement.length) {
      // Retrieval output is evidence, not disposable noise. Retain a bounded
      // prefix/tail and an explicit paging instruction before falling back to
      // the tiny elision note.
      let shortened = shortenedOutput(message, original);
      if (shortened.length < original.length) {
        message.content = shortened;
        changed = true;
        if (fits()) return true;
        // Keep shortening this evidence-bearing version before removing any
        // complete history group. Prefix/tail provenance survives every step.
        for (const maxChars of [520, 360, 240, 160, 110]) {
          shortened = shortenedOutput(message, original, maxChars);
          message.content = shortened;
          if (fits()) return true;
        }
        // Keep the smallest evidence-bearing version while older complete
        // groups are removed. Do not replace it with a blank note.
        continue;
      }
    }
    if (!isRetrievalResult(messages, index) && original && original !== replacement) {
      message.content = replacement;
      changed = true;
      // Check after every single edit. In particular, do not erase the newest
      // retrieval merely because an older result would have been sufficient.
      if (fits()) return true;
    }
  }
  return changed;
}

function compactedArguments(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return JSON.stringify({ _context_note: OLD_ARGUMENTS_NOTE });
    const retained: Record<string, unknown> = {};
    const preferred = new Set(["path", "command", "file", "filename", "cwd", "offset", "max_chars", "timeout_seconds"]);
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!preferred.has(key) && typeof value !== "number" && typeof value !== "boolean") continue;
      if (typeof value === "string") retained[key] = value.slice(0, key === "command" ? 600 : 240);
      else retained[key] = value;
    }
    retained._context_note = OLD_ARGUMENTS_NOTE;
    return JSON.stringify(retained);
  } catch {
    return JSON.stringify({ _context_note: OLD_ARGUMENTS_NOTE });
  }
}

function compactCompletedArguments(messages: Message[], fits: () => boolean): boolean {
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant" || !hasCompletedCall(messages, i)) continue;
    for (const call of message.tool_calls as any[]) {
      if (!call?.function || typeof call.function.arguments !== "string") continue;
      const replacement = compactedArguments(call.function.arguments);
      if (replacement.length < call.function.arguments.length) {
        call.function.arguments = replacement;
        changed = true;
        if (fits()) return true;
      }
    }
  }
  return changed;
}

function removeObsoleteProse(messages: Message[], state: string, fits: () => boolean): boolean {
  const firstUser = messages.findIndex(message => message.role === "user");
  const latestUser = [...messages].map((message, index) => message.role === "user" ? index : -1)
    .filter(index => index >= 0).at(-1) ?? -1;
  const latestRepair = [...messages].map((message, index) =>
    message.role === "user" && message.content !== state
      && /continue|repair|unfinished|recover|logbook|stop:/i.test(String(message.content ?? ""))
      ? index : -1).filter(index => index >= 0).at(-1) ?? -1;
  const latestAssistant = [...messages].map((message, index) => message.role === "assistant" ? index : -1)
    .filter(index => index >= 0).at(-1) ?? -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const repairUser = message.role === "user"
      && i !== firstUser
      && i !== latestUser
      && i !== latestRepair
      && message.content !== state
      && /continue|repair|unfinished|recover|logbook|stop:/i.test(String(message.content ?? ""));
    const oldAssistantProse = message.role === "assistant"
      && i !== latestAssistant
      && callIds(message).length === 0
      && typeof message.content === "string"
      && message.content.length > 0;
    if (repairUser || oldAssistantProse) {
      messages.splice(i, 1);
      return true;
    }
  }
  return false;
}

function removeOldestCompleteGroup(messages: Message[], protectedIds: Set<string> = new Set()): boolean {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant" || !hasCompletedCall(messages, i)) continue;
    const ids = callIds(message);
    if (ids.some(id => protectedIds.has(id))) continue;
    const remove = new Set<number>([i]);
    for (const id of ids) {
      const resultIndex = toolResultIndex(messages, id);
      if (resultIndex >= 0) remove.add(resultIndex);
    }
    // Remove only the assistant turn and its paired results. Thus no tool
    // message can survive without its assistant tool-call declaration.
    messages.splice(
      0,
      messages.length,
      ...messages.filter((_candidate, index) => !remove.has(index)),
    );
    return true;
  }
  return false;
}

function latestRetrievalIds(messages: Message[]): Set<string> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool" && isRetrievalResult(messages, i)) {
      const id = toolId(messages[i]);
      return id ? new Set([id]) : new Set();
    }
  }
  return new Set();
}

function restoreRetrievalDetail(
  messages: Message[],
  originals: Map<string, string>,
  fits: () => boolean,
): void {
  originals.forEach((original, id) => {
    const index = messages.findIndex(message => toolId(message) === id);
    if (index < 0 || !isRetrievalResult(messages, index)) return;
    let best = String(messages[index].content ?? "");
    for (const maxChars of [700, 520, 360, 240, 160, 110]) {
      const candidate = shortenedOutput(messages[index], original, maxChars);
      messages[index].content = candidate;
      if (fits()) best = candidate;
      else messages[index].content = best;
    }
  });
}

function ensureStateMessage(messages: Message[], state: string): void {
  const lastUser = [...messages].reverse().find(message => message.role === "user");
  if (lastUser?.content === state) return;
  messages.push({ role: "user", content: state });
}

/**
 * Clone and fit an OpenAI-compatible request. The input request is never
 * modified; in particular assistant tool-call argument JSON and tool-call IDs
 * remain authoritative in the loop's canonical transcript.
 */
export function fitToolContext<T extends Record<string, any>>(
  request: T,
  options: ToolContextFitOptions,
): T {
  const fitted = clone(request);
  const messages = Array.isArray(fitted.messages) ? fitted.messages as Message[] : [];
  const state = options.protection.getState();
  ensureStateMessage(messages, state);
  const retrievalOriginals = new Map<string, string>();
  messages.forEach((message, index) => {
    const id = toolId(message);
    if (id && isRetrievalResult(messages, index) && typeof message.content === "string") {
      retrievalOriginals.set(id, message.content);
    }
  });

  const fits = () => options.budget.fits(fitted);
  if (fits()) return fitted;

  // The initial user payload is the only user message that may be replaced.
  // System instructions and the exact state message are intentionally never
  // elided.
  if (options.protection.compactUserMessage !== undefined) {
    const initialUser = messages.find(message => message.role === "user");
    if (initialUser && initialUser.content !== state) {
      initialUser.content = options.protection.compactUserMessage;
      if (fits()) return fitted;
    }
  }

  const note = options.elidedToolOutputMessage ?? OLD_OUTPUT_NOTE;
  // Arguments/prose are historical scaffolding; preserve current evidence
  // output and retrieval messages until these cheaper reductions are spent.
  compactCompletedArguments(messages, fits);
  if (fits()) return fitted;
  while (!fits() && removeObsoleteProse(messages, state, fits)) {
    // Remove old repair scaffolding before sacrificing current evidence.
  }
  if (fits()) return fitted;
  compactToolOutputs(messages, note, fits);
  if (fits()) return fitted;

  while (!fits()) {
    if (removeObsoleteProse(messages, state, fits)) continue;
    if (!removeOldestCompleteGroup(messages, latestRetrievalIds(messages))) break;
  }
  if (fits()) return fitted;
  compactToolOutputs(messages, note, fits, 8, true);
  if (fits()) return fitted;
  while (!fits()) {
    if (removeOldestCompleteGroup(messages, latestRetrievalIds(messages))) continue;
    break;
  }
  restoreRetrievalDetail(messages, retrievalOriginals, fits);

  // assertFits gives callers the shared, structured budget error rather than
  // silently dropping system instructions or the latest state.
  options.budget.assertFits(fitted);
  throw new ContextBudgetError("Tool-loop request exceeds its irreducible context budget.");
}

export function isToolContextBudgetError(error: unknown): error is ContextBudgetError {
  return error instanceof ContextBudgetError;
}

// A descriptive alias makes the small pure fitting API convenient to consume.
export const fitRequestToContext = fitToolContext;

export function toolContextOldOutputNote(): string {
  return OLD_OUTPUT_NOTE;
}

export type ToolContextConfig = ModelProviderConfig;