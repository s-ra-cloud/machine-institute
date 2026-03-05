import { Navigation } from "@/components/Navigation";
import { Hero } from "@/components/Hero";
import { FadeIn, StaggerContainer, StaggerItem } from "@/components/ui/motion";
import { LatestPublications } from "@/components/LatestPublications";
import { Footer } from "@/components/Footer";
import { projects } from "@/lib/mockData";
import { Link } from "wouter";
import { ArrowRight, Lock } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground relative">
      <Navigation />
      <main>
        <Hero />

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
                      <div className="h-full p-8 border border-border/50 bg-muted/20 hover:bg-muted/40 hover:border-primary/30 transition-all cursor-pointer group" data-testid={`card-project-${project.id}`}>
                        {project.featured && (
                          <span className="text-[10px] font-mono text-primary uppercase tracking-widest mb-4 block">Featured</span>
                        )}
                        <h3 className="text-xl font-heading font-semibold mb-3 group-hover:text-primary transition-colors">{project.title}</h3>
                        <p className="text-sm text-muted-foreground leading-relaxed">{project.shortDescription}</p>
                        <div className="mt-4 flex items-center gap-2 text-xs font-mono text-primary">
                          View project <ArrowRight className="w-3 h-3" />
                        </div>
                      </div>
                    </Link>
                  ) : (
                    <div className="h-full p-8 border border-border/30 bg-muted/10 relative overflow-hidden" data-testid={`card-project-${project.id}`}>
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