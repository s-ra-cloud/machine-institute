import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Loader2, Download, ArrowLeft } from "lucide-react";

interface EvaluationRow {
  id: string;
  createdAt: string;
  status: string;
  journalId: string;
  documentId: string;
  paperTitle: string | null;
  persona: string;
  modelBlind: boolean;
  evaluatorModel: string | null;
  evaluatorCode: string | null;
  targetModel: string | null;
  majorRevisionsCount: number | null;
  minorRevisionsCount: number | null;
  recommendation: string | null;
  includeEthicsCoauthor: boolean;
  publishedDocumentId: string | null;
  batchId: string | null;
}

const CSV_COLUMNS: Array<{ key: keyof EvaluationRow; label: string }> = [
  { key: "createdAt", label: "Date" },
  { key: "modelBlind", label: "Model-blind" },
  { key: "evaluatorModel", label: "Evaluator model" },
  { key: "evaluatorCode", label: "Evaluator code" },
  { key: "targetModel", label: "Target model" },
  { key: "persona", label: "Persona" },
  { key: "paperTitle", label: "Target article" },
  { key: "documentId", label: "Target document ID" },
  { key: "recommendation", label: "Recommendation" },
  { key: "majorRevisionsCount", label: "Major revisions" },
  { key: "minorRevisionsCount", label: "Minor revisions" },
  { key: "includeEthicsCoauthor", label: "Ethics co-author" },
  { key: "status", label: "Status" },
  { key: "batchId", label: "Batch ID" },
  { key: "id", label: "Evaluation ID" },
];

