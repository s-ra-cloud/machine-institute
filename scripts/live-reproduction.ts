/**
 * Opt-in invocation of the WEBSITE's runReproduction entrypoint. No substitute
 * extraction, tools, execution, or judge. Does not publish or change database rows.
 * Keep the ledger across attempts, including charges from interrupted requests.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import { runReproduction } from "../server/reproduce";
import { getReproducerPrompt, getJudgePrompt } from "../server/prompts/reproduce";
import { INITIATIVE_DOC_IDS, INITIATIVE_SLUGS, getJournalDisplayName } from "../server/journals";
import { ReproductionSandbox } from "../server/modal-sandbox";
import { getReproductionFailureDiagnostics } from "../server/reproduction-diagnostics";

const modelName = "deepseek/deepseek-v4-pro-0813";
const root = ".local/state/live-reproduction";
if (process.env.RUN_LIVE_REPRODUCTION !== "1") throw new Error("Paid run requires explicit opt-in.");
mkdirSync(root, { recursive: true });
const ledgerPath = `${root}/budget.json`;
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
if (!Number.isFinite(ledger.reservedOrSpent)) throw new Error("Missing prior-run cost accounting.");
const lockPath = `${root}/website.lock`;
const lock = openSync(lockPath, "wx");
const saveLedger = () => {
  writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2));
  renameSync(`${ledgerPath}.tmp`, ledgerPath);
};
const attempt = `${root}/website-${Date.now()}`;
mkdirSync(attempt);
const save = (name: string, value: unknown) => writeFileSync(`${attempt}/${name}.json`, JSON.stringify(value, null, 2));
const originalFetch = globalThis.fetch;
// The largest published pricing override, validated anew before every request.
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== "https://openrouter.ai/api/v1/chat/completions") return originalFetch(input, init);
  if (typeof init?.body !== "string") throw new Error("Cannot account for model request.");
  const body = JSON.parse(init.body);
  if (body.model !== modelName || body.stream || body.plugins || body.models) throw new Error("Unapproved billable request.");
  const catalogue = await originalFetch("https://openrouter.ai/api/v1/models");
  if (!catalogue.ok) throw new Error("Cannot verify current prices.");
  const model = (await catalogue.json() as any).data.find((m: any) => m.id === modelName);
  if (!model) throw new Error("Requested model unavailable.");
  const prices = [model.pricing, ...(model.pricing.overrides ?? [])];
  const prompt = Math.max(...prices.map((p: any) => Number(p.prompt)));
  const completion = Math.max(...prices.map((p: any) => Number(p.completion)));
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  // Serialized UTF-8 includes the full prompts, tool schemas and history.
  // Four tokens per byte plus 64k framing slack deliberately over-reserves;
  // unlike reserving the entire million-token context it scales with requests.
  const inputBound = Math.min(Number(model.context_length), Buffer.byteLength(init.body, "utf8") * 4 + 65536);
  const reservation = (inputBound * prompt + maxTokens * completion) * 1.1;
  if (!Number.isFinite(reservation) || reservation <= 0 || ledger.reservedOrSpent + reservation > 5)
    throw new Error("DeepSeek $5 spending guard stopped this run.");
  ledger.reservedOrSpent += reservation; ledger.requests++; saveLedger();
  const response = await originalFetch(input, init);
  const result = await response.clone().json().catch(() => null) as any;
  const usage = result?.usage;
  if (response.ok && Number.isFinite(usage?.cost) && usage.cost >= 0 &&
      Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens)) {
    const cost = Math.max(usage.cost, usage.prompt_tokens * prompt + usage.completion_tokens * completion);
    ledger.reservedOrSpent += cost - reservation; ledger.settled++; saveLedger();
    console.log(JSON.stringify({ event: "spending", accountedModelDollars: ledger.reservedOrSpent }));
    if (cost > reservation) throw new Error("Provider exceeded reserved cost; stopped for reconciliation.");
  }
  return response;
};

// A live GPU needs a verified resource/cost bound BEFORE allocation. The normal
// pipeline still owns sandbox creation and teardown; this guard fails closed.
const create = ReproductionSandbox.create.bind(ReproductionSandbox);
ReproductionSandbox.create = async opts => {
  if (opts.gpu !== "A10G" || opts.timeoutMs > 8_400_000)
    throw new Error("Unbudgeted Modal configuration.");
  // Reserve $5 per allocation, without refunds: A10G + 2 CPU + 8 GiB
  // at the published per-second rates for the full 2h20m lifetime is < $3.
  // Remaining reserve covers image build/overhead. Completed allocations may
  // only be reconciled using verified termination and conservative cost bounds.
  if ((ledger.modalReserved ?? 0) + 5 > 10) throw new Error("Modal $10 spending guard stopped this run.");
  ledger.modalReserved = (ledger.modalReserved ?? 0) + 5; saveLedger();
  return create({ ...opts, resourceLimits: { cpu: 2, memoryMiB: 8192 } });
};
try {
  const config = { providerMode: "byoc" as const, provider: "openrouter", modelName, apiKey: process.env.OPENROUTER_API_KEY };
  const result = await runReproduction({
    agentId: "P", reproductionId: `live-${Date.now()}`, projectId: "mirror", journalId: "mirror",
    initiativeDocId: INITIATIVE_DOC_IDS.mirror, initiativeSlug: INITIATIVE_SLUGS.mirror,
    journalDisplayName: getJournalDisplayName("mirror"),
    documentId: process.argv[2] || "yy1xhmskst8o5blht5gbipmi",
    reproducerPrompt: getReproducerPrompt("P"), judgePrompt: getJudgePrompt("P"),
    modelConfig: config, judgeModelConfig: config, gpu: "A10G",
    emitEvent: async (phase, message) => console.log(JSON.stringify({ phase, message })),
    onCheckpoint: async checkpoint => save("checkpoint", checkpoint),
    onDiagnostics: diagnostics => save("diagnostics", diagnostics),
  });
  save("result", result);
  console.log(JSON.stringify({ event: "complete", overall: result.overall, attempt }));
} catch (error) {
  save("diagnostics", getReproductionFailureDiagnostics(error) ?? null);
  const message = error instanceof Error ? error.message : "Unknown failure";
  save("failure", { message });
  console.error(message);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  ReproductionSandbox.create = create;
  closeSync(lock); unlinkSync(lockPath);
}
