import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, Link, useLocation } from "wouter";
import { ArrowLeft, Loader2, Calendar, Bot, Clock, Info, ExternalLink, Trash2, UploadCloud, FlaskConical, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeIn } from "@/components/ui/motion";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { ReviewProgress } from "@/components/ReviewProgress";
import { useAuth } from "@/lib/auth";
import type { Reproduction } from "@shared/schema";

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

export function verdictStyle(verdict: string | null | undefined): string {
  return VERDICT_STYLES[verdict || ""] || "text-muted-foreground border-border/30 bg-muted/5";
}

export default function ReproductionDetail() {
  const { id } = useParams<{ id: string }>();
  const [showMeta, setShowMeta] = useState(false);
  const [showLogbook, setShowLogbook] = useState(false);
  const { isAdmin } = useAuth();
  const [, navigate] = useLocation();
  const [republishMessage, setRepublishMessage] = useState<string | null>(null);

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
                  <FlaskConical className="w-3 h-3" /> Reproduction Report
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
                {run.reportTitle || `Reproduction of ${run.paperTitle || run.documentId}`}
              </h1>

              {run.reportAbstract && (
                <p className="text-sm text-muted-foreground mb-6 leading-relaxed" data-testid="text-reproduction-abstract">{run.reportAbstract}</p>
              )}

              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground font-mono">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-primary/60" />
                  <span data-testid="text-reproduction-agent">{run.orchestratorName || run.agentId}</span>
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
                {run.contentHtml && <div className="mt-4 text-sm text-red-300/70" dangerouslySetInnerHTML={{ __html: run.contentHtml }} />}
              </div>
            ) : run.contentHtml ? (
              <section className="mb-10">
                <h2 className="text-lg font-heading font-semibold mb-4">Full Report</h2>
                <div className="review-content" dangerouslySetInnerHTML={{ __html: run.contentHtml }} data-testid="text-reproduction-content" />
              </section>
            ) : null}
          </FadeIn>

          {run.status === "completed" && run.logbookMarkdown && (
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
                      {run.sandboxId && <div><span className="text-muted-foreground/40 block">Sandbox</span><span className="text-foreground/70">{run.sandboxId}</span></div>}
                      {run.orchestratorName && <div><span className="text-muted-foreground/40 block">Orchestrator</span><span className="text-foreground/70">{run.orchestratorName}</span></div>}
                    </div>

                    {run.publishedDocumentId && (
                      <a href={`https://future-science.org/${run.journalId}/${run.publishedDocumentId}`} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-primary hover:underline flex items-center gap-1" data-testid="link-publication">
                        View on Future Science <ExternalLink className="w-3 h-3" />
                      </a>
                    )}

                    {[["Prompt trace", run.promptTrace], ["Source trace", run.sourceTrace]].map(([label, raw]) => {
                      if (!raw) return null;
                      try {
                        const data = JSON.parse(raw as string);
                        return (
                          <details key={label as string} className="text-[10px] font-mono text-foreground/50">
                            <summary className="cursor-pointer hover:text-foreground/70">{label}</summary>
                            <pre className="mt-2 p-3 bg-background border border-border/20 overflow-x-auto max-h-72 text-[9px] whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>
                          </details>
                        );
                      } catch { return null; }
                    })}
                  </div>
                )}

                <div className="mt-6 pt-4 text-center">
                  <p className="text-xs font-mono text-muted-foreground/50">
                    Generated by {run.orchestratorName || run.agentId} — Machine Institute Reproduction Agent (P)
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
