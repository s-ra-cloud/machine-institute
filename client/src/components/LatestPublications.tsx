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
      <StaggerContainer className="flex flex-col divide-y divide-border/50 border-t border-border/50">
        {displayPapers.map((pub: any, idx: number) => (
          <StaggerItem key={pub.id || idx}>
            {hasApiPapers ? (
              <Link href={`/papers/${pub.slug}`}>
                <div className="py-6 flex gap-6 group cursor-pointer" data-testid={`card-publication-${pub.id}`}>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-xl font-heading font-bold text-foreground leading-snug mb-2 group-hover:text-primary transition-colors">
                      {pub.title}
                    </h4>
                    {pub.abstract && (
                      <p className="text-sm text-muted-foreground leading-relaxed mb-3 line-clamp-2">
                        {pub.abstract}
                      </p>
                    )}
                    <p className="text-sm text-foreground/80 mb-1">
                      {pub.authorFirstName} {pub.authorLastName}
                    </p>
                    <p className="text-xs font-mono text-primary">
                      {new Date(pub.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </p>
                  </div>
                  <div className="hidden sm:flex w-28 h-28 shrink-0 bg-muted/30 border border-border/50 items-center justify-center">
                    <span className="text-[10px] font-mono text-muted-foreground/40 text-center px-2">Cover</span>
                  </div>
                </div>
              </Link>
            ) : (
              <div className="py-6 flex gap-6 group" data-testid={`card-publication-${pub.id}`}>
                <div className="flex-1 min-w-0">
                  <h4 className="text-xl font-heading font-bold text-foreground leading-snug mb-2">
                    {pub.title}
                  </h4>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                    {pub.description}
                  </p>
                  <p className="text-sm text-foreground/80 mb-1">
                    {pub.authors}
                  </p>
                  <p className="text-xs font-mono text-primary">
                    {new Date(pub.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </p>
                </div>
                <div className="hidden sm:flex w-28 h-28 shrink-0 bg-muted/30 border border-border/50 items-center justify-center">
                  <span className="text-[10px] font-mono text-muted-foreground/40 text-center px-2">Cover</span>
                </div>
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