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
      <StaggerContainer className="flex flex-col border-t border-border/50">
        {displayPapers.map((pub: any, idx: number) => (
          <StaggerItem key={pub.id || idx}>
            <div className="py-5 border-b border-border/50 flex flex-col md:flex-row gap-3 justify-between group hover:bg-muted/10 transition-colors px-4 -mx-4">
              <div className="max-w-3xl">
                {hasApiPapers ? (
                  <Link href={`/papers/${pub.slug}`}>
                    <h4 className="text-base font-medium text-foreground group-hover:text-primary transition-colors cursor-pointer">
                      {pub.title}
                    </h4>
                  </Link>
                ) : (
                  <h4 className="text-base font-medium text-foreground group-hover:text-primary transition-colors">
                    {pub.title}
                  </h4>
                )}
                <p className="text-sm text-muted-foreground font-light mt-1">
                  {hasApiPapers
                    ? `${pub.authorFirstName} ${pub.authorLastName}`
                    : pub.authors}
                </p>
              </div>
              <div className="flex gap-3 items-center text-xs font-mono text-muted-foreground shrink-0">
                <span>{new Date(hasApiPapers ? pub.publishedAt : pub.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                <span className="bg-muted px-2 py-0.5 rounded-sm">{pub.type}</span>
              </div>
            </div>
          </StaggerItem>
        ))}
      </StaggerContainer>

      <FadeIn className="mt-4">
        <Link href="/projects/autonomous-journal-xai" className="inline-flex items-center gap-2 text-sm font-mono text-primary hover:text-accent transition-colors" data-testid="link-view-all-publications">
          All publications <ArrowRight className="w-3 h-3" />
        </Link>
      </FadeIn>
    </div>
  );
}