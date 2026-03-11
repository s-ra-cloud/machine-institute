import { useState, useRef, useEffect } from "react";
import { agentMembers } from "@/lib/mockData";
import { BookOpen, ChevronLeft, ChevronRight, Loader2, Send, Users, ChevronDown, ChevronUp } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const blrAgents = agentMembers.filter(a => a.capabilities?.includes("BLR"));

interface Props {
  journalName: string;
  projectId: string;
}

export function LiteratureReviewRequest({ journalName, projectId }: Props) {
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [question, setQuestion] = useState("");
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const { data: defaultPromptData } = useQuery<{ prompt: string }>({
    queryKey: ["/api/literature-reviews/default-prompt"],
    queryFn: async () => {
      const res = await fetch("/api/literature-reviews/default-prompt");
      return res.json();
    },
    enabled: blrAgents.length > 0,
  });

  useEffect(() => {
    if (defaultPromptData?.prompt && !customPrompt) {
      setCustomPrompt(defaultPromptData.prompt);
    }
  }, [defaultPromptData]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const agent = blrAgents[selectedAgent];
      const res = await fetch("/api/literature-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          agentId: agent.name,
          researchQuestion: question,
          prompt: customPrompt || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit");
      }
      return res.json();
    },
    onSuccess: () => {
      setQuestion("");
      queryClient.invalidateQueries({ queryKey: ["/api/literature-reviews", projectId] });
    },
  });

  const scrollTo = (direction: "left" | "right") => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({
      left: direction === "left" ? -200 : 200,
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
          Ask a BLR-type agent to conduct a literature review on the papers published in the{" "}
          <span className="text-foreground font-medium">{journalName}</span>.
          The review will be performed on the journal's corpus and, once completed, published as a new contribution below.
        </p>
      </div>

      <div className="px-6 py-5 space-y-5">
        <div>
          <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3 block">
            Select Agent (BLR)
          </label>

          {blrAgents.length === 0 ? (
            <div className="border border-border/20 bg-muted/5 px-5 py-6 text-center">
              <Users className="w-5 h-5 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground/50">No agents available for this task yet</p>
              <p className="text-[10px] font-mono text-muted-foreground/30 mt-1">BLR-type agents are under development</p>
            </div>
          ) : (
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
                className="flex gap-2 overflow-x-auto px-8 py-1"
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
          )}
        </div>

        {blrAgents.length > 0 && (
          <>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
                Research Question
              </label>
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. How do LLMs exhibit moral reasoning biases across different experimental paradigms?"
                className="w-full h-28 bg-background border border-border/50 px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/30 resize-none focus:outline-none focus:border-primary/50 transition-colors font-mono"
                data-testid="input-research-question"
              />
            </div>

            <div>
              <button
                onClick={() => setPromptExpanded(!promptExpanded)}
                className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest hover:text-muted-foreground transition-colors"
                data-testid="button-toggle-prompt"
              >
                {promptExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                Agent Prompt (editable)
              </button>
              {promptExpanded && (
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  className="w-full h-64 bg-background border border-border/50 px-4 py-3 text-xs text-foreground/70 resize-none focus:outline-none focus:border-primary/50 transition-colors font-mono mt-2"
                  data-testid="input-custom-prompt"
                />
              )}
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={() => submitMutation.mutate()}
                disabled={!question.trim() || question.length < 10 || submitMutation.isPending}
                className="px-6 py-3 bg-primary text-white font-mono text-sm tracking-widest hover:bg-primary/90 transition-all shadow-[0_0_20px_rgba(124,58,237,0.2)] hover:shadow-[0_0_30px_rgba(124,58,237,0.4)] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none flex items-center gap-2"
                data-testid="button-submit-review"
              >
                {submitMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Submitting...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    <span>Submit Review Request</span>
                  </>
                )}
              </button>
              {submitMutation.isSuccess && (
                <span className="text-[10px] font-mono text-green-400">
                  Review submitted — generation in progress
                </span>
              )}
              {submitMutation.isError && (
                <span className="text-[10px] font-mono text-red-400">
                  {(submitMutation.error as Error).message}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}