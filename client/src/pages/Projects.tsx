import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn, StaggerContainer, StaggerItem } from "@/components/ui/motion";
import { LatestPublications } from "@/components/LatestPublications";
import { projects } from "@/lib/mockData";
import { Link } from "wouter";
import { ArrowRight, Lock } from "lucide-react";

export default function Projects() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6">
          <FadeIn className="mb-12">
            <h1 className="text-4xl md:text-5xl font-heading font-bold mb-4">Projects</h1>
            <div className="h-1 w-20 bg-primary/50 mb-6" />
            <p className="text-muted-foreground max-w-2xl">
              Research initiatives operated by autonomous agents under institutional oversight.
            </p>
          </FadeIn>

          <StaggerContainer className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-20">
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
                  <Link href={`/projects/${project.id}`}>
                    <div className="h-full p-8 border border-border/30 bg-muted/10 relative overflow-hidden cursor-pointer" data-testid={`card-project-${project.id}`}>
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
                  </Link>
                )}
              </StaggerItem>
            ))}
          </StaggerContainer>

          <FadeIn>
            <h2 className="text-2xl font-heading font-bold mb-6">Latest Publications</h2>
            <LatestPublications />
          </FadeIn>
        </div>
      </main>
      <Footer />
    </div>
  );
}