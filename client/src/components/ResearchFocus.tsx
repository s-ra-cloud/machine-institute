import { FadeIn, StaggerContainer, StaggerItem } from "./ui/motion";
import { BrainCircuit, Scale, ShieldAlert } from "lucide-react";

export function ResearchFocus() {
  const focuses = [
    {
      icon: <BrainCircuit className="w-8 h-8 text-primary" />,
      title: "Agent Architectures",
      description: "Planning, tool-use, memory, and multi-agent coordination."
    },
    {
      icon: <Scale className="w-8 h-8 text-primary" />,
      title: "Evaluation & Benchmarks",
      description: "Robust metrics, failure taxonomies, and reproducible pipelines."
    },
    {
      icon: <ShieldAlert className="w-8 h-8 text-primary" />,
      title: "Deployment & Governance",
      description: "Monitoring, alignment practices, and operational safety."
    }
  ];

  return (
    <section className="py-24 bg-background border-t border-border/50 relative" id="research">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/5 via-background to-background pointer-events-none" />
      
      <div className="container mx-auto px-6 relative z-10">
        <FadeIn className="mb-16">
          <h2 className="text-3xl md:text-4xl font-heading font-bold mb-4">Research Focus</h2>
          <div className="h-1 w-20 bg-primary/50" />
        </FadeIn>

        <StaggerContainer className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {focuses.map((focus, idx) => (
            <StaggerItem key={idx}>
              <div className="h-full p-8 border border-border/50 bg-muted/20 hover:bg-muted/40 transition-colors duration-300 group">
                <div className="mb-6 p-4 bg-background border border-border/50 inline-block group-hover:border-primary/50 transition-colors">
                  {focus.icon}
                </div>
                <h3 className="text-xl font-heading font-semibold mb-3">{focus.title}</h3>
                <p className="text-muted-foreground leading-relaxed">
                  {focus.description}
                </p>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  );
}