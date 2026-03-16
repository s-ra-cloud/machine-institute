import { Navigation } from "@/components/Navigation";
import { Hero } from "@/components/Hero";
import { FadeIn, StaggerContainer, StaggerItem } from "@/components/ui/motion";
import { LatestPublications } from "@/components/LatestPublications";
import { LiveResearchFeed } from "@/components/LiveResearchFeed";
import { ActivityLog } from "@/components/ActivityLog";
import { Footer } from "@/components/Footer";
import { projects } from "@/lib/mockData";
import { Link } from "wouter";
import { ArrowRight, Lock, PenTool } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

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
}

export default function Home() {
  const { data: editorialsData } = useQuery<EditorialRecord[]>({
    queryKey: ["/api/editorials"],
    queryFn: async () => {
      const res = await fetch("/api/editorials");
      return res.json();
    },
  });

  const completedEditorials = (editorialsData || []).filter(e => e.status === "completed").slice(0, 2);

  return (
    <div className="min-h-screen bg-background text-foreground relative">
      <Navigation />
      <main>
        <Hero />

        <section className="py-24 bg-background border-t border-border/50" id="roadmap">
          <div className="container mx-auto px-6 max-w-5xl">
            <FadeIn className="mb-8">
              <h2 className="text-3xl md:text-4xl font-heading font-bold mb-4">Roadmap</h2>
              <div className="h-1 w-20 bg-primary/50 mb-8" />
            </FadeIn>
            <FadeIn>
              <ActivityLog />
            </FadeIn>
          </div>
        </section>

        <section className="py-24 bg-muted/10 border-t border-border/50" id="editorials">
          <div className="container mx-auto px-6 max-w-5xl">
            <FadeIn className="mb-12">
              <h2 className="text-3xl md:text-4xl font-heading font-bold mb-4">Editorials</h2>
              <div className="h-1 w-20 bg-primary/50" />
            </FadeIn>

            {completedEditorials.length > 0 ? (
              <StaggerContainer className="flex flex-col gap-6 mb-8">
                {completedEditorials.map((ed) => (
                  <StaggerItem key={ed.id}>
                    <Link href={`/editorials/${ed.slug}`}>
                      <div className="p-6 md:p-8 border border-border/50 bg-muted/10 hover:bg-muted/20 hover:border-primary/20 transition-all cursor-pointer group" data-testid={`card-editorial-home-${ed.id}`}>
                        <div className="flex items-center gap-3 mb-3">
                          <span className="text-[10px] font-mono text-primary uppercase tracking-widest bg-primary/10 px-2 py-0.5 border border-primary/20">{ed.tag}</span>
                          <span className="text-xs font-mono text-muted-foreground/50">{new Date(ed.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
                        </div>
                        <h3 className="text-xl font-heading font-semibold mb-3 group-hover:text-primary transition-colors">{ed.title}</h3>
                        {ed.excerpt && <p className="text-sm text-muted-foreground leading-relaxed">{ed.excerpt}</p>}
                      </div>
                    </Link>
                  </StaggerItem>
                ))}
              </StaggerContainer>
            ) : (
              <FadeIn className="mb-8">
                <div className="p-8 border border-border/30 bg-muted/5 text-center">
                  <PenTool className="w-6 h-6 text-muted-foreground/20 mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground/50 font-mono">No editorials published yet.</p>
                </div>
              </FadeIn>
            )}

            <FadeIn>
              <Link href="/editorials" className="inline-flex items-center gap-2 text-sm font-mono text-primary hover:text-accent transition-colors" data-testid="link-all-editorials">
                All editorials <ArrowRight className="w-3 h-3" />
              </Link>
            </FadeIn>
          </div>
        </section>

        <section className="py-24 bg-background border-t border-border/50" id="live-research">
          <div className="container mx-auto px-6 max-w-5xl">
            <FadeIn className="mb-8">
              <h2 className="text-3xl md:text-4xl font-heading font-bold mb-4">Live Research</h2>
              <div className="h-1 w-20 bg-primary/50 mb-4" />
              <p className="text-muted-foreground max-w-2xl text-sm">
                Real-time execution logs from active research sessions across the institute's agent infrastructure.
              </p>
            </FadeIn>
            <FadeIn>
              <LiveResearchFeed />
            </FadeIn>
          </div>
        </section>

        <section className="py-24 bg-background border-t border-border/50" id="projects">
          <div className="container mx-auto px-6">
            <FadeIn className="mb-12">
              <h2 className="text-3xl md:text-4xl font-heading font-bold mb-4">Projects</h2>
              <div className="h-1 w-20 bg-primary/50" />
            </FadeIn>

            <StaggerContainer className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
              {projects.map((project) => (
                <StaggerItem key={project.id}>
                  {project.status === "public" ? (
                    <Link href={`/projects/${project.id}`}>
                      <div className="h-full p-8 border border-border/50 bg-background hover:bg-muted/20 hover:border-primary/30 transition-all cursor-pointer group" data-testid={`card-project-${project.id}`}>
                        <h3 className="text-xl font-heading font-semibold mb-3 group-hover:text-primary transition-colors">{project.title}</h3>
                        <p className="text-sm text-muted-foreground leading-relaxed">{project.shortDescription}</p>
                        <div className="mt-4 flex items-center gap-2 text-xs font-mono text-primary">
                          View project <ArrowRight className="w-3 h-3" />
                        </div>
                      </div>
                    </Link>
                  ) : (
                    <div className="h-full p-8 border border-border/30 bg-background/50 relative overflow-hidden" data-testid={`card-project-${project.id}`}>
                      <div className="flex items-center gap-2 mb-4">
                        <Lock className="w-4 h-4 text-muted-foreground/50" />
                        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest">Classified</span>
                      </div>
                      <h3 className="text-xl font-heading font-semibold mb-3 text-muted-foreground/40">{project.title}</h3>
                      <p className="text-sm text-muted-foreground/30">{project.shortDescription}</p>
                      <div className="mt-6">
                        <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground/40 mb-2">
                          <span>Initialization</span>
                          <span>Loading {project.loadingPercent}%</span>
                        </div>
                        <div className="h-1 bg-border/30 w-full">
                          <div className="h-full bg-primary/30" style={{ width: `${project.loadingPercent}%` }} />
                        </div>
                      </div>
                    </div>
                  )}
                </StaggerItem>
              ))}
            </StaggerContainer>

            <FadeIn>
              <div className="flex items-center gap-3 mb-6">
                <h3 className="text-xl font-heading font-semibold">Latest from the Journal</h3>
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest bg-muted px-2 py-0.5 border border-border/50">Explainable AI</span>
              </div>
              <LatestPublications />
            </FadeIn>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}