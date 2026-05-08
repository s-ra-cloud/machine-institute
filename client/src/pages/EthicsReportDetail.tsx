import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, Link, useLocation } from "wouter";
import { ArrowLeft, Loader2, Calendar, Bot, Clock, Info, ExternalLink, AlertTriangle, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeIn } from "@/components/ui/motion";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { useAuth } from "@/lib/auth";
import type { EthicsReport } from "@shared/schema";

export default function EthicsReportDetail() {
  const { id } = useParams<{ id: string }>();
  const [showMeta, setShowMeta] = useState(false);
  const { isAdmin } = useAuth();
  const [, navigate] = useLocation();
  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/ethics-reports/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => navigate("/generate"),
  });

  const { data: report, isLoading } = useQuery<EthicsReport>({
    queryKey: ["/api/ethics-reports", id],
    queryFn: async () => {
      const res = await fetch(`/api/ethics-reports/${id}`);
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && (data.status === "pending" || data.status === "generating")) return 5000;
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

  if (!report) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col">
        <Navigation />
        <div className="flex flex-col items-center justify-center gap-6 pt-28 flex-1">
          <p className="text-muted-foreground font-mono text-sm">Ethics report not found.</p>
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

  const createdDate = new Date(report.createdAt);
  const completedDate = report.completedAt ? new Date(report.completedAt) : null;
  const durationSec = completedDate ? Math.round((completedDate.getTime() - createdDate.getTime()) / 1000) : null;

  interface EthicsFlag { severity: string; summary: string }
  function parseFlags(raw: string | null): EthicsFlag[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((f): f is { severity?: unknown; summary?: unknown } => f !== null && typeof f === "object")
        .map((f) => ({
          severity: typeof f.severity === "string" ? f.severity : "MINOR",
          summary: typeof f.summary === "string" ? f.summary : "",
        }))
        .filter((f) => f.summary.length > 0);
    } catch (err) {
      console.warn("Failed to parse ethics flagsJson:", err);
      return [];
    }
  }
  function parseRecommendations(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
    } catch (err) {
      console.warn("Failed to parse ethics recommendationsJson:", err);
      return [];
    }
  }
  const flagsList: EthicsFlag[] = parseFlags(report.flagsJson);
  const recommendations: string[] = parseRecommendations(report.recommendationsJson);

  const clearance = report.clearanceStatus || "";
  const clearanceNorm = clearance.toLowerCase();
  const isCleared = clearanceNorm === "cleared";
  const isBlocked = clearanceNorm === "not_cleared" || clearanceNorm === "blocked";
  const ClearanceIcon = isCleared ? ShieldCheck : isBlocked ? ShieldAlert : AlertTriangle;
  const clearanceColor = isCleared ? "text-green-400 border-green-400/30 bg-green-400/5"
    : isBlocked ? "text-red-400 border-red-400/30 bg-red-400/5"
    : "text-yellow-400 border-yellow-400/30 bg-yellow-400/5";

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6 max-w-4xl">
          <FadeIn>
            <div className="flex items-center justify-between mb-8">
              <Link href={`/projects/${report.projectId}`}>
                <Button variant="ghost" className="font-mono text-xs text-muted-foreground hover:text-foreground" data-testid="button-back">
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to Project
                </Button>
              </Link>
              {isAdmin && (
                <button
                  onClick={() => {
                    if (confirm("Delete this ethics report? The associated paper will become re-auditable. This cannot be undone.")) {
                      deleteMutation.mutate();
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  className="text-[10px] font-mono text-muted-foreground/40 hover:text-red-400 transition-colors flex items-center gap-1.5 disabled:opacity-40"
                  data-testid="button-admin-delete-report"
                >
                  {deleteMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                  Delete report (admin)
                </button>
              )}
            </div>
          </FadeIn>

          <FadeIn delay={0.1}>
            <div className="border border-border/30 bg-muted/5 p-8 md:p-12 mb-10">
              <div className="flex items-center gap-3 mb-5 flex-wrap">
                <span className="bg-primary/20 text-primary px-3 py-1 text-xs font-mono border border-primary/30 flex items-center gap-1">
                  <Info className="w-3 h-3" /> Field Ethics Report
                </span>
                {report.status === "completed" && (
                  <span className="bg-green-500/10 text-green-400 px-2 py-0.5 text-xs font-mono">completed</span>
                )}
                {report.status === "generating" && (
                  <span className="bg-yellow-500/10 text-yellow-400 px-2 py-0.5 text-xs font-mono flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> generating
                  </span>
                )}
                {report.status === "failed" && (
                  <span className="bg-red-500/10 text-red-400 px-2 py-0.5 text-xs font-mono">failed</span>
                )}
              </div>

              <h1 className="text-2xl md:text-3xl font-heading font-bold tracking-tight mb-4" data-testid="text-report-title">
                {report.reportTitle || report.researchQuestion}
              </h1>

              {report.reportAbstract && (
                <p className="text-sm text-muted-foreground mb-6 leading-relaxed" data-testid="text-report-abstract">
                  {report.reportAbstract}
                </p>
              )}

              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground font-mono">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-primary/60" />
                  <span data-testid="text-report-agent">{report.agentId}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-primary/60" />
                  <span>{createdDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span>
                </div>
                {durationSec !== null && (
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-primary/60" />
                    <span>{durationSec}s generation time</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground/40">Journal:</span>
                  <span>{report.journalId}</span>
                </div>
              </div>

              {report.keywords && report.keywords.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {report.keywords.map((k, i) => (
                    <span key={i} className="text-[10px] font-mono text-muted-foreground border border-border/30 px-2 py-0.5">{k}</span>
                  ))}
                </div>
              )}
            </div>
          </FadeIn>

          {report.status === "completed" && clearance && (
            <FadeIn delay={0.15}>
              <div className={`border ${clearanceColor} p-6 mb-8 flex items-start gap-4`} data-testid="clearance-banner">
                <ClearanceIcon className="w-6 h-6 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-mono uppercase tracking-widest mb-1">
                    Clearance: {clearance.replace(/_/g, " ")}
                  </div>
                  {report.clearanceStatement && (
                    <p className="text-sm leading-relaxed" data-testid="text-clearance-statement">{report.clearanceStatement}</p>
                  )}
                </div>
              </div>
            </FadeIn>
          )}

          {report.status === "completed" && flagsList.length > 0 && (() => {
            const SEVERITY_ORDER: Array<"CRITICAL" | "MAJOR" | "MINOR"> = ["CRITICAL", "MAJOR", "MINOR"];
            const severityColors: Record<string, string> = {
              CRITICAL: "text-red-400 border-red-400/40",
              MAJOR: "text-orange-400 border-orange-400/40",
              MINOR: "text-yellow-400 border-yellow-400/40",
            };
            const grouped = SEVERITY_ORDER.map(sev => ({
              sev,
              items: flagsList.filter(f => (f.severity || "").toUpperCase() === sev),
            })).filter(g => g.items.length > 0);
            return (
              <FadeIn delay={0.2}>
                <section className="mb-10">
                  <h2 className="text-lg font-heading font-semibold mb-4 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-yellow-400" /> Consolidated Flags ({flagsList.length})
                  </h2>
                  <div className="space-y-6">
                    {grouped.map(group => (
                      <div key={group.sev} data-testid={`flag-group-${group.sev.toLowerCase()}`}>
                        <h3 className={`text-xs font-mono uppercase tracking-widest mb-2 ${severityColors[group.sev]?.split(" ")[0] || ""}`}>
                          {group.sev} ({group.items.length})
                        </h3>
                        <div className="space-y-2">
                          {group.items.map((f, i) => (
                            <div
                              key={`${group.sev}-${i}`}
                              className={`border ${severityColors[group.sev] || "border-border/30"} bg-muted/5 p-4`}
                              data-testid={`flag-${group.sev.toLowerCase()}-${i}`}
                            >
                              <p className="text-sm leading-relaxed" data-testid={`flag-summary-${group.sev.toLowerCase()}-${i}`}>
                                {f.summary || "(no summary extracted)"}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </FadeIn>
            );
          })()}

          {report.status === "completed" && recommendations.length > 0 && (
            <FadeIn delay={0.25}>
              <section className="mb-10">
                <h2 className="text-lg font-heading font-semibold mb-4">Recommendations</h2>
                <ul className="space-y-2 list-disc list-inside text-sm" data-testid="recommendations-list">
                  {recommendations.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </section>
            </FadeIn>
          )}

          <FadeIn delay={0.3}>
            {report.status === "pending" || report.status === "generating" ? (
              <div className="border border-border/30 bg-muted/5 p-12 text-center">
                <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
                <p className="text-muted-foreground font-mono text-sm mb-2">
                  Running 3-part chain-of-prompts ethics audit...
                </p>
                <p className="text-muted-foreground/50 text-xs">This page refreshes automatically.</p>
              </div>
            ) : report.status === "failed" ? (
              <div className="border border-red-500/20 bg-red-500/5 p-8">
                <p className="text-red-400 font-mono text-sm">Generation failed.</p>
                {report.contentHtml && (
                  <div className="mt-4 text-sm text-red-300/70" dangerouslySetInnerHTML={{ __html: report.contentHtml }} />
                )}
              </div>
            ) : report.contentHtml ? (
              <section className="mb-10">
                <h2 className="text-lg font-heading font-semibold mb-4">Full Report</h2>
                <div
                  className="review-content"
                  dangerouslySetInnerHTML={{ __html: report.contentHtml }}
                  data-testid="text-report-content"
                />
              </section>
            ) : null}
          </FadeIn>

          {report.status === "completed" && (
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
                      {report.modelName && (
                        <div><span className="text-muted-foreground/40 block">Model</span><span className="text-foreground/70">{report.modelName}</span></div>
                      )}
                      {report.modelProvider && (
                        <div><span className="text-muted-foreground/40 block">Provider</span><span className="text-foreground/70">{report.modelProvider}</span></div>
                      )}
                      {report.providerMode && (
                        <div><span className="text-muted-foreground/40 block">Mode</span><span className="text-foreground/70">{report.providerMode}</span></div>
                      )}
                      {report.orchestratorName && (
                        <div><span className="text-muted-foreground/40 block">Orchestrator</span><span className="text-foreground/70">{report.orchestratorName}</span></div>
                      )}
                    </div>

                    {report.publishedDocumentId && (
                      <div>
                        <a
                          href={`https://future-science.org/mirror/${report.publishedDocumentId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-mono text-primary hover:underline flex items-center gap-1"
                          data-testid="link-publication"
                        >
                          View on Future Science <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}

                    {report.promptTrace && (() => {
                      try {
                        const data = JSON.parse(report.promptTrace);
                        return (
                          <details className="text-[10px] font-mono text-foreground/50">
                            <summary className="cursor-pointer hover:text-foreground/70">Prompt trace (Part 1, 2, 3)</summary>
                            <pre className="mt-2 p-3 bg-background border border-border/20 overflow-x-auto max-h-72 text-[9px] whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>
                          </details>
                        );
                      } catch { return null; }
                    })()}

                    {report.sourceTrace && (() => {
                      try {
                        const data = JSON.parse(report.sourceTrace);
                        return (
                          <details className="text-[10px] font-mono text-foreground/50">
                            <summary className="cursor-pointer hover:text-foreground/70">Source trace</summary>
                            <pre className="mt-2 p-3 bg-background border border-border/20 overflow-x-auto max-h-72 text-[9px] whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>
                          </details>
                        );
                      } catch { return null; }
                    })()}
                  </div>
                )}

                <div className="mt-6 pt-4 text-center">
                  <p className="text-xs font-mono text-muted-foreground/50">
                    Generated by {report.agentId} — Machine Institute Field Ethics Audit
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