function toCsv(rows: EvaluationRow[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = CSV_COLUMNS.map(c => esc(c.label)).join(",");
  const lines = rows.map(r => CSV_COLUMNS.map(c => esc(r[c.key])).join(","));
  return [header, ...lines].join("\n");
}

export default function EvaluationHistory() {
  const [blindFilter, setBlindFilter] = useState<string>("all");
  const [evaluatorFilter, setEvaluatorFilter] = useState<string>("all");
  const [targetFilter, setTargetFilter] = useState<string>("all");

  const { data: rows, isLoading, isError, error } = useQuery<EvaluationRow[]>({
    queryKey: ["/api/peer-reviews/evaluations"],
    queryFn: async () => {
      const res = await fetch("/api/peer-reviews/evaluations", { credentials: "include" });
      if (res.status === 401) throw new Error("unauthorized");
      if (!res.ok) throw new Error("Failed to load evaluation history");
      return res.json();
    },
    retry: (count, err) => (err as Error).message !== "unauthorized" && count < 2,
  });
  const isUnauthorized = isError && (error as Error)?.message === "unauthorized";

  const evaluatorModels = useMemo(() => Array.from(new Set((rows || []).map(r => r.evaluatorModel).filter(Boolean))) as string[], [rows]);
  const targetModels = useMemo(() => Array.from(new Set((rows || []).map(r => r.targetModel || "(unknown)"))), [rows]);

  const filtered = useMemo(() => (rows || []).filter(r => {
    if (blindFilter === "blind" && !r.modelBlind) return false;
    if (blindFilter === "non-blind" && r.modelBlind) return false;
    if (evaluatorFilter !== "all" && r.evaluatorModel !== evaluatorFilter) return false;
    if (targetFilter !== "all" && (r.targetModel || "(unknown)") !== targetFilter) return false;
    return true;
  }), [rows, blindFilter, evaluatorFilter, targetFilter]);

  // Model-pairing summary: evaluator model x target model counts + revision totals.
  const pairings = useMemo(() => {
    const map = new Map<string, { evaluator: string; target: string; count: number; major: number; minor: number }>();
    for (const r of filtered) {
      if (r.status !== "completed") continue;
      const evaluator = r.evaluatorModel || "(unknown)";
      const target = r.targetModel || "(unknown)";
      const key = `${evaluator}→${target}`;
      const entry = map.get(key) || { evaluator, target, count: 0, major: 0, minor: 0 };
      entry.count += 1;
      entry.major += r.majorRevisionsCount || 0;
      entry.minor += r.minorRevisionsCount || 0;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [filtered]);

  const exportCsv = () => {
    const blob = new Blob([toCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `evaluations-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectCls = "bg-background border border-border/50 px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-primary/50";

  return (
    <div className="min-h-screen bg-background text-foreground px-6 py-10 max-w-7xl mx-auto">
      <Link href="/generate" className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors mb-6">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to the Lab
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-4 mb-2">
        <h1 className="text-3xl font-heading font-semibold">Evaluation History</h1>
        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="flex items-center gap-2 px-4 py-2 border border-border/50 text-xs font-mono hover:border-primary/50 transition-colors disabled:opacity-40"
          data-testid="button-export-csv"
        >
          <Download className="w-3.5 h-3.5" /> Export CSV ({filtered.length})
        </button>
      </div>
      <p className="text-sm text-muted-foreground mb-6 max-w-3xl">
        Every evaluation produced by the peer-review system and the semi-autonomous cycle, with its
        model-blind status, evaluator and target models, configuration code, and requested revisions —
        for comparative analysis across model pairings and review configurations.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-6" data-testid="section-evaluation-filters">
        <select value={blindFilter} onChange={e => setBlindFilter(e.target.value)} className={selectCls} data-testid="select-filter-blind">
          <option value="all">Blind + non-blind</option>
          <option value="blind">Model-blind only</option>
          <option value="non-blind">Non-blind only</option>
        </select>
        <select value={evaluatorFilter} onChange={e => setEvaluatorFilter(e.target.value)} className={selectCls} data-testid="select-filter-evaluator">
          <option value="all">All evaluator models</option>
          {evaluatorModels.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={targetFilter} onChange={e => setTargetFilter(e.target.value)} className={selectCls} data-testid="select-filter-target">
          <option value="all">All target models</option>
          {targetModels.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground py-12">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading evaluations…
        </div>
      )}
      {isUnauthorized && (
        <p className="text-sm font-mono text-muted-foreground py-12" data-testid="text-evaluations-signin">
          Evaluation analysis data is restricted — please sign in to view it.
        </p>
      )}
      {isError && !isUnauthorized && <p className="text-sm font-mono text-red-400 py-12">Couldn't load the evaluation history.</p>}

      {!isLoading && !isError && (
        <>
          {pairings.length > 0 && (
            <div className="mb-8">
              <h2 className="text-sm font-mono uppercase tracking-widest text-muted-foreground mb-3">Model pairings (completed evaluations)</h2>
              <div className="overflow-x-auto border border-border/40">
                <table className="w-full text-xs font-mono" data-testid="table-model-pairings">
                  <thead>
                    <tr className="border-b border-border/40 text-left text-muted-foreground/70">
                      <th className="px-3 py-2">Evaluator model</th>
                      <th className="px-3 py-2">Target model</th>
                      <th className="px-3 py-2 text-right">Evaluations</th>
                      <th className="px-3 py-2 text-right">Major revisions</th>
                      <th className="px-3 py-2 text-right">Minor revisions</th>
                      <th className="px-3 py-2 text-right">Avg major / eval</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pairings.map(p => (
                      <tr key={`${p.evaluator}→${p.target}`} className="border-b border-border/20 last:border-b-0">
                        <td className="px-3 py-2">{p.evaluator}</td>
                        <td className="px-3 py-2">{p.target}</td>
                        <td className="px-3 py-2 text-right">{p.count}</td>
                        <td className="px-3 py-2 text-right">{p.major}</td>
                        <td className="px-3 py-2 text-right">{p.minor}</td>
                        <td className="px-3 py-2 text-right">{(p.major / p.count).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="overflow-x-auto border border-border/40">
            <table className="w-full text-xs font-mono" data-testid="table-evaluations">
              <thead>
                <tr className="border-b border-border/40 text-left text-muted-foreground/70">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Blind</th>
                  <th className="px-3 py-2">Evaluator model</th>
                  <th className="px-3 py-2">Evaluator code</th>
                  <th className="px-3 py-2">Target model</th>
                  <th className="px-3 py-2">Target article</th>
                  <th className="px-3 py-2">Recommendation</th>
                  <th className="px-3 py-2 text-right">Major</th>
                  <th className="px-3 py-2 text-right">Minor</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={10} className="px-3 py-6 text-muted-foreground/60">No evaluations match these filters yet.</td></tr>
                )}
                {filtered.map(r => (
                  <tr key={r.id} className="border-b border-border/20 last:border-b-0 hover:bg-muted/10" data-testid={`row-evaluation-${r.id}`}>
                    <td className="px-3 py-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleDateString()}</td>
                    <td className="px-3 py-2">{r.modelBlind ? <span className="text-yellow-400">MB</span> : "—"}</td>
                    <td className="px-3 py-2">{r.evaluatorModel || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.evaluatorCode || "—"}</td>
                    <td className="px-3 py-2">{r.targetModel || <span className="text-muted-foreground/50">(unknown)</span>}</td>
                    <td className="px-3 py-2 max-w-[280px]">
                      <Link href={`/peer-reviews/${r.id}`} className="text-primary hover:underline underline-offset-2 line-clamp-2">
                        {r.paperTitle || r.documentId}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{r.recommendation || "—"}</td>
                    <td className="px-3 py-2 text-right">{r.majorRevisionsCount ?? "—"}</td>
                    <td className="px-3 py-2 text-right">{r.minorRevisionsCount ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span className={r.status === "completed" ? "text-green-400" : r.status === "failed" ? "text-red-400" : "text-muted-foreground/70"}>
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
