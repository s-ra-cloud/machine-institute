import { FadeIn, StaggerContainer, StaggerItem } from "./ui/motion";
import { placeholderPublications } from "@/lib/mockData";
import { ArrowRight } from "lucide-react";
import { Link } from "wouter";

export function LatestPublications() {
  return (
    <div>
      <StaggerContainer className="flex flex-col divide-y divide-border/50 border-t border-border/50">
        {placeholderPublications.map((pub) => (
          <StaggerItem key={pub.id}>
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