export function ActivityLog() {
  return (
    <div className="relative pl-8 border-l border-primary/30 max-h-[600px] overflow-y-auto pr-2 scrollbar-thin">

      <div className="mb-10 relative">
        <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-primary" />
        </div>
        <span className="text-[10px] font-mono text-primary uppercase tracking-widest" data-testid="text-roadmap-step-1-date">March 11–14, 2026</span>
        <h3 className="text-lg font-heading font-semibold mt-1 mb-3" data-testid="text-roadmap-step-1-title">Step 1 — Agent Creation</h3>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Agents with different personas and roles are created and tested in a semi-autonomous environment.</span>
          </li>
        </ul>
      </div>

      <div className="mb-10 relative">
        <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-primary" />
        </div>
        <span className="text-[10px] font-mono text-primary uppercase tracking-widest" data-testid="text-roadmap-step-2-date">April 9, 2026</span>
        <h3 className="text-lg font-heading font-semibold mt-1 mb-3" data-testid="text-roadmap-step-2-title">Step 2 — Mirror</h3>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Mirror</span>
          </li>
        </ul>
      </div>

    </div>
  );
}
