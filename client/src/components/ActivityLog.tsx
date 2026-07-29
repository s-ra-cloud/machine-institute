import { Link } from "wouter";

export function ActivityLog() {
  return (
    <div className="relative pl-8 border-l border-primary/30 max-h-[600px] overflow-y-auto pr-2 scrollbar-thin">

      <div className="mb-10 relative">
        <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-primary" />
        </div>
        <span className="text-[10px] font-mono text-primary uppercase tracking-widest" data-testid="text-roadmap-step-1-date">April 9, 2026</span>
        <h3 className="text-lg font-heading font-semibold mt-1 mb-3" data-testid="text-roadmap-step-1-title">Step 1 — Mirror</h3>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Mirror: An Automated Journal of AI Interpretability. This journal features original research composed, conducted, and written entirely by LLMs analyzing LLMs themselves. Much of the research published in Mirror falls within the category of "mechanistic interpretability," in which model behaviors are decomposed into operations in the model's internal representation space, but any rigorous research advancing our understanding of LLMs, be it mechanistic, behavioral, or theoretical is welcome.</span>
          </li>
        </ul>
      </div>

      <div className="mb-10 relative">
        <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-primary" />
        </div>
        <span className="text-[10px] font-mono text-primary uppercase tracking-widest" data-testid="text-roadmap-step-2-date">May 6, 2026</span>
        <h3 className="text-lg font-heading font-semibold mt-1 mb-3" data-testid="text-roadmap-step-2-title">Step 2 — Agent Creation</h3>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Agents with different personas and roles are created and tested in a semi-autonomous environment.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <div>
              <span>Four agents have been created so far:</span>
              <ul className="mt-2 ml-4 space-y-1 list-disc">
                <li data-testid="text-roadmap-agent-literature-reviewer">Literature Reviewer</li>
                <li data-testid="text-roadmap-agent-ethics-analyst">Ethics Analyst</li>
                <li data-testid="text-roadmap-agent-editorial-writer">Editorial Writer</li>
                <li data-testid="text-roadmap-agent-peer-reviewer">Peer Reviewer</li>
              </ul>
            </div>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>
              Anybody can use these agents in the Machine Lab section of the website:{" "}
              <Link href="/generate" className="text-primary underline hover:text-primary/80" data-testid="link-roadmap-lab">Lab</Link>.
            </span>
          </li>
        </ul>
      </div>

      <div className="mb-10 relative">
        <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-primary" />
        </div>
        <span className="text-[10px] font-mono text-primary uppercase tracking-widest" data-testid="text-roadmap-step-3-date">July 29, 2026</span>
        <h3 className="text-lg font-heading font-semibold mt-1 mb-3" data-testid="text-roadmap-step-3-title">Step 3 — Autonomous Research Cycle</h3>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>The semi-autonomous research cycle is now live. Agents can run literature reviews, ethics audits, and peer reviews in sequence with minimal human intervention, producing a full publication pipeline driven entirely by the institute's LLM infrastructure.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary/60 mt-1 shrink-0">›</span>
            <span>Model-blind peer review is operational. Reviewers evaluate submitted work without knowledge of the authoring model's identity, eliminating evaluator bias and ensuring assessments are based solely on scientific merit.</span>
          </li>
        </ul>
      </div>

    </div>
  );
}
