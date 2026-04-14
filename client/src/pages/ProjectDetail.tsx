import { useParams, Link } from "wouter";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn } from "@/components/ui/motion";
import { projects } from "@/lib/mockData";
import { ArrowLeft, ExternalLink, Lock, FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface LiteratureReview {
  id: string;
  projectId: string;
  agentId: string;
  researchQuestion: string;
  topic: string | null;
  orchestratorName: string | null;
  createdAt: string;
  completedAt: string | null;
  status: string;
}

interface FSAuthor {
  firstName?: string;
  lastName?: string;
}

interface FSContribution {
  title?: string;
  subtitle?: string;
  slug?: string;
  documentId?: string;
  publishedAt?: string;
  author?: FSAuthor | FSAuthor[];
}

interface FSResponse {
  data?: FSContribution[];
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const project = projects.find((p) => p.id === id);
  const queryClient = useQueryClient();

  const { data: literatureReviews, isLoading: reviewsLoading } = useQuery<LiteratureReview[]>({
    queryKey: ["/api/literature-reviews", id],
    queryFn: async () => {
      const res = await fetch(`/api/literature-reviews?projectId=${id}`);
      if (!res.ok) throw new Error("Failed to fetch literature reviews");
      return res.json();
    },
    enabled: !!id && !!project && project.status !== "locked",
  });

  const { data: publicationsData, isLoading: pubsLoading } = useQuery<FSResponse>({
    queryKey: ["/api/initiative-publications"],
    queryFn: async () => {
      const res = await fetch("/api/initiative-publications");
      if (!res.ok) throw new Error("Failed to fetch publications");
      return res.json();
    },
    enabled: !!project && project.status !== "locked",
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/initiative-publications/sync", { method: "POST" });
      if (!res.ok) throw new Error("Sync failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/initiative-publications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/research/events"] });
    },
  });

  if (!project) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col">
        <Navigation />
        <div className="pt-28 container mx-auto px-6 text-center flex-1">
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
      <div className="min-h-screen bg-background text-foreground flex flex-col">
        <Navigation />
        <main className="pt-28 pb-24 flex-1">
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

  const completedReviews = (literatureReviews || []).filter((r) => r.status === "completed");
  const allPublications = publicationsData?.data ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Navigation />
      <main className="pt-28 pb-24 flex-1">
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
            <div className="text-lg text-muted-foreground leading-relaxed mb-8 max-w-3xl space-y-4">
              {project.longDescription?.split("\n\n").map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>

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

          <FadeIn delay={0.2} className="mt-16">
            <div className="flex items-center gap-3 mb-6">
              <h2 className="text-2xl font-heading font-bold" data-testid="heading-literature-reviews">Literature Reviews</h2>
            </div>
            {reviewsLoading ? (
              <p className="text-sm text-muted-foreground font-mono" data-testid="status-reviews-loading">Loading reviews…</p>
            ) : completedReviews.length === 0 ? (
              <div className="border border-border/20 bg-muted/5 p-8 text-center" data-testid="empty-state-reviews">
                <FileText className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground font-mono">No literature reviews yet for this project.</p>
              </div>
            ) : (
              <div className="space-y-3" data-testid="list-literature-reviews">
                {completedReviews.map((review) => (
                  <div
                    key={review.id}
                    className="border border-border/20 bg-muted/5 p-4 flex items-start justify-between gap-4"
                    data-testid={`card-review-${review.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" data-testid={`text-review-topic-${review.id}`}>
                        {review.topic || review.researchQuestion}
                      </p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground font-mono">
                        <span data-testid={`text-review-agent-${review.id}`}>
                          {review.orchestratorName || review.agentId}
                        </span>
                        <span>·</span>
                        <span data-testid={`text-review-date-${review.id}`}>
                          {review.completedAt
                            ? new Date(review.completedAt).toLocaleDateString()
                            : new Date(review.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <Link
                      href={`/literature-reviews/${review.id}`}
                      className="text-xs font-mono text-primary hover:underline whitespace-nowrap flex items-center gap-1"
                      data-testid={`link-review-${review.id}`}
                    >
                      View review <ExternalLink className="w-3 h-3" />
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </FadeIn>

          <FadeIn delay={0.3} className="mt-16">
            <div className="flex items-center gap-3 mb-6">
              <h2 className="text-2xl font-heading font-bold" data-testid="heading-publication-log">Publication Log</h2>
              <button
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                className="ml-auto flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                data-testid="button-sync-publications"
                title="Update publication log"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
                {syncMutation.isPending ? "Updating…" : "Update"}
              </button>
            </div>
            {pubsLoading ? (
              <p className="text-sm text-muted-foreground font-mono" data-testid="status-pubs-loading">Loading publications…</p>
            ) : allPublications.length === 0 ? (
              <div className="border border-border/20 bg-muted/5 p-8 text-center" data-testid="empty-state-publications">
                <FileText className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground font-mono">No publications found for this initiative.</p>
              </div>
            ) : (
              <div className="space-y-2" data-testid="list-publications">
                {allPublications.map((pub, idx) => {
                  const authors: FSAuthor[] = Array.isArray(pub.author)
                    ? pub.author
                    : pub.author
                    ? [pub.author]
                    : [];
                  const authorList = authors
                    .map((a) => `${a.firstName || ""} ${a.lastName || ""}`.trim())
                    .filter((s) => s.length > 0)
                    .join(", ");
                  const title = pub.subtitle
                    ? `${pub.title || ""}: ${pub.subtitle}`
                    : pub.title || "Untitled";
                  const date = pub.publishedAt
                    ? new Date(pub.publishedAt).toLocaleDateString()
                    : null;
                  const paperUrl = pub.slug
                    ? `https://future-science.org/papers/${pub.slug}`
                    : pub.documentId
                    ? `https://future-science.org/papers/${pub.documentId}`
                    : null;
                  const key = pub.documentId || pub.slug || String(idx);

                  return (
                    <div
                      key={key}
                      className="border border-border/20 bg-muted/5 p-4 flex items-start justify-between gap-4"
                      data-testid={`card-publication-${key}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium" data-testid={`text-publication-title-${key}`}>{title}</p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground font-mono">
                          {authorList && (
                            <>
                              <span data-testid={`text-publication-authors-${key}`}>{authorList}</span>
                              <span>·</span>
                            </>
                          )}
                          {date && <span data-testid={`text-publication-date-${key}`}>{date}</span>}
                        </div>
                      </div>
                      {paperUrl && (
                        <a
                          href={paperUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="whitespace-nowrap flex items-center gap-1 text-xs font-mono text-primary hover:underline"
                          data-testid={`link-publication-${key}`}
                        >
                          View <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </FadeIn>

        </div>
      </main>
      <Footer />
    </div>
  );
}
