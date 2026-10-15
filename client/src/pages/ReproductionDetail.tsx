import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, Link, useLocation } from "wouter";
import { ArrowLeft, Loader2, Calendar, Bot, Clock, Info, ExternalLink, Trash2, UploadCloud, FlaskConical, Cpu, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeIn } from "@/components/ui/motion";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { ReviewProgress } from "@/components/ReviewProgress";
import {
  areReproductionModelModesCompatible,
  isByokModelSelectionReady,
  ModelSelector,
  useGenerationConfig,
  type ModelConfig,
} from "@/components/ModelSelector";
import { useAuth } from "@/lib/auth";
import type { Reproduction } from "@shared/schema";
import { reproductionPersonaName } from "@/lib/reproduction-personas";
import { ReproductionJudgeSelector, useReproductionJudge, reproductionModelPayload, postReproduction } from "@/components/ReproductionJudgeSelector";

interface ClaimVerdict {
  id: string;
  claim: string;
  verdict: "verified" | "falsified" | "toy" | "inconclusive";
  originalValue?: string;
  reproducedValue?: string;
  evidence?: string;
  confidence?: string;
}

const VERDICT_STYLES: Record<string, string> = {
  verified: "text-green-400 border-green-400/30 bg-green-400/5",
  "partially verified": "text-emerald-300 border-emerald-300/30 bg-emerald-300/5",
  falsified: "text-red-400 border-red-400/30 bg-red-400/5",
  toy: "text-blue-300 border-blue-300/30 bg-blue-300/5",
  inconclusive: "text-yellow-400 border-yellow-400/30 bg-yellow-400/5",
};
const REPRODUCTION_ACCESS_EMAILS = ["jevans@uchicago.edu", "sacharaoult@gmail.com", "akozlo@uchicago.edu"];

export function verdictStyle(verdict: string | null | undefined): string {
  return VERDICT_STYLES[verdict || ""] || "text-muted-foreground border-border/30 bg-muted/5";
}

export function formatQuestioningState(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return `Saved assessment could not be parsed.\n${value}`; }
}

type ProvenancePage = {
  kind: "manifest" | "blob"; hash: string | null; encoding: string;
  offset: number; limit: number; total: number; nextOffset: number | null;
  blobCount: number; data: string;
};

