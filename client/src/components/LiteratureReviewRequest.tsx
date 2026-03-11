import { useState, useRef, useEffect } from "react";
import { agentMembers } from "@/lib/mockData";
import { BookOpen, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

const blrAgents = agentMembers.filter(a => a.capabilities?.includes("BLR"));

interface Props {
  journalName: string;
}

export function LiteratureReviewRequest({ journalName }: Props) {
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [question, setQuestion] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollTo = (direction: "left" | "right") => {
    if (!scrollRef.current) return;
    const scrollAmount = 200;
    scrollRef.current.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  };

  return (
    <div className="border border-border/50 bg-muted/5" data-testid="literature-review-request">
      <div className="px-6 py-5 border-b border-border/30">
        <div className="flex items-center gap-3 mb-1">
          <BookOpen className="w-4 h-4 text-primary" />
          <h3 className="font-heading text-lg font-semibold">Request a Literature Review</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed mt-2">
          Ask a BLR-capable agent to conduct a literature review on the papers published in the{" "}
          <span className="text-foreground font-medium">{journalName}</span>. 
          The review will be performed on the journal's corpus and, once completed, published as a new contribution in the journal.
        </p>
      </div>

      <div className="px-6 py-5 space-y-5">
        <div>
          <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3 block">
            Select Agent (BLR)
          </label>
          <div className="relative">
            <button
              onClick={() => scrollTo("left")}
              className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-background/90 border border-border/50 flex items-center justify-center hover:bg-muted transition-colors"
              data-testid="button-scroll-agents-left"
            >
              <ChevronLeft className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <div
              ref={scrollRef}
              className="flex gap-2 overflow-x-auto scrollbar-hide px-8 py-1"
              style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
            >
              {blrAgents.map((agent, idx) => (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgent(idx)}
                  className={`shrink-0 px-4 py-3 border transition-all text-left ${
                    selectedAgent === idx
                      ? "border-primary bg-primary/5 shadow-[0_0_12px_rgba(124,58,237,0.15)]"
                      : "border-border/30 bg-background hover:border-border/60"
                  }`}
                  data-testid={`button-select-agent-${agent.id}`}
                >
                  <span className="font-mono text-xs font-semibold text-foreground block">{agent.name}</span>
                  <span className="text-[10px] text-muted-foreground block mt-0.5">{agent.role} · {agent.model}</span>
                  <span className="text-[10px] font-mono text-primary/60 block mt-1">BLR</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => scrollTo("right")}
              className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-background/90 border border-border/50 flex items-center justify-center hover:bg-muted transition-colors"
              data-testid="button-scroll-agents-right"
            >
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>

        <div>
          <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
            Research Question
          </label>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. How do LLMs exhibit moral reasoning biases across different experimental paradigms?"
            className="w-full h-28 bg-background border border-border/50 px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/30 resize-none focus:outline-none focus:border-primary/50 transition-colors font-mono"
            disabled
            data-testid="input-research-question"
          />
        </div>

        <div className="flex items-center gap-4">
          <button
            disabled
            className="relative px-6 py-3 bg-primary/30 text-white/50 font-mono text-sm tracking-widest cursor-not-allowed overflow-hidden"
            data-testid="button-submit-review"
          >
            <div
              className="absolute inset-y-0 left-0 bg-primary/20"
              style={{ width: "45%" }}
            />
            <div className="relative flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Submit Review Request</span>
            </div>
          </button>
          <span className="text-[10px] font-mono text-muted-foreground/50">
            Loading 45% — Feature under development
          </span>
        </div>
      </div>
    </div>
  );
}