import { useState, useEffect, useRef } from "react";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn } from "@/components/ui/motion";
import { useAuth } from "@/lib/auth";
import { ModelSelector, type ModelConfig } from "@/components/ModelSelector";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  PenTool,
  BookOpen,
  Loader2,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  ExternalLink,
  Info,
  CheckCircle,
  XCircle,
  Clock,
  Lock,
} from "lucide-react";

type GenerationType = "editorial" | "literature-review";

interface RateLimitStatus {
  remaining: number;
  resetAt: number | null;
  count: number;
}

interface EditorialRecord {
  id: string;
  title: string;
  slug: string;
  tag: string;
  excerpt: string | null;
  contentHtml: string | null;
  agentId: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  topic: string | null;
  orchestratorName: string | null;
  modelProvider: string | null;
  modelName: string | null;
  providerMode: string | null;
  publishedDocumentId: string | null;
  promptTrace: string | null;
  sourceTrace: string | null;
}

interface LiteratureReviewRecord {
  id: string;
  researchQuestion: string;
  agentId: string;
  status: string;
  contentHtml: string | null;
  createdAt: string;
  completedAt: string | null;
  topic: string | null;
  orchestratorName: string | null;
  modelProvider: string | null;
  modelName: string | null;
  providerMode: string | null;
  publishedDocumentId: string | null;
  promptTrace: string | null;
  sourceTrace: string | null;
}

const PLATFORM_ACCESS_EMAILS = ["jevans@uchicago.edu", "sacharaoult@gmail.com", "akozlo@uchicago.edu"];

function deriveModelInitials(modelName: string): string {
  const m = (modelName || "").toLowerCase();
  if (m.includes("deepseek-r1")) return "DSR1";
  if (m.includes("deepseek")) return "DS32";
  if (m.includes("claude-sonnet-4-5") || m.includes("sonnet-4-5")) return "CS45";
  if (m.includes("claude-sonnet-4") || m.includes("sonnet-4")) return "CS4";
  if (m.includes("claude-opus")) return "CO";
  if (m.includes("claude-haiku")) return "CH";
  if (m.includes("gpt-4o")) return "G4O";
  if (m.includes("gpt-4")) return "G4";
  return "ML";
}

function deriveAgentName(modelConfig: ModelConfig, agentSuffix: string): string {
  const initials = deriveModelInitials(modelConfig.modelName);
  return `MachInstit ${initials}${agentSuffix}-N1`;
}

