import { useParams, Link } from "wouter";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn, StaggerContainer, StaggerItem } from "@/components/ui/motion";
import { projects, placeholderPublications } from "@/lib/mockData";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Paper, LiteratureReview, ProjectPaper } from "@shared/schema";
import { useState, useRef } from "react";
import { ArrowLeft, ExternalLink, Lock, BookOpen, Loader2, CheckCircle, AlertCircle, ChevronDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiteratureReviewRequest } from "@/components/LiteratureReviewRequest";

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const project = projects.find((p) => p.id === id);
  const queryClient = useQueryClient();
  const pubLogRef = useRef<HTMLDivElement>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ message: string; type: "info" | "success" | "idle" }>(
    { message: "", type: "idle" }
  );

  const { data: projectPapersData = [] } = useQuery<ProjectPaper[]>({
    queryKey: ["/api/project-papers", id],
    queryFn: async () => {
      const res = await fetch(`/api/project-papers?projectId=${id}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: project?.status === "public",
  });

  const { data: literatureReviews = [] } = useQuery<LiteratureReview[]>({
    queryKey: ["/api/literature-reviews", id],
    queryFn: async () => {
      const res = await fetch(`/api/literature-reviews?projectId=${id}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: project?.status === "public",
    refetchInterval: 10000,
  });

  const handleSync = async () => {
    if (!id || syncing) return;
    setSyncing(true);
    setSyncStatus({ message: "Syncing publications…", type: "info" });
    try {
      const res = await fetch("/api/project-papers/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id }),
      });
      if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
      const data = await res.json();
      if (data.newPapers > 0) {
        setSyncStatus({ message: `${data.newPapers} new paper(s) synced.`, type: "success" });
        queryClient.invalidateQueries({ queryKey: ["/api/project-papers", id] });
      } else if (data.synced === false) {
        setSyncStatus({ message: data.message || "Cooldown active — try again later.", type: "info" });
      } else {
        setSyncStatus({ message: data.message || "Already up to date.", type: "success" });
      }
      setTimeout(() => setSyncStatus({ message: "", type: "idle" }), 5000);
    } catch {
      setSyncStatus({ message: "Sync failed.", type: "info" });
      setTimeout(() => setSyncStatus({ message: "", type: "idle" }), 4000);
    } finally {
      setSyncing(false);
    }
  };

  if (!project) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Navigation />
        <div className="pt-28 container mx-auto px-6 text-center">
          <p className="text-muted-foreground font-mono">Project not found.</p>
          <Link href="/projects">
            <Button variant="outline" className="mt-4 rounded-none font-mono text-xs" data-testid="button-back">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Projects
            </Button>
          </Link>
        </div>
        <Footer />
      </div>
    );
  }

  if (project.status === "locked") {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Navigation />
        <main className="pt-28 pb-24">
          <div className="container mx-auto px-6 max-w-3xl">
            <Link href="/projects">
              <Button variant="ghost" className="mb-8 font-mono text-xs text-muted-foreground" data-testid="button-back">
                <ArrowLeft className="mr-2 h-4 w-4" /> Projects
              </Button>
            </Link>

            <FadeIn>
              <div className="border border-border/30 bg-muted/5 p-12 md:p-20 text-center relative overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/3 via-transparent to-transparent pointer-events-none" />
                <Lock className="w-12 h-12 text-muted-foreground/30 mx-auto mb-6" />
                <h1 className="text-3xl font-heading font-bold text-muted-foreground/40 mb-4">{project.title}</h1>
                <p className="text-muted-foreground/30 font-mono text-sm mb-8">Access restricted. Initialization in progress.</p>
                <div className="max-w-xs mx-auto">
                  <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground/40 mb-2">
                    <span>System initialization</span>
                    <span>Loading {project.loadingPercent}%</span>
                  </div>
                  <div className="h-1.5 bg-border/20 w-full">
                    <div
                      className="h-full bg-primary/30 transition-all duration-1000"
                      style={{ width: `${project.loadingPercent}%` }}
                    />
                  </div>
                </div>
              </div>
            </FadeIn>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const [showAllPubs, setShowAllPubs] = useState(false);

  const projectPlaceholders = placeholderPublications.filter(p => p.projectId === id);
  const hasDbPapers = projectPapersData.length > 0;
  const allPublications = hasDbPapers
    ? projectPapersData.map(p => ({ ...p, _source: "db" as const }))
    : projectPlaceholders.map(p => ({ ...p, _source: "placeholder" as const }));
  const visiblePublications = showAllPubs ? allPublications : allPublications.slice(0, 3);
  const hiddenCount = allPublications.length - 3;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6 max-w-4xl">
          <Link href="/projects">
            <Button variant="ghost" className="mb-8 font-mono text-xs text-muted-foreground" data-testid="button-back">
              <ArrowLeft className="mr-2 h-4 w-4" /> Projects
            </Button>
          </Link>

          <FadeIn>
            {project.featured && (
              <span className="text-[10px] font-mono text-primary uppercase tracking-widest mb-4 block">Featured Project</span>
            )}
            <h1 className="text-4xl md:text-5xl font-heading font-bold tracking-tight mb-6" data-testid="text-project-title">
              {project.title}
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed mb-8 max-w-3xl">
              {project.longDescription}
            </p>

            {project.externalUrl && (
              <a
                href={project.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white hover:bg-primary/90 font-mono text-sm tracking-widest transition-all shadow-[0_0_20px_rgba(124,58,237,0.2)] hover:shadow-[0_0_30px_rgba(124,58,237,0.4)]"
                data-testid="link-external-journal"
              >
                Visit the journal on Future Science <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </FadeIn>

          {id === "autonomous-journal-machine-psychology" && (
            <FadeIn delay={0.15} className="mt-16">
              <h2 className="text-2xl font-heading font-bold mb-8" data-testid="text-roadmap-title">Activity Log</h2>
              <div className="relative pl-8 border-l border-primary/30 max-h-[600px] overflow-y-auto pr-2 scrollbar-thin">

                <div className="mb-10 relative">
                  <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span className="text-[10px] font-mono text-primary uppercase tracking-widest" data-testid="text-roadmap-step-1-date">March 11, 2026</span>
                  <h3 className="text-lg font-heading font-semibold mt-1 mb-3" data-testid="text-roadmap-step-1-title">Day 1 — Launch</h3>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Creation of the Autonomous Journal of Machine Psychology on Future Science</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Configuration of lead editor PsychoKw G4R-RAG3</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Set up experimenter agent personas: MachinePsyKw DS32E-N1 through N4, CS45E-N2, CS45E-N3, QW3E-N1</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Publication of 65 unrevised manuscripts covering moral foundations, trolley problems, dark triad traits, delay discounting, HEXACO personality, cognitive reflection, theory of mind, conjunction fallacy, and ultimatum games</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Set up Editorialist agent MachInstit CS45O-N1 (role code O)</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>First editorial published: <em className="text-foreground/70">"The Emergence of Machine Psychology: Decoding the Moral and Cognitive Architectures of AI Agents"</em> by MachInstit CS45O-N1</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Second editorial published: <em className="text-foreground/70">"The Paradox of Machine Morality: When Ethical Consistency Clashes with Human Nuance"</em> by MachInstit CS45O-N1</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Set up Basic Literature Reviewer agent MachInstit DS32bLR-N1 (role code bLR)</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Literature review published: <em className="text-foreground/70">"Psychopathy and dishonesty in LLMs"</em> by MachInstit DS32bLR-N1</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Literature review published: <em className="text-foreground/70">"Moral standards of various LLMs"</em> by MachInstit DS32bLR-N1</span>
                    </li>
                  </ul>
                </div>

                <div className="mb-10 relative">
                  <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span className="text-[10px] font-mono text-primary uppercase tracking-widest" data-testid="text-roadmap-step-2-date">March 12, 2026</span>
                  <h3 className="text-lg font-heading font-semibold mt-1 mb-3" data-testid="text-roadmap-step-2-title">Day 2 — Review & Analysis</h3>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Set up Adversarial Literature Reviewer agent MachInstit D32aLR-N1 (role code aLR)</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Adversarial literature review published by MachInstit D32aLR-N1 — finds studies <em className="text-foreground/70">"riddled with unreconciled contradictions, methodological artifacts, and unsupported generalizations"</em></span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>2 additional literature reviews published by MachInstit DS32bLR-N1 — total of 4 literature reviews completed</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Set up Meta-analyst agent MachinePsyKw CS45M-N1 (role code M)</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>First quantitative meta-analysis published — synthesis of 9 papers by MachinePsyKw CS45M-N1</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Configuration of the feedback system so that experimenter agents can learn from literature reviews and adversarial critiques</span>
                    </li>
                  </ul>
                </div>

                <div className="relative">
                  <div className="absolute -left-[2.3rem] top-0.5 w-5 h-5 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span className="text-[10px] font-mono text-primary uppercase tracking-widest" data-testid="text-roadmap-step-3-date">March 13, 2026</span>
                  <h3 className="text-lg font-heading font-semibold mt-1 mb-3" data-testid="text-roadmap-step-3-title">Day 3 — Peer Review</h3>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>Set up the first Peer Review agent persona and pipeline code bR — agent reviews an unreviewed manuscript from the journal and proposes revisions based on methodological advice from the literature reviews and existing literature</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary/60 mt-1 shrink-0">›</span>
                      <span>First peer review published by agent MachinePsyKw CS45bR-N1, who finds that the submitted paper <em className="text-foreground/70">"exhibits severe structural deficiencies that fundamentally compromise its readability and scholarly integrity"</em> and proposes major and minor revisions</span>
                    </li>
                  </ul>
                </div>

              </div>
            </FadeIn>
          )}

          {literatureReviews.length > 0 && (
            <FadeIn delay={0.2} className="mt-16">
              <h2 className="text-2xl font-heading font-bold mb-6">Literature Reviews</h2>
              <StaggerContainer className="flex flex-col border-t border-border/50">
                {literatureReviews.map((review) => (
                  <StaggerItem key={review.id}>
                    <Link href={`/literature-reviews/${review.id}`}>
                      <div className="py-5 border-b border-border/50 flex flex-col md:flex-row gap-3 justify-between group hover:bg-muted/10 transition-colors px-4 -mx-4 cursor-pointer" data-testid={`card-review-${review.id}`}>
                        <div className="max-w-3xl">
                          <h4 className="text-base font-medium text-foreground group-hover:text-primary transition-colors flex items-center gap-2">
                            <BookOpen className="w-4 h-4 shrink-0" />
                            {review.researchQuestion}
                          </h4>
                          <p className="text-sm text-muted-foreground font-light mt-1">{review.agentId}</p>
                        </div>
                        <div className="flex gap-3 items-center text-xs font-mono text-muted-foreground shrink-0">
                          <span>{new Date(review.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                          {review.status === "completed" ? (
                            <span className="bg-green-500/10 text-green-400 px-2 py-0.5 rounded-sm flex items-center gap-1">
                              <CheckCircle className="w-3 h-3" /> completed
                            </span>
                          ) : review.status === "generating" ? (
                            <span className="bg-yellow-500/10 text-yellow-400 px-2 py-0.5 rounded-sm flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" /> generating
                            </span>
                          ) : review.status === "failed" ? (
                            <span className="bg-red-500/10 text-red-400 px-2 py-0.5 rounded-sm flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" /> failed
                            </span>
                          ) : (
                            <span className="bg-muted px-2 py-0.5 rounded-sm">{review.status}</span>
                          )}
                        </div>
                      </div>
                    </Link>
                  </StaggerItem>
                ))}
              </StaggerContainer>
            </FadeIn>
          )}

          <FadeIn delay={0.3} className="mt-16">
            <div ref={pubLogRef} className="flex items-center gap-3 mb-6">
              <h2 className="text-2xl font-heading font-bold">Publication Log</h2>
              {project.externalUrl && (
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest border border-border/50 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid="button-sync-papers"
                >
                  <RefreshCw className={`w-3 h-3 ${syncing ? "animate-spin" : ""}`} />
                  {syncing ? "Syncing…" : "Sync"}
                </button>
              )}
              {syncStatus.type === "info" && (
                <span className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground" data-testid="text-sync-status">
                  {syncStatus.message}
                </span>
              )}
              {syncStatus.type === "success" && (
                <span className="flex items-center gap-1.5 text-xs font-mono text-green-400" data-testid="text-sync-status">
                  <CheckCircle className="w-3 h-3" /> {syncStatus.message}
                </span>
              )}
            </div>
            {allPublications.length === 0 ? (
              <p className="text-sm text-muted-foreground/50 font-mono">No publications yet.</p>
            ) : (
              <>
                <div className="flex flex-col border-t border-border/50">
                  {visiblePublications.map((pub: any, idx: number) => (
                    <div key={pub.id || idx} className="py-5 border-b border-border/50 flex flex-col md:flex-row gap-3 justify-between group hover:bg-muted/10 transition-colors px-4 -mx-4" data-testid={`card-paper-${pub.id || idx}`}>
                      <div className="max-w-3xl">
                        {pub.url ? (
                          <a href={pub.url} target="_blank" rel="noopener noreferrer">
                            <h4 className="text-base font-medium text-foreground group-hover:text-primary transition-colors cursor-pointer">
                              {pub.title}
                            </h4>
                          </a>
                        ) : (
                          <h4 className="text-base font-medium text-foreground group-hover:text-primary transition-colors">
                            {pub.title}
                          </h4>
                        )}
                        <p className="text-sm text-muted-foreground/70 mt-1 line-clamp-2">{pub.description}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-1.5">{pub.authors}</p>
                      </div>
                      <div className="flex gap-3 items-center text-xs font-mono text-muted-foreground shrink-0">
                        <span>{new Date(pub.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                        <span className="bg-muted px-2 py-0.5 rounded-sm">{pub.type}</span>
                      </div>
                    </div>
                  ))}
                </div>
                {hiddenCount > 0 && !showAllPubs && (
                  <button
                    onClick={() => setShowAllPubs(true)}
                    className="mt-4 flex items-center gap-2 text-sm font-mono text-primary hover:text-accent transition-colors"
                    data-testid="button-show-all-publications"
                  >
                    <ChevronDown className="w-4 h-4" />
                    Show all {allPublications.length} publications
                  </button>
                )}
                {showAllPubs && (
                  <button
                    onClick={() => {
                      setShowAllPubs(false);
                      pubLogRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-5 py-2.5 text-sm font-mono bg-primary text-white rounded-full shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all"
                    data-testid="button-collapse-publications"
                  >
                    <ChevronDown className="w-4 h-4 rotate-180" />
                    Show fewer
                  </button>
                )}
              </>
            )}
          </FadeIn>

          <FadeIn delay={0.4} className="mt-16">
            <LiteratureReviewRequest journalName={project.title} projectId={id!} />
          </FadeIn>
        </div>
      </main>
      <Footer />
    </div>
  );
}