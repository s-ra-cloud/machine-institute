import { useParams, Link } from "wouter";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn, StaggerContainer, StaggerItem } from "@/components/ui/motion";
import { projects, placeholderPublications } from "@/lib/mockData";
import { useQuery } from "@tanstack/react-query";
import type { Paper, LiteratureReview } from "@shared/schema";
import { ArrowLeft, ExternalLink, Lock, BookOpen, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiteratureReviewRequest } from "@/components/LiteratureReviewRequest";

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const project = projects.find((p) => p.id === id);

  const { data: apiPapers = [] } = useQuery<(Paper & { publicationUrl: string })[]>({
    queryKey: ["/api/papers"],
    queryFn: async () => {
      const res = await fetch("/api/papers");
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

  const projectPlaceholders = placeholderPublications.filter(p => p.projectId === id);
  const hasApiPapers = apiPapers.length > 0;
  const allPublications = hasApiPapers
    ? [...apiPapers.slice(0, 10).map(p => ({ ...p, _source: "api" as const })), ...projectPlaceholders.map(p => ({ ...p, _source: "placeholder" as const }))]
    : projectPlaceholders.map(p => ({ ...p, _source: "placeholder" as const }));

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

          <FadeIn delay={0.2} className="mt-16">
            <h2 className="text-2xl font-heading font-bold mb-6">Latest Publications</h2>
            {allPublications.length === 0 ? (
              <p className="text-sm text-muted-foreground/50 font-mono">No publications yet.</p>
            ) : (
              <StaggerContainer className="flex flex-col border-t border-border/50">
                {allPublications.map((pub: any, idx: number) => (
                  <StaggerItem key={pub.id || idx}>
                    <div className="py-5 border-b border-border/50 flex flex-col md:flex-row gap-3 justify-between group hover:bg-muted/10 transition-colors px-4 -mx-4">
                      <div className="max-w-3xl">
                        {pub._source === "api" && pub.slug ? (
                          <Link href={`/papers/${pub.slug}`}>
                            <h4 className="text-base font-medium text-foreground group-hover:text-primary transition-colors cursor-pointer">
                              {pub.title}
                            </h4>
                          </Link>
                        ) : pub._source === "placeholder" && pub.url ? (
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
                        <p className="text-sm text-muted-foreground font-light mt-1">
                          {pub._source === "api" ? `${pub.authorFirstName} ${pub.authorLastName}` : pub.authors}
                        </p>
                      </div>
                      <div className="flex gap-3 items-center text-xs font-mono text-muted-foreground shrink-0">
                        <span>{new Date(pub._source === "api" ? pub.publishedAt : pub.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                        <span className="bg-muted px-2 py-0.5 rounded-sm">{pub.type}</span>
                      </div>
                    </div>
                  </StaggerItem>
                ))}
              </StaggerContainer>
            )}
          </FadeIn>

          {literatureReviews.length > 0 && (
            <FadeIn delay={0.3} className="mt-16">
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

          <FadeIn delay={0.4} className="mt-16">
            <LiteratureReviewRequest journalName={project.title} projectId={id!} initiativeSlug={project.id === "autonomous-journal-machine-psychology" ? "autonomous-journal-of-machine-psychology" : undefined} />
          </FadeIn>
        </div>
      </main>
      <Footer />
    </div>
  );
}