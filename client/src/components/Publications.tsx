import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FadeIn, StaggerContainer, StaggerItem } from "./ui/motion";
import type { Paper } from "@shared/schema";

export function Publications() {
  const [filter, setFilter] = useState("All");

  const { data: papers = [], isLoading } = useQuery<(Paper & { publicationUrl: string })[]>({
    queryKey: ["/api/papers"],
    queryFn: async () => {
      const res = await fetch("/api/papers");
      if (!res.ok) throw new Error("Failed to fetch papers");
      return res.json();
    }
  });

  const filteredPubs = filter === "All"
    ? papers
    : papers.filter(p => p.type === filter.toLowerCase());

  const typeLabel = (type: string) => {
    switch (type) {
      case "article": return "Article";
      case "review": return "Review";
      case "revision": return "Revision";
      default: return type;
    }
  };

  return (
    <section className="py-24 bg-background border-t border-border/50" id="publications">
      <div className="container mx-auto px-6 max-w-5xl">
        <FadeIn className="mb-12 flex flex-col sm:flex-row sm:items-end justify-between gap-6">
          <div>
            <h2 className="text-3xl md:text-4xl font-heading font-bold mb-4">Selected Publications</h2>
            <div className="h-1 w-20 bg-primary/50" />
          </div>

          <div className="flex gap-2">
            {["All", "Article", "Review", "Revision"].map(f => (
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

        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground font-mono text-sm">Loading publications...</div>
        ) : filteredPubs.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground font-mono text-sm">
            No publications yet. Papers submitted via the API will appear here.
          </div>
        ) : (
          <StaggerContainer className="flex flex-col border-t border-border/50" key={filter}>
            {filteredPubs.map((pub) => (
              <StaggerItem key={pub.id}>
                <a
                  href={`/papers/${pub.slug}`}
                  className="block py-6 border-b border-border/50 flex flex-col md:flex-row gap-4 justify-between group hover:bg-muted/10 transition-colors px-4 -mx-4"
                  data-testid={`link-paper-${pub.id}`}
                >
                  <div className="max-w-3xl">
                    <h3 className="text-lg font-medium text-foreground mb-2 group-hover:text-primary transition-colors">
                      {pub.title}
                    </h3>
                    {pub.subtitle && (
                      <p className="text-sm text-muted-foreground/80 mb-1">{pub.subtitle}</p>
                    )}
                    <p className="text-sm text-muted-foreground font-light">
                      {pub.authorFirstName} {pub.authorLastName} — {pub.authorInstitution}
                    </p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {pub.keywords.map((kw: string) => (
                        <span key={kw} className="px-2 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border/50">{kw}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-4 items-start md:items-center text-sm font-mono text-muted-foreground shrink-0">
                    <span className="w-20">{new Date(pub.publishedAt).getFullYear()}</span>
                    <span className="bg-muted px-2 py-1 rounded-sm text-xs">{typeLabel(pub.type)}</span>
                  </div>
                </a>
              </StaggerItem>
            ))}
          </StaggerContainer>
        )}
      </div>
    </section>
  );
}