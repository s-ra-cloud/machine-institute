import { useState, useEffect } from "react";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn } from "@/components/ui/motion";
import { useAuth } from "@/lib/auth";
import { ModelSelector, type ModelConfig } from "@/components/ModelSelector";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
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
  FlaskConical,
} from "lucide-react";

type GenerationType = "editorial" | "literature-review" | "ethics-report";

interface RateLimitStatus {
  remaining: number | null;
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

interface EthicsReportRecord {
  id: string;
  projectId: string;
  agentId: string;
  journalId: string;
  keywords: string[];
  researchQuestion: string;
  status: string;
  reportTitle: string | null;
  reportAbstract: string | null;
  clearanceStatus: string | null;
  createdAt: string;
  completedAt: string | null;
  orchestratorName: string | null;
  modelProvider: string | null;
  modelName: string | null;
  providerMode: string | null;
  publishedDocumentId: string | null;
  promptTrace: string | null;
  sourceTrace: string | null;
  topic?: string | null;
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

const labWorkflowCards = [
  {
    id: "experiment",
    title: "Generate Experiment",
    description: "Design a computational experiment grounded in the institute's prior work and current arXiv frontiers.",
    icon: FlaskConical,
    status: "Locked",
    locked: true,
  },
  {
    id: "literature-review",
    title: "Generate Literature Review",
    description: "Conduct a comprehensive review on a research question using published papers and arXiv.",
    icon: BookOpen,
    status: "Available",
    locked: false,
  },
  {
    id: "ethics-citations",
    title: "Ethics and citation analysis",
    description: "Audit literature for citation integrity, unsupported claims, and fabricated references.",
    icon: Info,
    status: "Available",
    locked: false,
  },
  {
    id: "editorial",
    title: "Generate Editorial",
    description: "Synthesize research across the institute's publications into an op-ed, informed by arXiv trends.",
    icon: PenTool,
    status: "Locked",
    locked: true,
  },
  {
    id: "peer-review",
    title: "Peer review a publication",
    description: "Run structured peer review on an existing Machine Institute publication.",
    icon: BookOpen,
    status: "Coming soon",
    locked: true,
  },
  {
    id: "revise-publication",
    title: "Revise a peer reviewed publication",
    description: "Use reviewer feedback to produce a revised publication draft.",
    icon: PenTool,
    status: "Coming soon",
    locked: true,
  },
  {
    id: "semi-autonomous-cycle",
    title: "Semi-autonomous research cycle",
    description: "Coordinate agents through a guided research loop with human checkpoints.",
    icon: RotateCcw,
    status: "Coming soon",
    locked: true,
  },
  {
    id: "fully-autonomous-cycle",
    title: "Fully-autonomous research cycle",
    description: "Let a manager persona rewrite prompts and coordinate other research agents end-to-end.",
    icon: RotateCcw,
    status: "Coming soon",
    locked: true,
  },
];

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
  const { authenticated, user, login, isLoading: authLoading, isAdmin } = useAuth();
  const hasPlatformAccess = PLATFORM_ACCESS_EMAILS.includes(user?.email ?? "");
  const [activeType, setActiveType] = useState<GenerationType | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    providerMode: "platform",
    provider: "openrouter",
    modelName: "deepseek/deepseek-chat",
  });
  const [orchestratorName, setOrchestratorName] = useState(user?.displayName ?? "");
  const [topic, setTopic] = useState("Autonomous AI research agents and their role in scientific discovery");
  const [prompt, setPrompt] = useState("");
  const [promptManuallyEdited, setPromptManuallyEdited] = useState(false);
  const [researchQuestion, setResearchQuestion] = useState("");
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [showMetadata, setShowMetadata] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<"basic" | "adversarial">("basic");
  const [selectedJournal, setSelectedJournal] = useState<string>("mirror");
  const ethicsProjectId = selectedJournal;
  const [ethicsKeywords, setEthicsKeywords] = useState<string>("");
  const [ethicsTopic, setEthicsTopic] = useState<string>("");
  const [, navigate] = useLocation();
  const [ethicsPrompt1, setEthicsPrompt1] = useState<string>("");
  const [ethicsPrompt2, setEthicsPrompt2] = useState<string>("");
  const [ethicsPrompt3, setEthicsPrompt3] = useState<string>("");
  const [ethicsPrompt1Edited, setEthicsPrompt1Edited] = useState(false);
  const [ethicsPrompt2Edited, setEthicsPrompt2Edited] = useState(false);
  const [ethicsPrompt3Edited, setEthicsPrompt3Edited] = useState(false);
  const [ethicsPromptsExpanded, setEthicsPromptsExpanded] = useState(false);
  const [selectedPaperDocId, setSelectedPaperDocId] = useState<string>("");
  const [selectedPaperTitle, setSelectedPaperTitle] = useState<string>("");
  const [paperPickerQuery, setPaperPickerQuery] = useState<string>("");

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

  const AGENT_DESCRIPTIONS: Record<string, string> = {
    O: "Editorialist agent that synthesizes publications and trends into op-ed style editorials for the Machine Institute.",
    bLR: "Basic Literature Reviewer agent that produces structured literature reviews from project papers and Future Science abstracts.",
    aLR: "Adversarial Literature Reviewer agent that critically interrogates the literature and surfaces counter-evidence and weaknesses.",
    H: "Ethicist agent performing a single-paper deep ethics audit across eight categories, with full citation and URL verification.",
  };

  const activeRoleCode =
    activeType === "editorial"
      ? "O"
      : activeType === "literature-review"
        ? reviewAgentId
        : activeType === "ethics-report"
          ? "H"
          : "O";

  const agentDescription = AGENT_DESCRIPTIONS[activeRoleCode] ?? AGENT_DESCRIPTIONS.O;

  const { data: defaultReviewPrompt } = useQuery<{ prompt: string }>({
    queryKey: ["/api/literature-reviews/default-prompt", reviewAgentId],
    queryFn: async () => {
      const res = await fetch(`/api/literature-reviews/default-prompt?agentId=${reviewAgentId}`);
      return res.json();
    },
    enabled: activeType === "literature-review",
  });

  const { data: defaultEthicsPrompts } = useQuery<{ prompt1: string; prompt2: string; prompt3: string; singlePaperPrompt: string }>({
    queryKey: ["/api/ethics-reports/default-prompts", selectedJournal],
    queryFn: async () => {
      const res = await fetch(`/api/ethics-reports/default-prompts?journalId=${encodeURIComponent(selectedJournal)}`);
      return res.json();
    },
    enabled: activeType === "ethics-report",
  });

  interface AvailablePaper { documentId: string; title: string; authors: string; date: string; url: string; alreadyReviewed: boolean }
  const { data: availablePapersData, refetch: refetchAvailablePapers } = useQuery<{ papers: AvailablePaper[]; lockedCount: number }>({
    queryKey: ["/api/ethics-reports/available-papers", selectedJournal],
    queryFn: async () => {
      const res = await fetch(`/api/ethics-reports/available-papers?journalId=${encodeURIComponent(selectedJournal)}`);
      return res.json();
    },
    enabled: activeType === "ethics-report",
  });

  const resetAuditLockMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/audit-lock/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ journalId: selectedJournal }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to reset audit lock");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ethics-reports/available-papers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ethics-reports-all"] });
      refetchAvailablePapers();
    },
  });

  const deleteEthicsReportMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/ethics-reports/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete report");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ethics-reports-all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ethics-reports/available-papers"] });
    },
  });

  const deleteLiteratureReviewMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/literature-reviews/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete review");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/literature-reviews-all"] });
    },
  });

  const { data: ethicsStatus } = useQuery<RateLimitStatus>({
    queryKey: ["/api/generation/rate-limit-status", "ethics-report"],
    queryFn: async () => {
      const res = await fetch("/api/generation/rate-limit-status");
      const data = await res.json();
      return data["ethics-report"] as RateLimitStatus;
    },
    enabled: authenticated,
    refetchInterval: 10000,
  });

  useEffect(() => {
    if (activeType === "editorial" && defaultEditorialPrompt?.prompt && !promptManuallyEdited) {
      setPrompt(defaultEditorialPrompt.prompt);
    }
    if (activeType === "literature-review" && defaultReviewPrompt?.prompt && !promptManuallyEdited) {
      setPrompt(defaultReviewPrompt.prompt);
    }
    if (activeType === "ethics-report" && defaultEthicsPrompts) {
      if (!ethicsPrompt1Edited) setEthicsPrompt1(defaultEthicsPrompts.singlePaperPrompt || defaultEthicsPrompts.prompt1);
      if (!ethicsPrompt2Edited) setEthicsPrompt2(defaultEthicsPrompts.prompt2);
      if (!ethicsPrompt3Edited) setEthicsPrompt3(defaultEthicsPrompts.prompt3);
    }
  }, [activeType, defaultEditorialPrompt, defaultReviewPrompt, defaultEthicsPrompts, reviewMode]);

  useEffect(() => {
    if (user?.displayName) {
      setOrchestratorName(user.displayName);
    }
  }, [user?.displayName]);

  const { data: recentEditorials } = useQuery<EditorialRecord[]>({
    queryKey: ["/api/editorials"],
    queryFn: async () => {
      const res = await fetch("/api/editorials");
      return res.json();
    },
    enabled: authenticated,
    refetchInterval: 8000,
  });

  const { data: recentEthics } = useQuery<EthicsReportRecord[]>({
    queryKey: ["/api/ethics-reports-all"],
    queryFn: async () => {
      const res = await fetch("/api/ethics-reports");
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

  const generateEthicsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ethics-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: ethicsProjectId,
          agentId: "H",
          journalId: selectedJournal,
          documentId: selectedPaperDocId,
          paperTitle: selectedPaperTitle,
          singlePaperPrompt: ethicsPrompt1Edited ? ethicsPrompt1 : undefined,
          orchestratorName: orchestratorName || undefined,
          agentDescription: agentDescription || undefined,
          providerMode: modelConfig.providerMode,
          modelProvider: modelConfig.provider,
          modelName: modelConfig.modelName,
          byocApiKey: modelConfig.providerMode === "byoc" ? modelConfig.apiKey : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate ethics report");
      }
      return res.json();
    },
    onSuccess: (data: { id?: string }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ethics-reports-all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/generation/rate-limit-status"] });
      if (data?.id) navigate(`/ethics-reports/${data.id}`);
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
      queryClient.invalidateQueries({ queryKey: ["/api/ethics-reports-all"] });
    },
  });

  useEffect(() => {
    if (!authLoading && !authenticated) {
      login();
    }
  }, [authLoading, authenticated, login]);

  if (authLoading || !authenticated) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col">
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
  const ethicsIsPending = generateEthicsMutation.isPending;
  const hasGeneratingEditorial = recentEditorials?.some(e => e.status === "pending" || e.status === "generating");
  const hasGeneratingReview = recentReviews?.some(r => r.status === "pending" || r.status === "generating");
  const hasGeneratingEthics = recentEthics?.some(r => r.status === "pending" || r.status === "generating");

  const byocReady = modelConfig.providerMode === "byoc" ? !!modelConfig.keyValidated : true;
  const canSubmitEditorial = !editorialIsPending && !hasGeneratingEditorial && byocReady &&
    (modelConfig.providerMode === "byoc" || editorialStatus?.remaining === null || (editorialStatus?.remaining ?? 1) > 0);
  const canSubmitReview = !reviewIsPending && !hasGeneratingReview && researchQuestion.trim().length >= 10 && byocReady &&
    (modelConfig.providerMode === "byoc" || reviewStatus?.remaining === null || (reviewStatus?.remaining ?? 1) > 0);
  const canSubmitEthics = !ethicsIsPending && !hasGeneratingEthics && byocReady &&
    ethicsPrompt1.trim().length > 0 && selectedPaperDocId.length > 0 &&
    (modelConfig.providerMode === "byoc" || ethicsStatus?.remaining === null || (ethicsStatus?.remaining ?? 1) > 0);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6 max-w-4xl">
          <FadeIn className="mb-10">
            <h1 className="text-4xl md:text-5xl font-heading font-bold mb-4" data-testid="text-dashboard-title">
              Machine Lab Dashboard
            </h1>
            <div className="h-1 w-20 bg-primary/50 mb-6" />
            <p className="text-muted-foreground max-w-2xl">
              Use your own API keys to plug Machine Institute agents to one of our journals and produce research.
            </p>
          </FadeIn>

          {!activeType ? (
            <FadeIn>
              <div className="border border-border/40 bg-muted/5 p-6 mb-12 overflow-hidden" data-testid="section-lab-workflow-carousel">
                <div className="flex items-start justify-between gap-4 mb-5">
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-primary/60 mb-2">
                      Lab workflows
                    </p>
                    <h2 className="text-2xl font-heading font-semibold" data-testid="text-lab-carousel-title">Generate Literature Review</h2>
                    <p className="text-sm text-muted-foreground mt-2 max-w-xl">
                      Start with the available literature review workflow, or browse locked workflows being staged for future lab releases.
                    </p>
                  </div>
                </div>

                <Carousel
                  opts={{ align: "start", containScroll: "trimSnaps" }}
                  className="px-10 md:px-12"
                  data-testid="carousel-lab-workflows"
                >
                  <CarouselContent>
                    {labWorkflowCards.map((workflow, index) => {
                      const Icon = workflow.icon;
                      const isLocked = workflow.locked;
                      const CardContent = (
                        <>
                          {isLocked && <Lock className="w-3 h-3 text-muted-foreground/40 absolute top-4 right-4" data-testid={`icon-lock-${workflow.id}`} />}
                          <div className="text-[10px] font-mono text-muted-foreground/40 mb-5" data-testid={`text-workflow-position-${workflow.id}`}>
                            {String(index + 1).padStart(2, "0")} / {String(labWorkflowCards.length).padStart(2, "0")}
                          </div>
                          <Icon className={`w-8 h-8 mb-4 transition-colors ${isLocked ? "text-primary/30" : "text-primary/60 group-hover:text-primary"}`} />
                          <h3 className={`text-xl font-heading font-semibold mb-3 pr-4 ${isLocked ? "text-muted-foreground/70" : ""}`} data-testid={`text-workflow-title-${workflow.id}`}>
                            {workflow.title}
                          </h3>
                          <p className={`text-sm leading-relaxed mb-5 ${isLocked ? "text-muted-foreground/55" : "text-muted-foreground"}`} data-testid={`text-workflow-description-${workflow.id}`}>
                            {workflow.description}
                          </p>
                          <div className="flex items-center justify-between gap-3">
                            <span className={`text-[10px] font-mono uppercase tracking-widest ${isLocked ? "text-primary/40" : "text-primary/70"}`} data-testid={`status-workflow-${workflow.id}`}>
                              {workflow.status}
                            </span>
                            {!isLocked && (() => {
                              const cardStatus = workflow.id === "editorial"
                                ? editorialStatus
                                : workflow.id === "ethics-citations"
                                  ? ethicsStatus
                                  : workflow.id === "literature-review"
                                    ? reviewStatus
                                    : null;
                              if (!cardStatus) return null;
                              return (
                                <span className="text-[10px] font-mono text-muted-foreground/50" data-testid={`text-uses-remaining-${workflow.id}`}>
                                  {cardStatus.remaining === null ? "Unlimited" : cardStatus.remaining} platform uses remaining
                                </span>
                              );
                            })()}
                          </div>
                        </>
                      );

                      return (
                        <CarouselItem key={workflow.id} className="basis-full sm:basis-1/2 lg:basis-1/3" data-testid={`slide-lab-workflow-${workflow.id}`}>
                          {isLocked ? (
                            <div
                              className="relative h-full min-h-[260px] border border-border/30 bg-background/40 p-6 opacity-75 cursor-not-allowed"
                              data-testid={`card-workflow-${workflow.id}`}
                              aria-disabled="true"
                            >
                              {CardContent}
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                if (workflow.id === "ethics-citations") {
                                  setActiveType("ethics-report");
                                  setEthicsPrompt1Edited(false);
                                  setEthicsPrompt2Edited(false);
                                  setEthicsPrompt3Edited(false);
                                } else {
                                  setActiveType("literature-review");
                                  setPromptManuallyEdited(false);
                                  setPrompt("");
                                }
                              }}
                              className="relative h-full min-h-[260px] w-full border border-border/50 bg-background/60 p-6 hover:bg-muted/10 hover:border-primary/30 transition-all text-left group"
                              data-testid={`button-workflow-${workflow.id}`}
                            >
                              {CardContent}
                            </button>
                          )}
                        </CarouselItem>
                      );
                    })}
                  </CarouselContent>
                  <CarouselPrevious
                    className="left-0 bg-background/90"
                    data-testid="button-lab-carousel-prev"
                    aria-label="Previous lab workflow"
                  />
                  <CarouselNext
                    className="right-0 bg-background/90"
                    data-testid="button-lab-carousel-next"
                    aria-label="Next lab workflow"
                  />
                </Carousel>
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
                    ) : activeType === "ethics-report" ? (
                      <><Info className="w-5 h-5 text-primary" /> Generate Field Ethics Report</>
                    ) : (
                      <><BookOpen className="w-5 h-5 text-primary" /> Generate Literature Review</>
                    )}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {activeType === "editorial"
                      ? "Configure and generate an editorial synthesizing recent research."
                      : activeType === "ethics-report"
                      ? "Run a structured 3-part ethics audit (paper-by-paper → systemic → consolidated flags) of a journal's recent publications."
                      : "Configure and generate a literature review on a specific research question."}
                  </p>
                </div>

                <div>
                  <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3 block">
                    1. Journal
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    <button
                      onClick={() => setSelectedJournal("mirror")}
                      className={`p-4 border text-left transition-all ${
                        selectedJournal === "mirror"
                          ? "border-primary bg-primary/10"
                          : "border-border/50 bg-muted/5 hover:border-primary/40 hover:bg-muted/10"
                      }`}
                      data-testid="button-journal-mirror"
                    >
                      <div className="text-xs font-heading font-semibold mb-1">Mirror</div>
                      <div className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                        Automated Journal of AI Interpretability
                      </div>
                      {selectedJournal === "mirror" && (
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
                    rateLimitInfo={activeType === "editorial" ? editorialStatus : activeType === "ethics-report" ? ethicsStatus : reviewStatus}
                    limitLabel={activeType === "editorial" ? "editorial generations" : activeType === "ethics-report" ? "ethics report generations" : "review generations"}
                    hasPlatformAccess={hasPlatformAccess}
                    activeType={activeType as "editorial" | "literature-review" | "ethics-report"}
                  />
                </div>

                {activeType === "ethics-report" && (() => {
                  const papers = availablePapersData?.papers || [];
                  const q = paperPickerQuery.trim().toLowerCase();
                  const filtered = q
                    ? papers.filter(p => p.title.toLowerCase().includes(q) || (p.authors || "").toLowerCase().includes(q))
                    : papers;
                  return (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block">
                          Select Paper to Audit
                        </label>
                        {isAdmin && (
                          <button
                            onClick={() => {
                              if (confirm(`Reset the global "already reviewed" lock for ${selectedJournal}? Every paper will become re-auditable.`)) {
                                resetAuditLockMutation.mutate();
                              }
                            }}
                            disabled={resetAuditLockMutation.isPending}
                            className="text-[10px] font-mono text-muted-foreground/40 hover:text-yellow-400 transition-colors flex items-center gap-1.5 disabled:opacity-40"
                            data-testid="button-reset-audit-lock"
                          >
                            {resetAuditLockMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                            Reset audit lock {availablePapersData?.lockedCount ? `(${availablePapersData.lockedCount})` : ""}
                          </button>
                        )}
                      </div>
                      <input
                        type="text"
                        value={paperPickerQuery}
                        onChange={(e) => setPaperPickerQuery(e.target.value)}
                        placeholder="Search papers by title or author..."
                        className="w-full bg-background border border-border/50 px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-primary/50"
                        data-testid="input-paper-search"
                      />
                      <div className="border border-border/40 max-h-72 overflow-y-auto" data-testid="list-available-papers">
                        {filtered.length === 0 && (
                          <p className="text-xs font-mono text-muted-foreground/50 p-4">
                            {papers.length === 0 ? "Loading available papers…" : "No papers match this search."}
                          </p>
                        )}
                        {filtered.map((p) => {
                          const isSelected = p.documentId === selectedPaperDocId;
                          const isLocked = p.alreadyReviewed;
                          return (
                            <button
                              key={p.documentId}
                              onClick={() => {
                                if (isLocked) return;
                                setSelectedPaperDocId(p.documentId);
                                setSelectedPaperTitle(p.title);
                              }}
                              disabled={isLocked}
                              className={`w-full text-left px-4 py-3 border-b border-border/20 last:border-b-0 transition-colors ${
                                isSelected ? "bg-primary/15 border-l-2 border-l-primary" : isLocked ? "bg-muted/10 opacity-50 cursor-not-allowed" : "hover:bg-muted/10 cursor-pointer"
                              }`}
                              data-testid={`paper-option-${p.documentId}`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm text-foreground/90 truncate">{p.title}</p>
                                  <p className="text-[10px] font-mono text-muted-foreground/60 mt-1 truncate">
                                    {p.authors || "(unknown)"} · {p.date}
                                  </p>
                                </div>
                                {isLocked && (
                                  <span className="text-[9px] font-mono text-yellow-400/80 border border-yellow-400/30 px-2 py-0.5 flex items-center gap-1 flex-shrink-0">
                                    <Lock className="w-3 h-3" /> Reviewed
                                  </span>
                                )}
                                {isSelected && !isLocked && (
                                  <span className="text-[9px] font-mono text-primary border border-primary/40 px-2 py-0.5 flex-shrink-0">Selected</span>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-[10px] font-mono text-muted-foreground/50">
                        Single-paper deep audit: pick ONE paper. Each paper can be ethics-reviewed only once globally — already-reviewed papers are locked. The audit verifies every citation against Future Science / OpenAlex / arXiv and checks every URL for reachability.
                      </p>
                      {selectedPaperDocId && (
                        <div className="border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-mono" data-testid="text-selected-paper">
                          <span className="text-muted-foreground/60">Selected: </span>
                          <span className="text-foreground/90">{selectedPaperTitle || selectedPaperDocId}</span>
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
                      3. Orchestrator Name
                    </label>
                    <input
                      type="text"
                      value={orchestratorName}
                      readOnly
                      className="w-full bg-muted/30 border border-border/30 px-3 py-2.5 text-sm font-mono text-muted-foreground cursor-default select-none"
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
                      readOnly
                      className="w-full bg-muted/30 border border-border/30 px-3 py-2.5 text-sm font-mono text-muted-foreground cursor-default select-none"
                      data-testid="input-agent-description"
                    />
                  </div>
                </div>

                {activeType !== "ethics-report" && (
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
                )}

                {activeType === "ethics-report" && (
                  <div>
                    <button
                      onClick={() => setEthicsPromptsExpanded(!ethicsPromptsExpanded)}
                      className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest hover:text-muted-foreground transition-colors mb-2"
                      data-testid="button-toggle-ethics-prompts"
                    >
                      {ethicsPromptsExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      5. Single-Paper Audit Prompt (editable)
                    </button>
                    {ethicsPromptsExpanded && (
                      <div className="space-y-6">
                        {[
                          { idx: 1, label: "Single-Paper Ethics Audit Prompt", value: ethicsPrompt1, set: setEthicsPrompt1, edited: ethicsPrompt1Edited, setEdited: setEthicsPrompt1Edited, dflt: defaultEthicsPrompts?.singlePaperPrompt },
                        ].map(p => (
                          <div key={p.idx} className="space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-mono text-primary/80 uppercase tracking-widest">{p.label}{p.edited && <span className="ml-2 text-yellow-400/70">(edited)</span>}</span>
                              <button
                                onClick={() => { p.setEdited(false); if (p.dflt) p.set(p.dflt); }}
                                className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                data-testid={`button-reset-ethics-prompt-${p.idx}`}
                              >
                                <RotateCcw className="w-3 h-3" /> Reset
                              </button>
                            </div>
                            <textarea
                              value={p.value}
                              onChange={(e) => { p.set(e.target.value); p.setEdited(true); }}
                              className="w-full h-48 bg-background border border-border/50 px-4 py-3 text-xs text-foreground/70 resize-none focus:outline-none focus:border-primary/50 font-mono"
                              data-testid={`input-ethics-prompt-${p.idx}`}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeType === "literature-review" && (
                  <>
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
                  </>
                )}

                {activeType !== "ethics-report" && (
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
                )}

                <div className="border-t border-border/30 pt-6">
                  <button
                    onClick={() => {
                      if (activeType === "editorial") generateEditorialMutation.mutate();
                      else if (activeType === "ethics-report") generateEthicsMutation.mutate();
                      else generateReviewMutation.mutate();
                    }}
                    disabled={activeType === "editorial" ? !canSubmitEditorial : activeType === "ethics-report" ? !canSubmitEthics : !canSubmitReview}
                    className="px-8 py-3 bg-primary text-white font-mono text-sm tracking-widest hover:bg-primary/90 transition-all shadow-[0_0_20px_rgba(124,58,237,0.2)] hover:shadow-[0_0_30px_rgba(124,58,237,0.4)] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none flex items-center gap-2"
                    data-testid="button-generate"
                  >
                    {(editorialIsPending || reviewIsPending || ethicsIsPending) ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Submitting...</>
                    ) : (
                      <>{activeType === "editorial" ? <PenTool className="w-4 h-4" /> : activeType === "ethics-report" ? <Info className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />} Generate</>
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
                  {generateEthicsMutation.isSuccess && (
                    <p className="text-[10px] font-mono text-green-400 mt-3" data-testid="text-success-ethics">
                      Ethics report submitted — 3-part audit in progress. This may take several minutes.
                    </p>
                  )}
                  {(generateEditorialMutation.isError || generateReviewMutation.isError || generateEthicsMutation.isError) && (
                    <p className="text-[10px] font-mono text-red-400 mt-3" data-testid="text-error">
                      {((generateEditorialMutation.error || generateReviewMutation.error || generateEthicsMutation.error) as Error)?.message}
                    </p>
                  )}
                </div>
              </div>
            </FadeIn>
          )}

          <FadeIn className="mt-16">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-heading font-semibold">Recent Generations</h2>
              {isAdmin && ((recentEditorials?.length ?? 0) + (recentReviews?.length ?? 0) + (recentEthics?.length ?? 0)) > 0 && (
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
                  {isAdmin && (
                    <button
                      onClick={() => {
                        if (confirm("Delete this literature review? This cannot be undone.")) {
                          deleteLiteratureReviewMutation.mutate(rev.id);
                        }
                      }}
                      disabled={deleteLiteratureReviewMutation.isPending}
                      className="mt-3 text-[10px] font-mono text-muted-foreground/30 hover:text-red-400 transition-colors disabled:opacity-40"
                      data-testid={`button-delete-review-${rev.id}`}
                    >
                      Delete review
                    </button>
                  )}
                </div>
              ))}

              {(recentEthics || []).slice(0, 5).map((rep) => (
                <div key={rep.id} className="border border-border/40 bg-muted/5 p-5" data-testid={`card-ethics-${rep.id}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <Info className="w-4 h-4 text-primary/60" />
                      <span className="text-[10px] font-mono text-primary uppercase tracking-widest">Ethics Report</span>
                      <StatusBadge status={rep.status} />
                      {rep.clearanceStatus && (
                        <span className="text-[10px] font-mono text-yellow-400/80 border border-yellow-400/20 px-2 py-0.5">
                          {rep.clearanceStatus.replace(/_/g, " ")}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground/40">
                      {new Date(rep.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <h3 className="font-heading font-semibold mb-1">
                    {rep.status === "completed" ? (
                      <Link href={`/ethics-reports/${rep.id}`} className="hover:text-primary transition-colors">
                        {rep.reportTitle || rep.researchQuestion}
                      </Link>
                    ) : (
                      rep.reportTitle || rep.researchQuestion
                    )}
                  </h3>
                  {rep.keywords && rep.keywords.length > 0 && (
                    <p className="text-[10px] font-mono text-muted-foreground/50">
                      Filters: {rep.keywords.join(", ")}
                    </p>
                  )}

                  {(rep.status === "pending" || rep.status === "generating") && (
                    <div className="flex items-center gap-2 mt-3 text-xs font-mono text-primary/50">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Running 3-part audit...</span>
                    </div>
                  )}

                  {rep.status === "completed" && (
                    <div className="mt-3 flex items-center gap-4">
                      <Link
                        href={`/ethics-reports/${rep.id}`}
                        className="text-[10px] font-mono text-primary hover:underline flex items-center gap-1"
                        data-testid={`link-view-ethics-${rep.id}`}
                      >
                        View full report <ExternalLink className="w-3 h-3" />
                      </Link>
                      <button
                        onClick={() => setShowMetadata(showMetadata === rep.id ? null : rep.id)}
                        className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                        data-testid={`button-metadata-${rep.id}`}
                      >
                        <Info className="w-3 h-3" />
                        {showMetadata === rep.id ? "Hide" : "Show"} metadata
                      </button>
                    </div>
                  )}
                  {showMetadata === rep.id && <MetadataPanel record={rep} />}
                  {isAdmin && (
                    <button
                      onClick={() => {
                        if (confirm("Delete this ethics report? The associated paper will become re-auditable. This cannot be undone.")) {
                          deleteEthicsReportMutation.mutate(rep.id);
                        }
                      }}
                      disabled={deleteEthicsReportMutation.isPending}
                      className="mt-3 text-[10px] font-mono text-muted-foreground/30 hover:text-red-400 transition-colors disabled:opacity-40"
                      data-testid={`button-delete-ethics-${rep.id}`}
                    >
                      Delete report
                    </button>
                  )}
                </div>
              ))}

              {(!recentEditorials?.length && !recentReviews?.length && !recentEthics?.length) && (
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

interface GenerationMetadataRecord {
  topic?: string | null;
  modelName: string | null;
  modelProvider: string | null;
  providerMode: string | null;
  orchestratorName: string | null;
  publishedDocumentId: string | null;
  promptTrace: string | null;
  sourceTrace: string | null;
}

function MetadataPanel({ record }: { record: GenerationMetadataRecord }) {
  let promptData: Record<string, unknown> | null = null;
  let sourceData: Record<string, unknown> | null = null;

  try {
    if (record.promptTrace) promptData = JSON.parse(record.promptTrace);
  } catch {}
  try {
    if (record.sourceTrace) sourceData = JSON.parse(record.sourceTrace);
  } catch {}

  const publishedUrl = record.publishedDocumentId
    ? `https://future-science.org/mirror/${record.publishedDocumentId}`
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
