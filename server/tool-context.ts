import type { ModelProviderConfig } from "./model-service";
import { ContextBudgetError, RequestContextBudget } from "./llm-context";
import { describeToolContext } from "./context-diagnostics";
export { describeToolContext } from "./context-diagnostics";

export interface ToolContextProtection {
  getState: (maxBytes?: number) => string;
  /**
   * Return the bounded, self-contained action the model must take next.
   * The verbose repair/control turn remains in the canonical transcript and
   * archive; this projection is the instruction that survives compaction.
   */
  getActiveInstruction?: (maxBytes?: number) => string;
  archiveContext?: (key: string, text: string) => string;
  resizeRetrieval?: (
    name: string,
    args: Record<string, unknown>,
    originalResult: string,
    maxBytes: number,
  ) => string | undefined;
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
export const ACTIVE_INSTRUCTION_MAX_BYTES = 1_000;
// Total preflight reservation: state, retrieval, active action, and wrappers.
export const RUNTIME_CONTEXT_HEADROOM = 10_000;
const DEFAULT_STATE_BYTES = 2_500;
const MINIMUM_STATE_BYTES = 600;

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
    call?.id === toolId(messages[index])
      && /read_(?:tool_result|reproduction_context)/i.test(String(call?.function?.name ?? "")));
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
  const note =
    "\n[output shortened with a middle omission; repeat the original retrieval tool call arguments with a smaller max_chars to obtain a genuine page]\n";
  const available = Math.max(0, maxChars - prefix.length - note.length);
  const headLength = Math.ceil(available * 0.65);
  const tailLength = Math.floor(available * 0.35);
  const head = headLength > 0 ? content.slice(0, headLength) : "";
  // slice(-0) means slice(0), which used to restore the complete output.
  const tail = tailLength > 0 ? content.slice(-tailLength) : "";
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
    if (includeRetrieval && isRetrievalResult(messages, index) && original.length > replacement.length) {
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

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function boundedState(protection: ToolContextProtection, maxBytes: number): string {
  let state = protection.getState(maxBytes);
  if (typeof state !== "string") state = String(state ?? "");
  // A bounded-state provider may have conservative accounting of its own. Only
  // ask it for progressively smaller renderings; never byte-slice structured
  // state, especially in the middle of a Unicode code point.
  if (serializedBytes(state) > maxBytes && maxBytes > MINIMUM_STATE_BYTES) {
    state = protection.getState(MINIMUM_STATE_BYTES);
    if (typeof state !== "string") state = String(state ?? "");
  }
  return state;
}

function boundedSerializedString(value: unknown, maxBytes: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (serializedBytes(text) <= maxBytes) return text;

  // Slice only at Unicode code-point boundaries and account for JSON escaping:
  // provider input limits apply to the complete serialized request, not
  // JavaScript's UTF-16 string length.
  const suffix = "\n[Instruction projection truncated to its fixed byte bound.]";
  const points = Array.from(text);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(points.slice(0, middle).join("") + suffix) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const bounded = points.slice(0, low).join("") + suffix;
  if (serializedBytes(bounded) <= maxBytes) return bounded;
  // This is only reachable for an implausibly tiny caller-supplied bound.
  return "";
}

function activeInstruction(protection: ToolContextProtection): string | undefined {
  if (!protection.getActiveInstruction) return undefined;
  // Snapshot exactly once. Session-backed implementations can therefore bind
  // archive references and action state atomically for this fitted request.
  const instruction = boundedSerializedString(
    protection.getActiveInstruction(ACTIVE_INSTRUCTION_MAX_BYTES),
    ACTIVE_INSTRUCTION_MAX_BYTES,
  );
  return instruction.length > 0 ? instruction : undefined;
}

function archiveGeneratedContext(
  messages: Message[],
  archive: (key: string, text: string) => string,
  state: string,
  active: string | undefined,
): boolean {
  const firstUser = messages.findIndex(message => message.role === "user");
  const latestUser = messages.reduce((found, message, index) =>
    message.role === "user" && message.content !== state ? index : found, -1);
  const latestIsStop = latestUser >= 0
    && /^STOP:/i.test(String(messages[latestUser]?.content ?? "").trim());
  let changed = false;

  // Keys use canonical, pre-deletion indexes. fitToolContext always operates on
  // a fresh clone, making them stable across retries and progressively tighter
  // fits of the same transcript.
  messages.forEach((message, index) => {
    const content = typeof message.content === "string" ? message.content : "";
    const generatedAssistant = message.role === "assistant" && content.length > 0;
    // In a tool loop, subsequent user turns are generated repair/control
    // messages. The sole exceptions are the explicitly appended state and the
    // latest forced-final STOP control, both of which must remain verbatim.
    const repair = message.role === "user"
      && index !== firstUser
      && content !== state
      && content !== active
      && !(latestIsStop && index === latestUser);
    if (!generatedAssistant && !repair) return;
    const notice = archive(`${message.role}-${index}`, content);
    if (typeof notice === "string" && notice.length < content.length) {
      message.content = notice;
      changed = true;
    }
  });
  return changed;
}

function compactedArguments(raw: string, name: string, archive?: ToolContextProtection["archiveContext"], key = ""): string {
  // Archive rejected/non-object JSON too: a malformed canonical submission is
  // diagnostic context, never something compaction may silently infer or fix.
  const archiveNotice = archive?.(`tool-arguments:${key}:${name}`, raw);
  const omitted = () => JSON.stringify({
    ...(archiveNotice ? { _context_archive: archiveNotice } : {}),
    _context_note: OLD_ARGUMENTS_NOTE,
  });
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return omitted();
    const retained: Record<string, unknown> = {};
    const preferred = new Set(["id", "claim", "status", "ref", "tool_call_id", "evidence_tool_call_ids", "raw_input_tool_call_id", "raw_input_path", "method", "blocker_kind", "path", "command", "file", "filename", "cwd", "offset", "max_chars", "timeout_seconds"]);
    if (archiveNotice) retained._context_archive = archiveNotice;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!preferred.has(key)) continue;
      // Identity/evidence fields must remain exact, or recoverable from the
      // immutable archive. Never turn a sliced id or claim into apparent truth.
      if (serializedBytes(value) <= (key === "command" ? 650 : 400)) retained[key] = value;
      else if (!archiveNotice && typeof value === "string" && ["command", "path"].includes(key)) {
        retained[key] = Array.from(value).slice(0, 100).join("") + " [omitted]";
      }
    }
    retained._context_note = OLD_ARGUMENTS_NOTE;
    if (serializedBytes(retained) > 1800 && archiveNotice) {
      return JSON.stringify({ _context_archive: archiveNotice, _context_note: OLD_ARGUMENTS_NOTE });
    }
    return JSON.stringify(retained);
  } catch {
    return omitted();
  }
}

