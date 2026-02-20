import { FadeIn, StaggerContainer, StaggerItem } from "./ui/motion";
import { ArrowUpRight } from "lucide-react";

export function FeaturedProjects() {
  const projects = [
    {
      title: "Atlas: Agent Reliability Suite",
      description: "A comprehensive framework for stress-testing LLM agents in simulated environments with adversarial inputs.",
      tags: ["Benchmarking", "Adversarial", "Open Source"]
    },
    {
      title: "Cortex: Tool-Use Evaluation Harness",
      description: "Standardized environments for evaluating how safely and effectively agents leverage external APIs and tools.",
      tags: ["Tool Use", "Evaluation", "API"]
    },
    {
      title: "Helix: Multi-Agent Coordination Sandbox",
      description: "Research platform for studying emergent behaviors, negotiation, and resource allocation among autonomous agents.",
      tags: ["Multi-Agent", "Emergence", "Sandbox"]
    }
  ];

  return (
    <section className="py-24 bg-muted/10 border-t border-border/50" id="projects">
      <div className="container mx-auto px-6">
        <FadeIn className="mb-16 flex items-end justify-between">
          <div>
            <h2 className="text-3xl md:text-4xl font-heading font-bold mb-4">Featured Projects</h2>
            <div className="h-1 w-20 bg-primary/50" />
          </div>
        </FadeIn>

        <StaggerContainer className="space-y-4">
          {projects.map((project, idx) => (
            <StaggerItem key={idx}>
              <div className="group border border-border/50 bg-background p-6 md:p-8 flex flex-col md:flex-row md:items-center justify-between gap-6 hover:border-primary/30 transition-all hover:shadow-[0_0_30px_rgba(124,58,237,0.05)]">
                <div className="flex-1">
                  <h3 className="text-2xl font-heading font-bold mb-2 group-hover:text-primary transition-colors">{project.title}</h3>
                  <p className="text-muted-foreground mb-4 max-w-3xl">{project.description}</p>
                  <div className="flex flex-wrap gap-2">
                    {project.tags.map(tag => (
                      <span key={tag} className="px-3 py-1 text-xs font-mono text-muted-foreground bg-muted rounded border border-border/50">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <button 
                    className="flex items-center gap-2 text-sm font-mono uppercase tracking-widest text-primary hover:text-accent transition-colors"
                    data-testid={`button-read-more-${idx}`}
                  >
                    Read more <ArrowUpRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  );
}