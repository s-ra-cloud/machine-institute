import { useQuery } from "@tanstack/react-query";
import { FadeIn, StaggerContainer, StaggerItem } from "./ui/motion";
import { placeholderPublications } from "@/lib/mockData";
import type { Paper } from "@shared/schema";
import { ArrowRight } from "lucide-react";
import { Link } from "wouter";

export function LatestPublications({ limit = 3 }: { limit?: number }) {
  const { data: apiPapers = [] } = useQuery<(Paper & { publicationUrl: string })[]>({
    queryKey: ["/api/papers"],
    queryFn: async () => {
      const res = await fetch("/api/papers");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const hasApiPapers = apiPapers.length > 0;
  const displayPapers = hasApiPapers
    ? apiPapers.slice(0, limit)
    : placeholderPublications.slice(0, limit);

  return (
    <div>
      <StaggerContainer className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {displayPapers.map((pub: any, idx: number) => (
          <StaggerItem key={pub.id || idx}>
            {hasApiPapers ? (
              <Link href={`/papers/${pub.slug}`}>
                <div className="p-6 border border-border/50 bg-muted/10 hover:bg-muted/20 hover:border-primary/20 transition-all cursor-pointer group h-full" data-testid={`card-publication-${pub.id}`}>
                  <h4 className="text-lg font-heading font-bold text-foreground mb-3 leading-snug group-hover:text-primary transition-colors">
                    {pub.title}
                  </h4>
                  {pub.abstract && (
                    <p className="text-sm text-muted-foreground leading-relaxed mb-4 line-clamp-3">
                      {pub.abstract}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground/80 mb-1">
                    {pub.authorFirstName} {pub.authorLastName}
                  </p>
                  <p className="text-xs font-mono text-primary">
                    {new Date(pub.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </p>
                </div>
              </Link>
            ) : (
              <div className="p-6 border border-border/50 bg-muted/10 hover:bg-muted/20 transition-all group h-full" data-testid={`card-publication-${pub.id}`}>
                <h4 className="text-lg font-heading font-bold text-foreground mb-3 leading-snug">
                  {pub.title}
                </h4>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  {pub.description}
                </p>
                <p className="text-sm text-muted-foreground/80 mb-1">
                  {pub.authors}
                </p>
                <p className="text-xs font-mono text-primary">
                  {new Date(pub.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </p>
              </div>
            )}
          </StaggerItem>
        ))}
      </StaggerContainer>

      <FadeIn className="mt-6">
        <Link href="/projects/autonomous-journal-xai" className="inline-flex items-center gap-2 text-sm font-mono text-primary hover:text-accent transition-colors" data-testid="link-view-all-publications">
          All publications <ArrowRight className="w-3 h-3" />
        </Link>
      </FadeIn>
    </div>
  );
}