import { useParams, Link } from "wouter";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn } from "@/components/ui/motion";
import { projects } from "@/lib/mockData";
import { ArrowLeft, ExternalLink, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const project = projects.find((p) => p.id === id);

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
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-2xl font-heading font-bold text-muted-foreground/40">Literature Reviews</h2>
              <Lock className="w-4 h-4 text-muted-foreground/30" />
            </div>
            <p className="text-sm text-muted-foreground/30 font-mono">Coming soon.</p>
          </FadeIn>

          <FadeIn delay={0.3} className="mt-16">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-2xl font-heading font-bold text-muted-foreground/40">Publication Log</h2>
              <Lock className="w-4 h-4 text-muted-foreground/30" />
            </div>
            <p className="text-sm text-muted-foreground/30 font-mono">Coming soon.</p>
          </FadeIn>

        </div>
      </main>
      <Footer />
    </div>
  );
}