export default function GenerationDashboard() {
  const { authenticated, user, login, isLoading: authLoading } = useAuth();
  const hasPlatformAccess = PLATFORM_ACCESS_EMAILS.includes(user?.email ?? "");
  const [activeType, setActiveType] = useState<GenerationType | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    providerMode: "platform",
    provider: "openrouter",
    modelName: "deepseek/deepseek-chat",
  });
  const [orchestratorName, setOrchestratorName] = useState("");
  const [agentDescription, setAgentDescription] = useState("AI research assistant generating scholarly content for the Machine Institute");
  const [topic, setTopic] = useState("Autonomous AI research agents and their role in scientific discovery");
  const [prompt, setPrompt] = useState("");
  const [promptManuallyEdited, setPromptManuallyEdited] = useState(false);
  const [researchQuestion, setResearchQuestion] = useState("");
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [showMetadata, setShowMetadata] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<"basic" | "adversarial">("basic");
  const [selectedJournal, setSelectedJournal] = useState<string>("autonomous-journal-xai");
  const orchestratorNameCustomized = useRef(false);

  const queryClient = useQueryClient();

  const { data: editorialStatus } = useQuery<RateLimitStatus>({
    queryKey: ["/api/editorials/status"],
    queryFn: async () => {
      const res = await fetch("/api/editorials/status");
      return res.json();
    },
    enabled: authenticated,
    refetchInterval: 10000,
  });

  const { data: reviewStatus } = useQuery<RateLimitStatus>({
    queryKey: ["/api/generation/rate-limit-status", "literature-review"],
    queryFn: async () => {
      const res = await fetch("/api/generation/rate-limit-status");
      const data = await res.json();
      return data["literature-review"] as RateLimitStatus;
    },
    enabled: authenticated,
    refetchInterval: 10000,
  });

  const { data: defaultEditorialPrompt } = useQuery<{ prompt: string }>({
    queryKey: ["/api/editorials/default-prompt"],
    queryFn: async () => {
      const res = await fetch("/api/editorials/default-prompt");
      return res.json();
    },
    enabled: activeType === "editorial",
  });

  const reviewAgentId = reviewMode === "adversarial" ? "aLR" : "bLR";

  const { data: defaultReviewPrompt } = useQuery<{ prompt: string }>({
    queryKey: ["/api/literature-reviews/default-prompt", reviewAgentId],
    queryFn: async () => {
      const res = await fetch(`/api/literature-reviews/default-prompt?agentId=${reviewAgentId}`);
      return res.json();
    },
    enabled: activeType === "literature-review",
  });

  useEffect(() => {
    if (activeType === "editorial" && defaultEditorialPrompt?.prompt && !promptManuallyEdited) {
      setPrompt(defaultEditorialPrompt.prompt);
    }
    if (activeType === "literature-review" && defaultReviewPrompt?.prompt && !promptManuallyEdited) {
      setPrompt(defaultReviewPrompt.prompt);
    }
  }, [activeType, defaultEditorialPrompt, defaultReviewPrompt, reviewMode]);

  useEffect(() => {
    if (orchestratorNameCustomized.current) return;
    const agentSuffix = activeType === "editorial" ? "O" : reviewAgentId;
    setOrchestratorName(deriveAgentName(modelConfig, agentSuffix));
  }, [modelConfig, activeType, reviewAgentId]);

  const { data: recentEditorials } = useQuery<EditorialRecord[]>({
    queryKey: ["/api/editorials"],
    queryFn: async () => {
      const res = await fetch("/api/editorials");
      return res.json();
    },
    enabled: authenticated,
    refetchInterval: 8000,
  });

  const { data: recentReviews } = useQuery<LiteratureReviewRecord[]>({
    queryKey: ["/api/literature-reviews-all"],
    queryFn: async () => {
      const res = await fetch("/api/literature-reviews");
      return res.json();
    },
    enabled: authenticated,
    refetchInterval: 8000,
  });

  const generateEditorialMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/editorials/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic || undefined,
          prompt: promptManuallyEdited ? prompt : undefined,
          userPrompt: undefined,
          orchestratorName: orchestratorName || undefined,
          agentDescription: agentDescription || undefined,
          providerMode: modelConfig.providerMode,
          modelProvider: modelConfig.provider,
          modelName: modelConfig.modelName,
          byocApiKey: modelConfig.providerMode === "byoc" ? modelConfig.apiKey : undefined,
          journalId: selectedJournal,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate editorial");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/editorials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/editorials/status"] });
    },
  });

  const generateReviewMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/literature-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "machine-psychology",
          agentId: reviewAgentId,
          researchQuestion,
          prompt: prompt || undefined,
          topic: topic || undefined,
          orchestratorName: orchestratorName || undefined,
          agentDescription: agentDescription || undefined,
          providerMode: modelConfig.providerMode,
          modelProvider: modelConfig.provider,
          modelName: modelConfig.modelName,
          byocApiKey: modelConfig.providerMode === "byoc" ? modelConfig.apiKey : undefined,
          journalId: selectedJournal,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate review");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/literature-reviews-all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/generation/rate-limit-status"] });
    },
  });

  const clearHistoryMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/generation/history", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to clear history");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/editorials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/literature-reviews-all"] });
    },
  });

  useEffect(() => {
    if (!authLoading && !authenticated) {
      login();
    }
  }, [authLoading, authenticated, login]);

  if (authLoading || !authenticated) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Navigation />
        <main className="pt-28 pb-24">
          <div className="container mx-auto px-6 max-w-2xl text-center">
            <FadeIn>
              <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
              <p className="text-muted-foreground font-mono text-sm">
                {authLoading ? "Loading..." : "Redirecting to sign in..."}
              </p>
            </FadeIn>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const editorialIsPending = generateEditorialMutation.isPending;
  const reviewIsPending = generateReviewMutation.isPending;
  const hasGeneratingEditorial = recentEditorials?.some(e => e.status === "pending" || e.status === "generating");
  const hasGeneratingReview = recentReviews?.some(r => r.status === "pending" || r.status === "generating");

  const byocReady = modelConfig.providerMode === "byoc" ? !!modelConfig.keyValidated : true;
  const canSubmitEditorial = !editorialIsPending && !hasGeneratingEditorial && byocReady &&
    (modelConfig.providerMode === "byoc" || (editorialStatus?.remaining ?? 1) > 0);
  const canSubmitReview = !reviewIsPending && !hasGeneratingReview && researchQuestion.trim().length >= 10 && byocReady &&
    (modelConfig.providerMode === "byoc" || (reviewStatus?.remaining ?? 1) > 0);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6 max-w-4xl">
          <FadeIn className="mb-10">
            <h1 className="text-4xl md:text-5xl font-heading font-bold mb-4" data-testid="text-dashboard-title">
              Generation Dashboard
            </h1>
            <div className="h-1 w-20 bg-primary/50 mb-6" />
            <p className="text-muted-foreground max-w-2xl">
              Generate AI-driven editorials and literature reviews with full control over model selection, prompts, and orchestrator identity.
            </p>
          </FadeIn>

          {!activeType ? (
            <FadeIn>
              <div className="grid md:grid-cols-2 gap-6 mb-12">
                <button
                  onClick={() => { setActiveType("editorial"); setPromptManuallyEdited(false); setPrompt(""); }}
                  className="p-8 border border-border/50 bg-muted/5 hover:bg-muted/10 hover:border-primary/30 transition-all text-left group"
                  data-testid="card-generate-editorial"
                >
                  <PenTool className="w-8 h-8 text-primary/60 mb-4 group-hover:text-primary transition-colors" />
                  <h2 className="text-xl font-heading font-semibold mb-2">Generate Editorial</h2>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    Synthesize research across the institute's publications into an op-ed, informed by arXiv trends.
                  </p>
                  {editorialStatus && (
                    <span className="text-[10px] font-mono text-muted-foreground/50">
                      {editorialStatus.remaining} platform uses remaining
                    </span>
                  )}
                </button>

                <button
                  onClick={() => { setActiveType("literature-review"); setPromptManuallyEdited(false); setPrompt(""); }}
                  className="p-8 border border-border/50 bg-muted/5 hover:bg-muted/10 hover:border-primary/30 transition-all text-left group"
                  data-testid="card-generate-review"
                >
                  <BookOpen className="w-8 h-8 text-primary/60 mb-4 group-hover:text-primary transition-colors" />
                  <h2 className="text-xl font-heading font-semibold mb-2">Generate Literature Review</h2>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    Conduct a comprehensive review on a research question using published papers and arXiv.
                  </p>
                  {reviewStatus && (
                    <span className="text-[10px] font-mono text-muted-foreground/50">
                      {reviewStatus.remaining} platform uses remaining
                    </span>
                  )}
                </button>
              </div>
            </FadeIn>
          ) : (
            <FadeIn>
              <div className="mb-6">
                <button
                  onClick={() => { setActiveType(null); setPromptManuallyEdited(false); }}
                  className="text-xs font-mono text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                  data-testid="button-back-to-dashboard"
                >
                  ← Back to dashboard
                </button>
              </div>

              <div className="space-y-8">
                <div>
                  <h2 className="text-2xl font-heading font-semibold mb-1 flex items-center gap-3">
                    {activeType === "editorial" ? (
                      <><PenTool className="w-5 h-5 text-primary" /> Generate Editorial</>
                    ) : (
                      <><BookOpen className="w-5 h-5 text-primary" /> Generate Literature Review</>
                    )}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {activeType === "editorial"
                      ? "Configure and generate an editorial synthesizing recent research."
                      : "Configure and generate a literature review on a specific research question."}
                  </p>
                </div>

                <div>
                  <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3 block">
                    1. Journal
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    <button
                      onClick={() => setSelectedJournal("autonomous-journal-xai")}
                      className={`p-4 border text-left transition-all ${
                        selectedJournal === "autonomous-journal-xai"
                          ? "border-primary bg-primary/10"
                          : "border-border/50 bg-muted/5 hover:border-primary/40 hover:bg-muted/10"
                      }`}
                      data-testid="button-journal-mirror"
                    >
                      <div className="text-xs font-heading font-semibold mb-1">Mirror</div>
                      <div className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                        Automated Journal of AI Interpretability
                      </div>
                      {selectedJournal === "autonomous-journal-xai" && (
                        <div className="mt-2 flex items-center gap-1">
                          <CheckCircle className="w-3 h-3 text-primary" />
                          <span className="text-[10px] font-mono text-primary">Selected</span>
                        </div>
                      )}
                    </button>

                    <div
                      className="p-4 border border-border/30 bg-muted/5 opacity-50 cursor-not-allowed relative"
                      data-testid="card-journal-locked-1"
                    >
                      <Lock className="w-3 h-3 text-muted-foreground/40 absolute top-3 right-3" />
                      <div className="text-xs font-heading font-semibold mb-1 text-muted-foreground">Project 02</div>
                      <div className="text-[10px] font-mono text-muted-foreground/50 leading-relaxed">
                        Classification pending.
                      </div>
                      <div className="mt-2">
                        <span className="text-[10px] font-mono text-muted-foreground/40">Coming Soon</span>
                      </div>
                    </div>

                    <div
                      className="p-4 border border-border/30 bg-muted/5 opacity-50 cursor-not-allowed relative"
                      data-testid="card-journal-locked-2"
                    >
                      <Lock className="w-3 h-3 text-muted-foreground/40 absolute top-3 right-3" />
                      <div className="text-xs font-heading font-semibold mb-1 text-muted-foreground">Project 03</div>
                      <div className="text-[10px] font-mono text-muted-foreground/50 leading-relaxed">
                        Classification pending.
                      </div>
                      <div className="mt-2">
                        <span className="text-[10px] font-mono text-muted-foreground/40">Coming Soon</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3 block">
                    2. Model Selection
                  </label>
                  <ModelSelector
                    value={modelConfig}
                    onChange={setModelConfig}
                    rateLimitInfo={activeType === "editorial" ? editorialStatus : reviewStatus}
                    limitLabel={activeType === "editorial" ? "editorial generations" : "review generations"}
                    hasPlatformAccess={hasPlatformAccess}
                  />
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
                      3. Orchestrator Name
                    </label>
                    <input
                      type="text"
                      value={orchestratorName}
                      onChange={(e) => {
                        orchestratorNameCustomized.current = true;
                        setOrchestratorName(e.target.value);
                      }}
                      className="w-full bg-background border border-border/50 px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-primary/50"
                      placeholder="MachInstit DS32bLR-N1"
                      data-testid="input-orchestrator-name"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
                      Agent Description
                    </label>
                    <input
                      type="text"
                      value={agentDescription}
                      onChange={(e) => setAgentDescription(e.target.value)}
                      className="w-full bg-background border border-border/50 px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-primary/50"
                      placeholder="e.g. Senior research analyst"
                      data-testid="input-agent-description"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
                    4. Topic
                  </label>
                  <input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    className="w-full bg-background border border-border/50 px-3 py-2.5 text-sm focus:outline-none focus:border-primary/50"
                    placeholder={activeType === "editorial"
                      ? "Recent developments in AI agent-driven scientific research..."
                      : "Enter a topic focus (optional)"}
                    data-testid="input-topic"
                  />
                </div>

                {activeType === "literature-review" && (
                  <div>
                    <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
                      Review Mode
                    </label>
                    <div className="flex gap-2 mb-4">
                      <button
                        onClick={() => { setReviewMode("basic"); setPromptManuallyEdited(false); }}
                        className={`px-4 py-2 text-xs font-mono border transition-all ${
                          reviewMode === "basic"
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/50 text-muted-foreground hover:border-primary/30"
                        }`}
                        data-testid="button-review-mode-basic"
                      >
                        Basic Review
                      </button>
                      <button
                        onClick={() => { setReviewMode("adversarial"); setPromptManuallyEdited(false); }}
                        className={`px-4 py-2 text-xs font-mono border transition-all ${
                          reviewMode === "adversarial"
                            ? "border-red-500 bg-red-500/10 text-red-400"
                            : "border-border/50 text-muted-foreground hover:border-red-500/30"
                        }`}
                        data-testid="button-review-mode-adversarial"
                      >
                        Adversarial Review
                      </button>
                    </div>
                    <p className="text-[10px] font-mono text-muted-foreground/50 mb-4">
                      {reviewMode === "basic"
                        ? "Synthesizes literature constructively with balanced analysis."
                        : "Critically examines literature for weaknesses, flaws, and contradictions."}
                    </p>
                  </div>
                )}

                {activeType === "literature-review" && (
                  <div>
                    <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
                      Research Question <span className="text-red-400">*</span>
                    </label>
                    <textarea
                      value={researchQuestion}
                      onChange={(e) => setResearchQuestion(e.target.value)}
                      className="w-full h-28 bg-background border border-border/50 px-4 py-3 text-sm focus:outline-none focus:border-primary/50 resize-none font-mono"
                      placeholder="e.g. How do LLMs exhibit moral reasoning biases across different experimental paradigms?"
                      data-testid="input-research-question"
                    />
                    {researchQuestion.length > 0 && researchQuestion.length < 10 && (
                      <p className="text-[10px] font-mono text-red-400 mt-1">Research question must be at least 10 characters.</p>
                    )}
                  </div>
                )}

                <div>
                  <button
                    onClick={() => setPromptExpanded(!promptExpanded)}
                    className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest hover:text-muted-foreground transition-colors mb-2"
                    data-testid="button-toggle-prompt"
                  >
                    {promptExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    5. System Prompt (editable)
                  </button>
                  {promptExpanded && (
                    <div className="space-y-2">
                      <textarea
                        value={prompt}
                        onChange={(e) => { setPrompt(e.target.value); setPromptManuallyEdited(true); }}
                        className="w-full h-64 bg-background border border-border/50 px-4 py-3 text-xs text-foreground/70 resize-none focus:outline-none focus:border-primary/50 font-mono"
                        data-testid="input-system-prompt"
                      />
                      <button
                        onClick={() => {
                          setPromptManuallyEdited(false);
                          const defaultP = activeType === "editorial" ? defaultEditorialPrompt?.prompt : defaultReviewPrompt?.prompt;
                          if (defaultP) setPrompt(defaultP);
                        }}
                        className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                        data-testid="button-reset-prompt"
                      >
                        <RotateCcw className="w-3 h-3" /> Reset to default
                      </button>
                    </div>
                  )}
                </div>

                <div className="border-t border-border/30 pt-6">
                  <button
                    onClick={() => {
                      if (activeType === "editorial") generateEditorialMutation.mutate();
                      else generateReviewMutation.mutate();
                    }}
                    disabled={activeType === "editorial" ? !canSubmitEditorial : !canSubmitReview}
                    className="px-8 py-3 bg-primary text-white font-mono text-sm tracking-widest hover:bg-primary/90 transition-all shadow-[0_0_20px_rgba(124,58,237,0.2)] hover:shadow-[0_0_30px_rgba(124,58,237,0.4)] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none flex items-center gap-2"
                    data-testid="button-generate"
                  >
                    {(editorialIsPending || reviewIsPending) ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Submitting...</>
                    ) : (
                      <>{activeType === "editorial" ? <PenTool className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />} Generate</>
                    )}
                  </button>

                  {generateEditorialMutation.isSuccess && (
                    <p className="text-[10px] font-mono text-green-400 mt-3" data-testid="text-success">
                      Editorial submitted — generation in progress. This may take a few minutes.
                    </p>
                  )}
                  {generateReviewMutation.isSuccess && (
                    <p className="text-[10px] font-mono text-green-400 mt-3" data-testid="text-success">
                      Literature review submitted — generation in progress.
                    </p>
                  )}
                  {(generateEditorialMutation.isError || generateReviewMutation.isError) && (
                    <p className="text-[10px] font-mono text-red-400 mt-3" data-testid="text-error">
                      {((generateEditorialMutation.error || generateReviewMutation.error) as Error)?.message}
                    </p>
                  )}
                </div>
              </div>
            </FadeIn>
          )}

          <FadeIn className="mt-16">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-heading font-semibold">Recent Generations</h2>
              {user?.email === "sacharaoult@gmail.com" && ((recentEditorials?.length ?? 0) + (recentReviews?.length ?? 0)) > 0 && (
                <button
                  onClick={() => {
                    if (confirm("Clear all generation history? This cannot be undone.")) {
                      clearHistoryMutation.mutate();
                    }
                  }}
                  disabled={clearHistoryMutation.isPending}
                  className="text-[10px] font-mono text-muted-foreground/40 hover:text-red-400 transition-colors flex items-center gap-1.5 disabled:opacity-40"
                  data-testid="button-clear-history"
                >
                  {clearHistoryMutation.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <RotateCcw className="w-3 h-3" />
                  )}
                  Clear history
                </button>
              )}
            </div>

            <div className="space-y-4">
              {(recentEditorials || []).slice(0, 5).map((ed) => (
                <div key={ed.id} className="border border-border/40 bg-muted/5 p-5" data-testid={`card-editorial-${ed.id}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <PenTool className="w-4 h-4 text-primary/60" />
                      <span className="text-[10px] font-mono text-primary uppercase tracking-widest">Editorial</span>
                      <StatusBadge status={ed.status} />
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground/40">
                      {new Date(ed.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <h3 className="font-heading font-semibold mb-1">
                    {ed.status === "completed" ? (
                      <Link href={`/editorials/${ed.slug}`} className="hover:text-primary transition-colors">
                        {ed.title}
                      </Link>
                    ) : (
                      ed.title
                    )}
                  </h3>
                  {ed.excerpt && <p className="text-sm text-muted-foreground line-clamp-2">{ed.excerpt}</p>}

                  {(ed.status === "pending" || ed.status === "generating") && (
                    <div className="flex items-center gap-2 mt-3 text-xs font-mono text-primary/50">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Generating...</span>
                    </div>
                  )}

                  {ed.status === "completed" && (
                    <div className="mt-3 flex items-center gap-4">
                      <Link
                        href={`/editorials/${ed.slug}`}
                        className="text-[10px] font-mono text-primary hover:underline flex items-center gap-1"
                        data-testid={`link-view-editorial-${ed.id}`}
                      >
                        View full content <ExternalLink className="w-3 h-3" />
                      </Link>
                      <button
                        onClick={() => setShowMetadata(showMetadata === ed.id ? null : ed.id)}
                        className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                        data-testid={`button-metadata-${ed.id}`}
                      >
                        <Info className="w-3 h-3" />
                        {showMetadata === ed.id ? "Hide" : "Show"} metadata
                      </button>
                    </div>
                  )}
                  {showMetadata === ed.id && <MetadataPanel record={ed} />}
                </div>
              ))}

              {(recentReviews || []).slice(0, 5).map((rev) => (
                <div key={rev.id} className="border border-border/40 bg-muted/5 p-5" data-testid={`card-review-${rev.id}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <BookOpen className="w-4 h-4 text-primary/60" />
                      <span className="text-[10px] font-mono text-primary uppercase tracking-widest">Literature Review</span>
                      <StatusBadge status={rev.status} />
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground/40">
                      {new Date(rev.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <h3 className="font-heading font-semibold mb-1">
                    {rev.status === "completed" ? (
                      <Link href={`/literature-reviews/${rev.id}`} className="hover:text-primary transition-colors">
                        {rev.researchQuestion}
                      </Link>
                    ) : (
                      rev.researchQuestion
                    )}
                  </h3>

                  {(rev.status === "pending" || rev.status === "generating") && (
                    <div className="flex items-center gap-2 mt-3 text-xs font-mono text-primary/50">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Generating...</span>
                    </div>
                  )}

                  {rev.status === "completed" && (
                    <div className="mt-3 flex items-center gap-4">
                      <Link
                        href={`/literature-reviews/${rev.id}`}
                        className="text-[10px] font-mono text-primary hover:underline flex items-center gap-1"
                        data-testid={`link-view-review-${rev.id}`}
                      >
                        View full content <ExternalLink className="w-3 h-3" />
                      </Link>
                      <button
                        onClick={() => setShowMetadata(showMetadata === rev.id ? null : rev.id)}
                        className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                        data-testid={`button-metadata-${rev.id}`}
                      >
                        <Info className="w-3 h-3" />
                        {showMetadata === rev.id ? "Hide" : "Show"} metadata
                      </button>
                    </div>
                  )}
                  {showMetadata === rev.id && <MetadataPanel record={rev} />}
                </div>
              ))}

              {(!recentEditorials?.length && !recentReviews?.length) && (
                <div className="text-center py-12 border border-border/30 bg-muted/5">
                  <p className="text-muted-foreground font-mono text-sm">No generations yet.</p>
                  <p className="text-[10px] font-mono text-muted-foreground/40 mt-2">
                    Use the action cards above to create your first generation.
                  </p>
                </div>
              )}
            </div>
          </FadeIn>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <span className="flex items-center gap-1 text-[10px] font-mono text-green-400" data-testid={`status-${status}`}>
        <CheckCircle className="w-3 h-3" /> Completed
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-1 text-[10px] font-mono text-red-400" data-testid={`status-${status}`}>
        <XCircle className="w-3 h-3" /> Failed
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[10px] font-mono text-yellow-400" data-testid={`status-${status}`}>
      <Clock className="w-3 h-3" /> {status === "generating" ? "Generating" : "Pending"}
    </span>
  );
}

function MetadataPanel({ record }: { record: EditorialRecord | LiteratureReviewRecord }) {
  let promptData: Record<string, unknown> | null = null;
  let sourceData: Record<string, unknown> | null = null;

  try {
    if (record.promptTrace) promptData = JSON.parse(record.promptTrace);
  } catch {}
  try {
    if (record.sourceTrace) sourceData = JSON.parse(record.sourceTrace);
  } catch {}

  const publishedUrl = record.publishedDocumentId
    ? `https://future-science.org/papers/${record.publishedDocumentId}`
    : null;

  return (
    <div className="mt-3 border border-border/20 bg-background/50 p-4 space-y-3" data-testid="metadata-panel">
      <div className="grid grid-cols-2 gap-3 text-[10px] font-mono">
        {record.topic && (
          <div className="col-span-2">
            <span className="text-muted-foreground/40 block">Topic</span>
            <span className="text-foreground/70">{record.topic}</span>
          </div>
        )}
        <div>
          <span className="text-muted-foreground/40 block">Model</span>
          <span className="text-foreground/70">{record.modelName || "default"}</span>
        </div>
        <div>
          <span className="text-muted-foreground/40 block">Provider</span>
          <span className="text-foreground/70">{record.modelProvider || "platform"}</span>
        </div>
        <div>
          <span className="text-muted-foreground/40 block">Mode</span>
          <span className="text-foreground/70">{record.providerMode || "platform"}</span>
        </div>
        <div>
          <span className="text-muted-foreground/40 block">Orchestrator</span>
          <span className="text-foreground/70">{record.orchestratorName || "—"}</span>
        </div>
      </div>

      {publishedUrl && (
        <div>
          <span className="text-[10px] font-mono text-muted-foreground/40 block mb-1">Future Science Publication</span>
          <a
            href={publishedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-primary hover:underline flex items-center gap-1"
            data-testid="link-publication"
          >
            View on Future Science <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      {promptData && (
        <div>
          <span className="text-[10px] font-mono text-muted-foreground/40 block mb-1">Prompt Trace</span>
          <details className="text-[10px] font-mono text-foreground/50">
            <summary className="cursor-pointer hover:text-foreground/70">Show prompt details</summary>
            <pre className="mt-2 p-3 bg-muted/10 border border-border/20 overflow-x-auto max-h-48 text-[9px] whitespace-pre-wrap">
              {JSON.stringify(promptData, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {sourceData && (
        <div>
          <span className="text-[10px] font-mono text-muted-foreground/40 block mb-1">Source Trace</span>
          <details className="text-[10px] font-mono text-foreground/50">
            <summary className="cursor-pointer hover:text-foreground/70">Show source details</summary>
            <pre className="mt-2 p-3 bg-muted/10 border border-border/20 overflow-x-auto max-h-48 text-[9px] whitespace-pre-wrap">
              {JSON.stringify(sourceData, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
