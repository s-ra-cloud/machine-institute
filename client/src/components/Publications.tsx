import { useState } from "react";
import { FadeIn, StaggerContainer, StaggerItem } from "./ui/motion";

export function Publications() {
  const [filter, setFilter] = useState("All");
  
  const publications = [
    {
      title: "Evaluating Tool-Use Competence in Goal-Driven Agents",
      authors: "E. Chen, M. Smith, J. Doe",
      year: "2024",
      venue: "ICLR",
      type: "Conference"
    },
    {
      title: "Taxonomy of Failure Modes in Autonomous Web Navigation",
      authors: "A. Patel, S. Johnson",
      year: "2024",
      venue: "Preprint",
      type: "Preprints"
    },
    {
      title: "Multi-Agent Coordination Under Partial Observability",
      authors: "J. Doe, L. Wang",
      year: "2023",
      venue: "NeurIPS Workshop",
      type: "Workshop"
    },
    {
      title: "Safety Bounds for API-Enabled Language Models",
      authors: "M. Smith, E. Chen",
      year: "2023",
      venue: "Preprint",
      type: "Preprints"
    }
  ];

  const filteredPubs = filter === "All" ? publications : publications.filter(p => p.type === filter);

  return (
    <section className="py-24 bg-background border-t border-border/50" id="publications">
      <div className="container mx-auto px-6 max-w-5xl">
        <FadeIn className="mb-12 flex flex-col sm:flex-row sm:items-end justify-between gap-6">
          <div>
            <h2 className="text-3xl md:text-4xl font-heading font-bold mb-4">Selected Publications</h2>
            <div className="h-1 w-20 bg-primary/50" />
          </div>
          
          <div className="flex gap-2">
            {["All", "Preprints", "Conference", "Workshop"].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-1.5 text-xs font-mono tracking-wider border transition-colors ${
                  filter === f 
                    ? "bg-primary/20 border-primary text-primary" 
                    : "bg-transparent border-border text-muted-foreground hover:border-primary/50"
                }`}
                data-testid={`button-filter-${f.toLowerCase()}`}
              >
                {f}
              </button>
            ))}
          </div>
        </FadeIn>

        <StaggerContainer className="flex flex-col border-t border-border/50" key={filter}>
          {filteredPubs.map((pub, idx) => (
            <StaggerItem key={idx}>
              <div className="py-6 border-b border-border/50 flex flex-col md:flex-row gap-4 justify-between group hover:bg-muted/10 transition-colors px-4 -mx-4">
                <div className="max-w-3xl">
                  <h3 className="text-lg font-medium text-foreground mb-2 group-hover:text-primary transition-colors">{pub.title}</h3>
                  <p className="text-sm text-muted-foreground font-light">{pub.authors}</p>
                </div>
                <div className="flex gap-4 items-start md:items-center text-sm font-mono text-muted-foreground shrink-0">
                  <span className="w-12">{pub.year}</span>
                  <span className="bg-muted px-2 py-1 rounded-sm text-xs">{pub.venue}</span>
                </div>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  );
}