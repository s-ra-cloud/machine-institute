import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { ArrowLeft, BookOpen, Loader2, Calendar, Bot, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeIn } from "@/components/ui/motion";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import type { LiteratureReview } from "@shared/schema";

export default function LiteratureReviewDetail() {
  const { id } = useParams<{ id: string }>();

  const { data: review, isLoading } = useQuery<LiteratureReview>({
    queryKey: ["/api/literature-reviews", id],
    queryFn: async () => {
      const res = await fetch(`/api/literature-reviews/${id}`);
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && (data.status === "pending" || data.status === "generating")) return 5000;
      return false;
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground font-mono text-sm">Loading...</p>
      </div>
    );
  }

  if (!review) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Navigation />
        <div className="flex flex-col items-center justify-center gap-6 pt-28">
          <p className="text-muted-foreground font-mono text-sm">Literature review not found.</p>
          <Link href="/">
            <Button variant="outline" className="rounded-none font-mono text-xs" data-testid="button-back-home">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Home
            </Button>
          </Link>
        </div>
        <Footer />
      </div>
    );
  }

  const createdDate = new Date(review.createdAt);
  const completedDate = review.completedAt ? new Date(review.completedAt) : null;
  const durationSec = completedDate ? Math.round((completedDate.getTime() - createdDate.getTime()) / 1000) : null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6 max-w-4xl">
          <FadeIn>
            <Link href={`/projects/${review.projectId}`}>
              <Button variant="ghost" className="mb-8 font-mono text-xs text-muted-foreground hover:text-foreground" data-testid="button-back">
                <ArrowLeft className="mr-2 h-4 w-4" /> Back to Project
              </Button>
            </Link>
          </FadeIn>

          <FadeIn delay={0.1}>
            <div className="border border-border/30 bg-muted/5 p-8 md:p-12 mb-10">
              <div className="flex items-center gap-3 mb-5">
                <span className="bg-primary/20 text-primary px-3 py-1 text-xs font-mono border border-primary/30 flex items-center gap-1">
                  <BookOpen className="w-3 h-3" /> Literature Review
                </span>
                {review.status === "completed" && (
                  <span className="bg-green-500/10 text-green-400 px-2 py-0.5 text-xs font-mono rounded-sm">completed</span>
                )}
                {review.status === "generating" && (
                  <span className="bg-yellow-500/10 text-yellow-400 px-2 py-0.5 text-xs font-mono rounded-sm flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> generating
                  </span>
                )}
                {review.status === "failed" && (
                  <span className="bg-red-500/10 text-red-400 px-2 py-0.5 text-xs font-mono rounded-sm">failed</span>
                )}
              </div>

              <h1 className="text-2xl md:text-3xl font-heading font-bold tracking-tight mb-6" data-testid="text-review-question">
                {review.researchQuestion}
              </h1>

              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground font-mono">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-primary/60" />
                  <span data-testid="text-review-agent">{review.agentId}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-primary/60" />
                  <span>{createdDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span>
                </div>
                {durationSec !== null && (
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-primary/60" />
                    <span>{durationSec}s generation time</span>
                  </div>
                )}
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={0.2}>
            {review.status === "pending" || review.status === "generating" ? (
              <div className="border border-border/30 bg-muted/5 p-12 text-center">
                <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
                <p className="text-muted-foreground font-mono text-sm mb-2">
                  {review.status === "pending" ? "Review request queued..." : "Agent is generating the literature review..."}
                </p>
                <p className="text-muted-foreground/50 text-xs">This may take a minute. The page will update automatically.</p>
              </div>
            ) : review.status === "failed" ? (
              <div className="border border-red-500/20 bg-red-500/5 p-8">
                <p className="text-red-400 font-mono text-sm">Generation failed. Please try again.</p>
                {review.contentHtml && (
                  <div className="mt-4 text-sm text-red-300/70" dangerouslySetInnerHTML={{ __html: review.contentHtml }} />
                )}
              </div>
            ) : review.contentHtml ? (
              <div
                className="review-content"
                dangerouslySetInnerHTML={{ __html: review.contentHtml }}
                data-testid="text-review-content"
              />
            ) : (
              <p className="text-muted-foreground font-mono text-sm">No content available.</p>
            )}
          </FadeIn>

          {review.status === "completed" && (
            <FadeIn delay={0.3}>
              <div className="mt-12 pt-8 border-t border-border/30 text-center">
                <p className="text-xs font-mono text-muted-foreground/50">
                  Generated by {review.agentId} — Machine Institute Automated Literature Review
                </p>
              </div>
            </FadeIn>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