function ProvenanceInspector({ id }: { id: string }) {
  const [opened, setOpened] = useState(false);
  const [hashInput, setHashInput] = useState("");
  const [hash, setHash] = useState("");
  const [offset, setOffset] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const pageSize = 8192;
  async function load(start: number, selectedHash: string): Promise<ProvenancePage> {
    const query = new URLSearchParams({ offset: String(start), limit: String(pageSize) });
    if (selectedHash) query.set("hash", selectedHash);
    const response = await fetch(`/api/reproductions/${encodeURIComponent(id)}/provenance?${query}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load provenance.");
    return body;
  }
  const { data, error, isFetching } = useQuery<ProvenancePage>({
    queryKey: ["/api/reproductions", id, "provenance", hash, offset],
    queryFn: () => load(offset, hash),
    enabled: opened,
    retry: false,
    refetchOnWindowFocus: false,
  });
  async function download() {
    if (!data || !window.confirm(`Download the complete ${hash ? "selected blob" : "manifest"} (${data.total.toLocaleString()} text characters)? Blob content is downloaded separately by its SHA-256 address.`)) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const parts: string[] = [];
      let next: number | null = 0;
      // Retain UTF-16 chunks until joining: a Unicode surrogate pair may
      // straddle a page boundary and must not be encoded separately.
      while (next !== null) {
        const page: ProvenancePage = await load(next, hash);
        parts.push(page.data);
        next = page.nextOffset;
      }
      const url = URL.createObjectURL(new Blob([parts.join("")], { type: hash ? "text/plain;charset=utf-8" : "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = hash ? `${hash}.txt` : `${id}-provenance-manifest.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed.");
    } finally { setDownloading(false); }
  }
  return <div className="space-y-3" data-testid="provenance-inspector">
    <Button variant="outline" size="sm" onClick={() => setOpened(!opened)}>
      {opened ? "Close provenance inspector" : "Inspect saved provenance"}
    </Button>
    {opened && <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Loaded only on request, one bounded page at a time. The manifest lists original, modified and executed versions. Paste a content SHA-256 address from the manifest to inspect or download that exact version. No source blobs are loaded automatically.</p>
      <form className="flex flex-wrap gap-2" onSubmit={event => {
        event.preventDefault();
        if (/^[a-f0-9]{64}$/.test(hashInput.trim())) { setHash(hashInput.trim()); setOffset(0); }
      }}>
        <input aria-label="Provenance blob SHA-256" className="min-w-0 flex-1 border border-border bg-background p-2 text-xs font-mono"
          value={hashInput} onChange={event => setHashInput(event.target.value)} placeholder="64-character SHA-256 content address" pattern="[a-f0-9]{64}" required />
        <Button type="submit" size="sm" variant="outline" disabled={downloading}>Inspect blob</Button>
        <Button type="button" size="sm" variant="outline" disabled={downloading} onClick={() => { setHash(""); setHashInput(""); setOffset(0); }}>Manifest</Button>
      </form>
      {isFetching && <p className="text-xs">Loading provenance page…</p>}
      {error && <p className="text-xs text-destructive" role="alert">{error.message}</p>}
      {data && <>
        <p className="text-xs font-mono break-all">{data.kind === "blob" ? hash : "Manifest"} · {data.total.toLocaleString()} UTF-16 units · {data.blobCount} content blobs</p>
        <pre className="text-xs whitespace-pre-wrap break-words max-h-96 overflow-auto border border-border p-3" data-testid="text-questioning-state">{data.data}</pre>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={offset === 0 || isFetching || downloading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous page</Button>
          <span className="text-xs">{offset.toLocaleString()}–{Math.min(offset + data.limit, data.total).toLocaleString()} / {data.total.toLocaleString()}</span>
          <Button variant="outline" size="sm" disabled={data.nextOffset === null || isFetching || downloading} onClick={() => setOffset(data.nextOffset!)}>Next page</Button>
          <Button variant="outline" size="sm" disabled={downloading || isFetching} onClick={download}>{downloading ? "Downloading…" : `Download ${hash ? "selected blob" : "manifest"}`}</Button>
        </div>
      </>}
      {downloadError && <p className="text-xs text-destructive" role="alert">{downloadError}</p>}
    </div>}
  </div>;
}

export function providerPaymentGuidance(diagnostics: unknown): string | null {
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const snapshot = diagnostics as { stopReason?: unknown; events?: unknown };
  if (snapshot.stopReason !== "provider-payment" && snapshot.stopReason !== "provider-credit") return null;
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const isTransient = events.some(event => event && typeof event === "object"
    && (event as { providerLimitSource?: unknown }).providerLimitSource === "openrouter_in_flight_budget");
  if (isTransient) {
    return "The model gateway temporarily reached its in-flight spending limit. Wait for that temporary hold to clear before retrying. New Lab runs use Replit-managed OpenRouter, funded by Replit credits.";
  }
  const isKeyCap = events.some(event => event && typeof event === "object"
    && (event as { providerLimitSource?: unknown }).providerLimitSource === "openrouter_key_limit");
  const legacyOpenRouter = isTransient || isKeyCap || events.some(event => event && typeof event === "object"
    && String((event as { providerLimitSource?: unknown }).providerLimitSource || "").startsWith("openrouter_"));
  if (!legacyOpenRouter) {
    return "Replit-managed OpenRouter could not authorize this request. Ask the deployment administrator to check the managed integration, Replit credits and spending limits, then retry with an enabled model.";
  }
  return isKeyCap
    ? "The recorded gateway request reached a spending cap. Historical runs retain their original billing diagnostics. New retries use Replit-managed OpenRouter: ask the administrator to check Replit credits and managed integration limits, not personal OpenRouter keys."
    : "The recorded gateway request could not be funded. Historical runs retain their original billing diagnostics. New retries use Replit-managed OpenRouter funded by Replit credits, not personal OpenRouter keys.";
}

function FailureDiagnostics({ id, adminId }: { id: string; adminId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isFetching, error } = useQuery<{ diagnostics: unknown | null }>({
    queryKey: ["/api/reproductions", id, "diagnostics", adminId],
    enabled: expanded,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const response = await fetch(`/api/reproductions/${id}/diagnostics`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load private diagnostics.");
      return response.json();
    },
  });
  return (
    <section className="mt-6 border border-border/30 p-5" data-testid="section-failure-diagnostics">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="failure-diagnostics-content"
        onClick={() => setExpanded(value => !value)}
        className="text-xs font-mono text-muted-foreground hover:text-foreground"
        data-testid="button-toggle-failure-diagnostics"
      >
        {expanded ? "Hide" : "Show"} run diagnostics and evidence (admin only)
      </button>
      {expanded && (
        <div id="failure-diagnostics-content" className="mt-4 text-xs text-muted-foreground">
          <p className="mb-3">Private operational snapshot, not a completed scientific report.</p>
          {isFetching ? <p>Loading diagnostics...</p>
            : error ? <p role="alert">Could not load private diagnostics. Close and reopen to retry.</p>
            : data?.diagnostics == null ? <p>No diagnostics were saved for this run.</p>
            : <>
                <button type="button" className="mb-3 underline" onClick={() => {
                  const url = URL.createObjectURL(new Blob([JSON.stringify(data.diagnostics, null, 2)], { type: "application/json" }));
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `reproduction-${id}-evidence.json`;
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}>Download private diagnostics and evidence</button>
                {providerPaymentGuidance(data.diagnostics) && (
                  <p className="mb-3 border border-amber-500/30 bg-amber-500/5 p-3 text-amber-200" data-testid="text-provider-payment-guidance">
                    {providerPaymentGuidance(data.diagnostics)}
                  </p>
                )}
                <pre className="whitespace-pre-wrap break-words max-h-[32rem] overflow-auto font-mono" data-testid="text-failure-diagnostics">{JSON.stringify(data.diagnostics, null, 2)}</pre>
              </>}
        </div>
      )}
    </section>
  );
}

export default function ReproductionDetail() {
  const { id } = useParams<{ id: string }>();
  const [showMeta, setShowMeta] = useState(false);
  const [showLogbook, setShowLogbook] = useState(false);
  const { authenticated, user, isAdmin } = useAuth();
  const [, navigate] = useLocation();
  const [republishMessage, setRepublishMessage] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const managedConfig = useGenerationConfig();
  const [retryModelConfig, setRetryModelConfig] = useState<ModelConfig>({
    providerMode: "platform", provider: "", modelName: "",
  });
  const [retryByocApiKey, setRetryByocApiKey] = useState("");
  const retryJudgeSelection = useReproductionJudge(retryModelConfig, retryByocApiKey);
  const retryJudgeConfig = retryJudgeSelection.config;
  const retryJudgeByocApiKey = retryJudgeSelection.apiKey;

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/reproductions/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => navigate("/generate"),
  });
  const republishMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/reproductions/${id}/republish`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Republish failed");
      return body as { documentId: string; url: string };
    },
    onSuccess: (body) => setRepublishMessage(`Published. Document ID: ${body.documentId}`),
    onError: (err: any) => setRepublishMessage(`Failed: ${err?.message || "unknown error"}`),
  });
  const retryMutation = useMutation({
    mutationFn: async () => {
      const submittedByocKey = retryModelConfig.providerMode === "byok" ? retryByocApiKey : undefined;
      const submittedJudgeByocKey = retryJudgeSelection.needsSeparateKey ? retryJudgeByocApiKey : undefined;
      return postReproduction(`/api/reproductions/${id}/retry`, {
          ...reproductionModelPayload(retryModelConfig, retryJudgeConfig, submittedByocKey ?? "", submittedJudgeByocKey ?? ""),
      });
    },
    onSuccess: (retry) => navigate(`/reproductions/${retry.id}`),
    onError: (err: any) => setRetryMessage(err?.message || "Retry failed"),
    onSettled: () => {
      setRetryByocApiKey("");
      retryJudgeSelection.clearKey();
    },
  });

  const { data: run, isLoading } = useQuery<Reproduction>({
    queryKey: ["/api/reproductions", id],
    queryFn: async () => {
      const res = await fetch(`/api/reproductions/${id}`);
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && (data.status === "pending" || data.status === "generating")) return 8000;
      return false;
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <Navigation />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-muted-foreground font-mono text-sm">Loading...</p>
        </div>
        <Footer />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col">
        <Navigation />
        <div className="flex flex-col items-center justify-center gap-6 pt-28 flex-1">
          <p className="text-muted-foreground font-mono text-sm">Reproduction not found.</p>
          <Link href="/generate">
            <Button variant="outline" className="rounded-none font-mono text-xs" data-testid="button-back-generate">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Lab Dashboard
            </Button>
          </Link>
        </div>
        <Footer />
      </div>
    );
  }

  const createdDate = new Date(run.createdAt);
  const completedDate = run.completedAt ? new Date(run.completedAt) : null;
  const durationSec = completedDate ? Math.round((completedDate.getTime() - createdDate.getTime()) / 1000) : null;
  const mayRetry = authenticated && user?.id === run.userId
    && REPRODUCTION_ACCESS_EMAILS.includes(user.email || "")
    && (run.status === "failed" || (run.status === "completed" && run.overallVerdict === "inconclusive"));
  const retryModel = managedConfig.data?.platformModels.find(model => model.model === retryModelConfig.modelName);
  const retryJudge = managedConfig.data?.platformModels.find(model => model.model === retryJudgeConfig.modelName);
  const retryReproducerReady = retryModelConfig.providerMode === "byok"
    ? isByokModelSelectionReady(retryModelConfig, retryByocApiKey)
    : Boolean(retryModel && retryModel.enabled !== false && retryModel.tools);
  const retryJudgeReady = retryJudgeConfig.providerMode === "byok"
    ? isByokModelSelectionReady(retryJudgeConfig, retryJudgeByocApiKey)
    : Boolean(retryJudge && retryJudge.enabled !== false);
  const retryModesMatch = areReproductionModelModesCompatible(retryModelConfig, retryJudgeConfig);
  const retryModelsReady = retryReproducerReady && retryJudgeReady && retryModesMatch;
  let verdicts: ClaimVerdict[] = [];
  try { verdicts = JSON.parse(run.verdictsJson || "[]"); } catch {}

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6 max-w-4xl">
          <FadeIn>
            <div className="flex items-center justify-between mb-8">
              <Link href={`/projects/${run.projectId}`}>
                <Button variant="ghost" className="font-mono text-xs text-muted-foreground hover:text-foreground" data-testid="button-back">
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to Project
                </Button>
              </Link>
              {isAdmin && (
                <div className="flex items-center gap-4">
                  {run.status === "completed" && !run.publishedDocumentId && (
                    <button
                      onClick={() => { setRepublishMessage(null); republishMutation.mutate(); }}
                      disabled={republishMutation.isPending}
                      className="text-[10px] font-mono text-muted-foreground/60 hover:text-primary transition-colors flex items-center gap-1.5 disabled:opacity-40"
                      data-testid="button-admin-republish-reproduction"
                    >
                      {republishMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UploadCloud className="w-3 h-3" />}
                      Republish to Future Science (admin)
                    </button>
                  )}
                  {republishMessage && (
                    <span className="text-[10px] font-mono text-muted-foreground" data-testid="text-republish-status">{republishMessage}</span>
                  )}
                  <button
                    onClick={() => { if (confirm("Delete this reproduction? This cannot be undone.")) deleteMutation.mutate(); }}
                    disabled={deleteMutation.isPending}
                    className="text-[10px] font-mono text-muted-foreground/40 hover:text-red-400 transition-colors flex items-center gap-1.5 disabled:opacity-40"
                    data-testid="button-admin-delete-reproduction"
                  >
                    {deleteMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    Delete reproduction (admin)
                  </button>
                </div>
              )}
            </div>
          </FadeIn>

          <FadeIn delay={0.1}>
            <div className="border border-border/30 bg-muted/5 p-8 md:p-12 mb-10">
              <div className="flex items-center gap-3 mb-5 flex-wrap">
                <span className="bg-primary/20 text-primary px-3 py-1 text-xs font-mono border border-primary/30 flex items-center gap-1">
                  <FlaskConical className="w-3 h-3" /> {reproductionPersonaName(run.agentId)} Report
                </span>
                {run.status === "completed" && <span className="bg-green-500/10 text-green-400 px-2 py-0.5 text-xs font-mono">completed</span>}
                {run.status === "generating" && (
                  <span className="bg-yellow-500/10 text-yellow-400 px-2 py-0.5 text-xs font-mono flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> running
                  </span>
                )}
                {run.status === "failed" && <span className="bg-red-500/10 text-red-400 px-2 py-0.5 text-xs font-mono">failed</span>}
                <span className="bg-muted/20 text-muted-foreground px-2 py-0.5 text-xs font-mono border border-border/30 flex items-center gap-1">
                  <Cpu className="w-3 h-3" /> {run.gpu}
                </span>
              </div>

              <h1 className="text-2xl md:text-3xl font-heading font-bold tracking-tight mb-4" data-testid="text-reproduction-title">
                {(run.status === "completed" && run.reportTitle) || `Reproduction of ${run.paperTitle || run.documentId}`}
              </h1>

              {run.status === "completed" && run.reportAbstract && (
                <p className="text-sm text-muted-foreground mb-6 leading-relaxed" data-testid="text-reproduction-abstract">{run.reportAbstract}</p>
              )}

              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground font-mono">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-primary/60" />
                  <span data-testid="text-reproduction-agent">{run.orchestratorName || run.agentId} · {reproductionPersonaName(run.agentId)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-primary/60" />
                  <span>{createdDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span>
                </div>
                {durationSec !== null && (
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-primary/60" />
                    <span>{Math.round(durationSec / 60)} min run time</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground/40">Journal:</span>
                  <span>{run.journalId}</span>
                </div>
                <div className="flex items-center gap-2">
                  <a href={`https://future-science.org/${run.journalId}/${run.documentId}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1" data-testid="link-original-paper">
                    Original paper <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>
          </FadeIn>

          {run.status === "completed" && run.overallVerdict && (
            <FadeIn delay={0.15}>
              <div className={`border ${verdictStyle(run.overallVerdict)} p-6 mb-8`} data-testid="verdict-banner">
                <div className="text-xs font-mono uppercase tracking-widest mb-1">Overall Verdict</div>
                <div className="text-lg font-heading font-semibold capitalize" data-testid="text-overall-verdict">{run.overallVerdict}</div>
                <div className="text-xs font-mono mt-2 opacity-80">
                  {run.claimsCount ?? 0} result{run.claimsCount === 1 ? "" : "s"} · {run.verifiedCount ?? 0} verified · {run.falsifiedCount ?? 0} falsified · {run.toyCount ?? 0} toy · {run.inconclusiveCount ?? 0} inconclusive · {run.toolCallsCount ?? 0} tool calls
                </div>
              </div>
            </FadeIn>
          )}

          {run.status === "completed" && verdicts.length > 0 && (
            <FadeIn delay={0.2}>
              <section className="mb-10" data-testid="section-verdicts">
                <h2 className="text-lg font-heading font-semibold mb-4">Per-result verdicts</h2>
                <div className="space-y-3">
                  {verdicts.map((v) => (
                    <div key={v.id} className={`border p-4 ${verdictStyle(v.verdict)}`} data-testid={`verdict-${v.id}`}>
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <span className="text-xs font-mono uppercase tracking-widest">{v.id} — {v.verdict}</span>
                        {v.confidence && <span className="text-[10px] font-mono opacity-70">{v.confidence} confidence</span>}
                      </div>
                      <p className="text-sm text-foreground/90 mb-2">{v.claim}</p>
                      {(v.originalValue || v.reproducedValue) && (
                        <div className="grid md:grid-cols-2 gap-2 text-[11px] font-mono text-foreground/70">
                          <div><span className="opacity-60">Reported: </span>{v.originalValue || "n/a"}</div>
                          <div><span className="opacity-60">Reproduced: </span>{v.reproducedValue || "n/a"}</div>
                        </div>
                      )}
                      {v.evidence && <p className="text-[11px] font-mono text-foreground/60 mt-2">{v.evidence}</p>}
                    </div>
                  ))}
                </div>
              </section>
            </FadeIn>
          )}

          {mayRetry && (
            <FadeIn delay={0.28}>
              <section className="mb-8 border border-border/40 bg-muted/5 p-5 space-y-5" data-testid="section-retry-models">
                <div>
                  <h2 className="text-sm font-heading font-semibold">Choose models for the new run</h2>
                  <p className="mt-1 text-[10px] font-mono text-muted-foreground/60">
                    A retry is a new run using the saved {run.agentId || "P"} persona and scientific instructions. Select a managed model or provide your own provider and key for both the reproducer and judge; the original run&apos;s model history remains unchanged.
                  </p>
                </div>
                <ModelSelector
                  value={retryModelConfig}
                  onChange={setRetryModelConfig}
                  apiKey={retryByocApiKey}
                  onApiKeyChange={setRetryByocApiKey}
                  activeType="reproduction"
                  label="Replacement reproducer"
                  models={managedConfig.data?.platformModels ?? []}
                  configLoading={managedConfig.loading}
                  configError={managedConfig.error}
                  setupMessage={managedConfig.data?.setupMessage}
                  costOptions={{ judgeModelName: retryJudgeConfig.modelName }}
                  compact
                  requireExplicitSelection
                />
                <ReproductionJudgeSelector
                  selection={retryJudgeSelection}
                  activeType="judge"
                  label="Replacement judge"
                  models={managedConfig.data?.platformModels ?? []}
                  configLoading={managedConfig.loading}
                  configError={managedConfig.error}
                  setupMessage={managedConfig.data?.setupMessage}
                  compact
                  requireExplicitSelection
                />
                {!retryModesMatch && (
                  <p className="text-[10px] font-mono text-amber-200" role="alert" data-testid="text-retry-provider-mode-mismatch">
                    Reproducer and judge billing modes must match. Choose managed models for both, or your own provider for both; neither selection changes automatically.
                  </p>
                )}
                {retryModelConfig.providerMode === "byok" && retryJudgeConfig.providerMode === "byok" && retryModelConfig.provider !== retryJudgeConfig.provider && (
                  <p className="text-[10px] font-mono text-muted-foreground/70" data-testid="text-retry-judge-key-guidance">
                    The judge uses a different provider, so enter that provider&apos;s own API key in the judge selector.
                  </p>
                )}
              </section>
            </FadeIn>
          )}

          {run.agentId === "qP" && (
            <section className="mb-8 border border-border/40 p-5 space-y-3" data-testid="section-questioning-assessment">
              <h2 className="text-lg font-heading font-semibold">Suitability assessment & change provenance</h2>
              <p className="text-sm text-muted-foreground">The report distinguishes original-code reproduction from adapted analysis, explains modifications and comparability limits, and includes the independent judge’s assessment. A successful adapted run alone does not verify or falsify the original result.</p>
              {run.status === "completed" ? <ProvenanceInspector id={run.id} /> : <p className="text-xs text-muted-foreground">Structured provenance is available after a completed run.</p>}
            </section>
          )}
          <FadeIn delay={0.3}>
            {run.status === "pending" || run.status === "generating" ? (
              <ReviewProgress
                createdAt={run.createdAt}
                status={run.status}
                expectedDurationMs={90 * 60 * 1000}
                queuedLabel="Reproduction queued"
                stages={[
                  "Loading paper and supplementary materials",
                  "Booting GPU sandbox",
                  "Extracting core results",
                  "Re-running the authors' code",
                  "Judge grading the logbook",
                  "Publishing report",
                ]}
              />
            ) : run.status === "failed" ? (
              <div className="border border-red-500/20 bg-red-500/5 p-8">
                <p className="text-red-400 font-mono text-sm">Reproduction failed.</p>
                <p className="mt-4 text-sm text-red-300/70">No report was completed. Eligible institute members can retry this run.</p>
                {mayRetry && (
                  <>
                    <Button
                      onClick={() => { setRetryMessage(null); retryMutation.mutate(); }}
                      disabled={retryMutation.isPending || !retryModelsReady}
                      className="mt-6 rounded-none font-mono text-xs"
                      data-testid="button-retry-reproduction"
                    >
                      {retryMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                      {retryMutation.isPending ? "Starting retry..." : "Retry reproduction"}
                    </Button>
                    {retryMessage && <p className="mt-3 text-xs font-mono text-red-300" data-testid="text-retry-error">{retryMessage}</p>}
                  </>
                )}
              </div>
            ) : run.contentHtml ? (
              <section className="mb-10">
                <h2 className="text-lg font-heading font-semibold mb-4">Full Report</h2>
                <div className="review-content" dangerouslySetInnerHTML={{ __html: run.contentHtml }} data-testid="text-reproduction-content" />
              </section>
            ) : null}
          </FadeIn>

          {isAdmin && user && (
            <FailureDiagnostics key={`${run.id}:${user.id}`} id={run.id} adminId={user.id} />
          )}

          {run.status === "completed" && run.overallVerdict === "inconclusive"
            && mayRetry && (
            <FadeIn delay={0.31}>
              <div className="mb-10 border border-yellow-400/20 bg-yellow-400/5 p-6">
                <p className="text-sm text-yellow-200/80">
                  This reproduction was inconclusive. You can rerun it with the selected managed or own-provider models while preserving the original run&apos;s history.
                </p>
                <Button
                  onClick={() => { setRetryMessage(null); retryMutation.mutate(); }}
                  disabled={retryMutation.isPending || !retryModelsReady}
                  className="mt-4 rounded-none font-mono text-xs"
                  data-testid="button-rerun-inconclusive-reproduction"
                >
                  {retryMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                  {retryMutation.isPending ? "Starting rerun..." : "Rerun reproduction"}
                </Button>
                {retryMessage && <p className="mt-3 text-xs font-mono text-red-300" data-testid="text-rerun-error">{retryMessage}</p>}
              </div>
            </FadeIn>
          )}

          {(run.status === "completed" || run.status === "failed") && run.logbookMarkdown && (
            <FadeIn delay={0.32}>
              <div className="mb-10">
                <button
                  onClick={() => setShowLogbook(!showLogbook)}
                  className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                  data-testid="button-toggle-logbook"
                >
                  <FlaskConical className="w-3 h-3" />
                  {showLogbook ? "Hide" : "Show"} raw agent logbook
                </button>
                {showLogbook && (
                  <pre className="mt-3 p-4 bg-background border border-border/20 overflow-x-auto max-h-[32rem] text-[11px] font-mono whitespace-pre-wrap text-foreground/70" data-testid="text-logbook">
                    {run.logbookMarkdown}
                  </pre>
                )}
              </div>
            </FadeIn>
          )}

          {run.status === "completed" && (
            <FadeIn delay={0.35}>
              <div className="mt-12 border-t border-border/30 pt-6">
                <button
                  onClick={() => setShowMeta(!showMeta)}
                  className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                  data-testid="button-toggle-metadata"
                >
                  <Info className="w-3 h-3" />
                  {showMeta ? "Hide" : "Show"} generation metadata
                </button>

                {showMeta && (
                  <div className="mt-4 border border-border/20 bg-muted/5 p-5 space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-[10px] font-mono">
                      {run.modelName && <div><span className="text-muted-foreground/40 block">Reproducer model</span><span className="text-foreground/70">{run.modelName}</span></div>}
                      {run.judgeModelName && <div><span className="text-muted-foreground/40 block">Judge model</span><span className="text-foreground/70">{run.judgeModelName}</span></div>}
                      {run.modelProvider && <div><span className="text-muted-foreground/40 block">Provider</span><span className="text-foreground/70">{run.modelProvider}</span></div>}
                      {run.providerMode && <div><span className="text-muted-foreground/40 block">Mode</span><span className="text-foreground/70">{run.providerMode}</span></div>}
                      <div><span className="text-muted-foreground/40 block">GPU</span><span className="text-foreground/70">{run.gpu}</span></div>
                      {run.orchestratorName && <div><span className="text-muted-foreground/40 block">Orchestrator</span><span className="text-foreground/70">{run.orchestratorName}</span></div>}
                    </div>

                    {run.publishedDocumentId && (
                      <a href={`https://future-science.org/${run.journalId}/${run.publishedDocumentId}`} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-primary hover:underline flex items-center gap-1" data-testid="link-publication">
                        View on Future Science <ExternalLink className="w-3 h-3" />
                      </a>
                    )}

                  </div>
                )}

                <div className="mt-6 pt-4 text-center">
                  <p className="text-xs font-mono text-muted-foreground/50">
                    Generated by {run.orchestratorName || run.agentId} — Machine Institute {reproductionPersonaName(run.agentId)} ({run.agentId || "P"})
                  </p>
                </div>
              </div>
            </FadeIn>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
