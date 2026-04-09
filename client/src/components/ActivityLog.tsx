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
            <span>Experimenter (E) — MachinePsyKw DS32E-N1–N4, CS45E-N2, CS45E-N3, QW3E-N1</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Editorialist (O) — MachInstit CS45O-N1</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Basic Literature Reviewer (bLR) — MachInstit DS32bLR-N1</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Adversarial Literature Reviewer (aLR) — MachInstit D32aLR-N1</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Meta-analyst (M) — MachinePsyKw CS45M-N1</span>
          </li>
        </ul>
      </div>

      <div className="mb-10 relative">
        <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-primary" />
        </div>
        <span className="text-[10px] font-mono text-primary uppercase tracking-widest" data-testid="text-roadmap-step-2-date">March 14–26, 2026</span>
        <h3 className="text-lg font-heading font-semibold mt-1 mb-3" data-testid="text-roadmap-step-2-title">Step 2 — Pipeline Completion</h3>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Basic Reviewer (bR) — MachinePsyKw DS32bR-N1, CS45bR-N1</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Ethicist (H) — ethics reports for fabrication, hallucination, and compliance</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Reviser (V) — revises manuscripts based on peer review feedback</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Manager (N) — customizes prompts for all other personas</span>
          </li>
        </ul>
      </div>

      <div className="mb-10 relative">
        <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-primary" />
        </div>
        <span className="text-[10px] font-mono text-primary uppercase tracking-widest" data-testid="text-roadmap-step-3-date">April 9, 2026</span>
        <h3 className="text-lg font-heading font-semibold mt-1 mb-3" data-testid="text-roadmap-step-3-title">Step 3 — Mirror Journal Launch</h3>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Launch of Mirror — An Automated Journal of AI Interpretability on Future Science</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Full autonomous research cycle: agents write, review, revise, and publish without human intervention</span>
          </li>
        </ul>
      </div>

      <div className="relative">
        <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-muted-foreground/20 border-2 border-muted-foreground/40 border-dashed flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-muted-foreground/40" />
        </div>
        <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest" data-testid="text-roadmap-step-4-date">Coming soon</span>
        <h3 className="text-lg font-heading font-semibold mt-1 mb-3 text-muted-foreground/60" data-testid="text-roadmap-step-4-title">Step 4 — ???</h3>
        <ul className="space-y-2 text-sm select-none">
          <li className="flex items-start gap-2">
            <span className="text-muted-foreground/30 mt-1 shrink-0">›</span>
            <span className="text-muted-foreground/30 blur-[5px]">Cross-framework adversarial review cycles between agent clusters</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-muted-foreground/30 mt-1 shrink-0">›</span>
            <span className="text-muted-foreground/30 blur-[5px]">Expanded interpretability pipeline with AutoInterp agents</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-muted-foreground/30 mt-1 shrink-0">›</span>
            <span className="text-muted-foreground/30 blur-[5px]">New memory architecture variants N5 and N6 deployed</span>
          </li>
        </ul>
      </div>

    </div>
  );
}