function compactCompletedArguments(messages: Message[], fits: () => boolean, archive?: ToolContextProtection["archiveContext"]): boolean {
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant" || !hasCompletedCall(messages, i)) continue;
    // Native signed function-call parts are immutable continuation data. Their
    // arguments must agree with the canonical calls and cannot be rewritten.
    if (message.providerParts?.length) continue;
    for (const call of message.tool_calls as any[]) {
      if (!call?.function || typeof call.function.arguments !== "string") continue;
      const replacement = compactedArguments(call.function.arguments, String(call.function.name ?? ""), archive, String(call.id ?? i));
      if (replacement.length < call.function.arguments.length) {
        call.function.arguments = replacement;
        changed = true;
        if (fits()) return true;
      }
    }
  }
  return changed;
}

function removeObsoleteProse(
  messages: Message[],
  state: string,
  active: string | undefined,
): boolean {
  const firstUser = messages.findIndex(message => message.role === "user");
  const latestUser = [...messages].map((message, index) => message.role === "user" ? index : -1)
    .filter(index => index >= 0).at(-1) ?? -1;
  const latestRepair = [...messages].map((message, index) =>
    message.role === "user" && message.content !== state
      && /continue|repair|unfinished|recover|logbook|stop:/i.test(String(message.content ?? ""))
      ? index : -1).filter(index => index >= 0).at(-1) ?? -1;
  const latestAssistant = [...messages].map((message, index) => message.role === "assistant" ? index : -1)
    .filter(index => index >= 0).at(-1) ?? -1;
  const latestIsStop = latestUser >= 0
    && /^STOP:/i.test(String(messages[latestUser]?.content ?? "").trim());
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const repairUser = message.role === "user"
      && i !== firstUser
      && message.content !== state
      && message.content !== active
      && !(latestIsStop && i === latestUser)
      && (active !== undefined
        || /continue|repair|unfinished|recover|logbook|stop:/i.test(String(message.content ?? "")))
      && (active !== undefined || (i !== latestUser && i !== latestRepair));
    const oldAssistantProse = message.role === "assistant"
      && (active !== undefined || i !== latestAssistant)
      && callIds(message).length === 0
      && typeof message.content === "string"
      && message.content.length > 0
      && !/"notice"\s*:\s*"Archived unchanged; not scientific evidence\."/i.test(message.content);
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
    const removableIds = ids.filter(id => !protectedIds.has(id));
    if (removableIds.length === 0) continue;
    if (removableIds.length < ids.length) {
      // A signed native turn is an atomic group. If its newest retrieval is
      // protected, keep every sibling call and response too. Fail closed if
      // the group cannot fit rather than producing a partial signed history.
      if (message.providerParts?.length) continue;
      // A single assistant turn may declare several independent calls. Keep
      // the protected newest retrieval declaration while removing each older
      // declaration together with its paired result.
      const removeResults = new Set(removableIds);
      message.tool_calls = (message.tool_calls as any[])
        .filter(call => !removeResults.has(String(call?.id ?? "")));
      messages.splice(
        0,
        messages.length,
        ...messages.filter(candidate => !removeResults.has(toolId(candidate) ?? "")),
      );
      return true;
    }
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

function resizeLatestRetrieval(
  messages: Message[],
  resize: NonNullable<ToolContextProtection["resizeRetrieval"]>,
  originals: Map<string, string>,
  originalCalls: Map<string, { name: string; args: Record<string, unknown> }>,
  fits: () => boolean,
): boolean {
  const protectedIds = latestRetrievalIds(messages);
  const id = protectedIds.values().next().value as string | undefined;
  if (!id) return false;
  const resultIndex = messages.findIndex(message => toolId(message) === id);
  if (resultIndex < 0) return false;
  const originalCall = originalCalls.get(id);
  if (!originalCall) return false;
  const { name, args } = originalCall;
  if (!name) return false;

  const original = originals.get(id) ?? String(messages[resultIndex].content ?? "");
  const prefix = original.match(/^\[Tool call #\d+\]\n/)?.[0] ?? "";
  const originalBody = prefix ? original.slice(prefix.length) : original;
  let previousBytes = serializedBytes(messages[resultIndex].content);
  let changed = false;
  for (const maxBytes of [4_000, 2_500, 1_500, 800, 400]) {
    const resized = resize(name, clone(args), originalBody, maxBytes);
    if (typeof resized !== "string") continue;
    const returnedBody = resized.replace(/^\[Tool call #\d+\]\n/, "");
    const candidate = `${prefix}${returnedBody}`;
    const candidateBytes = serializedBytes(candidate);
    if (candidateBytes >= previousBytes) continue;
    messages[resultIndex].content = candidate;
    previousBytes = candidateBytes;
    changed = true;
    if (fits()) return true;
  }
  return changed;
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
    const compact = String(messages[index].content ?? "");
    messages[index].content = original;
    if (fits()) return;
    messages[index].content = compact;
    for (const maxChars of [700, 520, 360, 240, 160, 110]) {
      const candidate = shortenedOutput(messages[index], original, maxChars);
      messages[index].content = candidate;
      if (fits()) return;
    }
    messages[index].content = compact;
  });
}

function forcedFinalIndex(messages: Message[]): number {
  const latestUser = messages.reduce((found, message, index) =>
    message.role === "user" ? index : found, -1);
  return latestUser >= 0
    && /^STOP:/i.test(String(messages[latestUser]?.content ?? "").trim())
    ? latestUser
    : -1;
}

function insertBeforeForcedFinal(messages: Message[], message: Message): void {
  const stopIndex = forcedFinalIndex(messages);
  if (stopIndex >= 0) messages.splice(stopIndex, 0, message);
  else messages.push(message);
}

function ensureStateMessage(messages: Message[], state: string): void {
  if (messages.some(message => message.role === "user" && message.content === state)) return;
  insertBeforeForcedFinal(messages, { role: "user", content: state });
}

function ensureActiveInstruction(messages: Message[], active: string | undefined): void {
  // STOP is deliberately final and dominant. A normal active projection must
  // never be appended after (or compete with) forced-final control.
  if (!active || forcedFinalIndex(messages) >= 0) return;
  if (messages.some(message => message.role === "user" && message.content === active)) return;
  messages.push({ role: "user", content: active });
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
  let state = boundedState(options.protection, DEFAULT_STATE_BYTES);
  // A forced-final turn is already the active instruction. Do not even
  // snapshot a session repair projection that cannot be used by this request.
  const active = forcedFinalIndex(messages) >= 0
    ? undefined
    : activeInstruction(options.protection);
  ensureStateMessage(messages, state);
  ensureActiveInstruction(messages, active);
  const retrievalOriginals = new Map<string, string>();
  const retrievalCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
  messages.forEach((message, index) => {
    const id = toolId(message);
    if (id && isRetrievalResult(messages, index) && typeof message.content === "string") {
      retrievalOriginals.set(id, message.content);
      const assistant = toolCallForResult(messages, index);
      const call = assistant?.tool_calls?.find((candidate: any) => candidate?.id === id);
      try {
        const parsed = JSON.parse(String(call?.function?.arguments ?? "{}"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          retrievalCalls.set(id, {
            name: String(call?.function?.name ?? ""),
            args: parsed as Record<string, unknown>,
          });
        }
      } catch {
        // A malformed canonical call cannot be safely regenerated.
      }
    }
  });

  const fits = () => options.budget.fits(fitted);
  if (fits()) return fitted;

  if (options.protection.archiveContext) {
    archiveGeneratedContext(messages, options.protection.archiveContext, state, active);
    // Once a bounded active projection exists, archived prose is source
    // material, not an instruction. Remove every archive notice before any
    // early return so a model cannot mistake the newest pointer for its task.
    if (active !== undefined) {
      while (removeObsoleteProse(messages, state, active)) {
        // Preserve only initial input, bounded state, and bounded active action.
      }
    }
    if (fits()) return fitted;
  }

  // Only an explicitly supplied compact replacement may replace the initial
  // payload. Reproduction's initial paper/material preview is generated;
  // scientific/custom instructions live in the immutable system message.
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
  compactCompletedArguments(messages, fits, options.protection.archiveContext);
  if (fits()) return fitted;
  while (!fits() && removeObsoleteProse(messages, state, active)) {
    // Remove old repair scaffolding before sacrificing current evidence.
  }
  if (fits()) return fitted;
  compactToolOutputs(messages, note, fits, 8, false);
  if (fits()) return fitted;

  while (!fits()) {
    if (removeObsoleteProse(messages, state, active)) continue;
    if (!removeOldestCompleteGroup(messages, latestRetrievalIds(messages))) break;
  }
  if (fits()) return fitted;

  // State is generated for this request and has an explicit bounded rendering
  // contract. Spend its final reduction only after historical groups/prose.
  const smallerState = boundedState(options.protection, MINIMUM_STATE_BYTES);
  if (smallerState !== state) {
    const stateIndex = messages.map((message, index) =>
      message.role === "user" && message.content === state ? index : -1)
      .filter(index => index >= 0).at(-1) ?? -1;
    if (stateIndex >= 0) messages[stateIndex].content = smallerState;
    else ensureStateMessage(messages, smallerState);
    state = smallerState;
    if (fits()) return fitted;
  }

  if (
    options.protection.archiveContext
    && options.protection.resizeRetrieval
    && resizeLatestRetrieval(
      messages,
      options.protection.resizeRetrieval,
      retrievalOriginals,
      retrievalCalls,
      fits,
    )
    && fits()
  ) {
    return fitted;
  }

  // Archive-enabled reproduction retrieval pages have structured paging
  // metadata and may start at a non-zero source offset. Never manufacture a
  // page by slicing their serialized wrapper. Legacy generic callers retain
  // the historical bounded evidence fallback with an honest omission note.
  compactToolOutputs(messages, note, fits, 8, !options.protection.archiveContext);
  if (fits()) return fitted;
  while (!fits()) {
    if (removeOldestCompleteGroup(messages, latestRetrievalIds(messages))) continue;
    break;
  }
  if (!options.protection.archiveContext) {
    restoreRetrievalDetail(messages, retrievalOriginals, fits);
  }
  if (fits()) return fitted;

  const stateSize = serializedBytes(state);
  const latestRetrieval = latestRetrievalIds(messages).size > 0;
  const cause = options.protection.archiveContext && latestRetrieval
    ? "the newest retrieval page is irreducible and was preserved intact"
    : stateSize > MINIMUM_STATE_BYTES
      ? "generated-state remains larger than its requested bound"
      : "fixed input (instructions and tool schemas) plus irreducible generated-state exceeds the limit";
  throw new ContextBudgetError(
    `Tool-loop request exceeds its irreducible context budget: ${cause}; `
    + `${options.budget.diagnostic(fitted)}; staged_sizes=${describeToolContext(fitted, state)}`,
  );
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