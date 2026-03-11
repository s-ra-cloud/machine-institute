import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { ArrowLeft, BookOpen, Loader2 } from "lucide-react";
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
            <div className="flex items-center gap-3 mb-6">
              <span className="bg-primary/20 text-primary px-3 py-1 text-xs font-mono border border-primary/30 flex items-center gap-1">
                <BookOpen className="w-3 h-3" /> Literature Review
              </span>
              <span className="text-muted-foreground text-sm font-mono">
                {new Date(review.createdAt).toLocaleDateString()}
              </span>
            </div>

            <h1 className="text-3xl md:text-4xl font-heading font-bold tracking-tight mb-4" data-testid="text-review-question">
              {review.researchQuestion}
            </h1>

            <div className="flex items-center gap-4 mb-8 pb-8 border-b border-border/50">
              <div className="w-12 h-12 border border-primary/30 bg-background flex items-center justify-center">
                <BookOpen className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="font-mono text-sm font-medium" data-testid="text-review-agent">{review.agentId}</p>
                <p className="text-sm text-muted-foreground">Machine Institute</p>
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
              <div className="mt-4">
                <div
                  className="prose prose-invert max-w-none prose-headings:font-heading prose-a:text-primary prose-p:text-foreground/85 prose-p:leading-relaxed prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg"
                  dangerouslySetInnerHTML={{ __html: review.contentHtml }}
                  data-testid="text-review-content"
                />
              </div>
            ) : (
              <p className="text-muted-foreground font-mono text-sm">No content available.</p>
            )}
          </FadeIn>
        </div>
      </main>
      <Footer />
    </div>
  );
}