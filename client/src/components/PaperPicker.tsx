import type { ReactNode } from "react";
import { Lock } from "lucide-react";

export interface PickerPaper {
  documentId: string;
  title: string;
  authors: string;
  date: string;
}

interface Props<P extends PickerPaper> {
  papers: P[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  selectedDocId: string;
  selectedTitle: string;
  onSelect: (paper: P) => void;
  isLocked: (paper: P) => boolean;
  lockLabel: ReactNode;
  renderBadges?: (paper: P) => ReactNode;
  hint: ReactNode;
  testIdPrefix: string;
}

// Searchable single-paper picker over a journal catalogue, shared by the
// single-paper agents (peer review, reproduction). Lock semantics are supplied
// by the caller so each agent keeps its own "already done" rule.
export function PaperPicker<P extends PickerPaper>({
  papers, loading, error, onRetry, query, onQueryChange,
  selectedDocId, selectedTitle, onSelect, isLocked, lockLabel, renderBadges, hint, testIdPrefix,
}: Props<P>) {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? papers.filter(p => p.title.toLowerCase().includes(q) || (p.authors || "").toLowerCase().includes(q))
    : papers;

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search papers by title or author..."
        className="w-full bg-background border border-border/50 px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-primary/50"
        data-testid={`input-${testIdPrefix}-paper-search`}
      />
      {loading && (
        <div className="space-y-1.5" data-testid={`progress-${testIdPrefix}-papers`}>
          <div className="h-1 w-full bg-border/30 progress-indeterminate" />
          <p className="text-[10px] font-mono text-muted-foreground/50">
            Loading the Mirror catalogue from Future Science… this can take up to a minute.
          </p>
        </div>
      )}
      <div className="border border-border/40 max-h-72 overflow-y-auto" data-testid={`list-${testIdPrefix}-available-papers`}>
        {filtered.length === 0 && (
          <p className="text-xs font-mono text-muted-foreground/50 p-4">
            {loading ? (
              "Loading available papers…"
            ) : error ? (
              <span>
                Couldn't load papers from Future Science.{" "}
                <button type="button" onClick={onRetry} className="text-primary underline underline-offset-2" data-testid={`button-retry-${testIdPrefix}-papers`}>
                  Retry
                </button>
              </span>
            ) : papers.length === 0 ? (
              "No papers available for this journal yet."
            ) : (
              "No papers match this search."
            )}
          </p>
        )}
        {filtered.map((p) => {
          const isSelected = p.documentId === selectedDocId;
          const locked = isLocked(p);
          return (
            <button
              key={p.documentId}
              onClick={() => { if (!locked) onSelect(p); }}
              disabled={locked}
              className={`w-full text-left px-4 py-3 border-b border-border/20 last:border-b-0 transition-colors ${
                isSelected ? "bg-primary/15 border-l-2 border-l-primary" : locked ? "bg-muted/10 opacity-50 cursor-not-allowed" : "hover:bg-muted/10 cursor-pointer"
              }`}
              data-testid={`${testIdPrefix}-paper-option-${p.documentId}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground/90 truncate">{p.title}</p>
                  <p className="text-[10px] font-mono text-muted-foreground/60 mt-1 truncate">
                    {p.authors || "(unknown)"} · {p.date}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {renderBadges?.(p)}
                  {locked && (
                    <span className="text-[9px] font-mono text-yellow-400/80 border border-yellow-400/30 px-2 py-0.5 flex items-center gap-1">
                      <Lock className="w-3 h-3" /> {lockLabel}
                    </span>
                  )}
                  {isSelected && !locked && (
                    <span className="text-[9px] font-mono text-primary border border-primary/40 px-2 py-0.5">Selected</span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-[10px] font-mono text-muted-foreground/50">{hint}</p>
      {selectedDocId && (
        <div className="border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-mono" data-testid={`text-${testIdPrefix}-selected-paper`}>
          <span className="text-muted-foreground/60">Selected: </span>
          <span className="text-foreground/90">{selectedTitle || selectedDocId}</span>
        </div>
      )}
    </div>
  );
}
