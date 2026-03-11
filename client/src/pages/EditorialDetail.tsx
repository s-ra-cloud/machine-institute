import { useParams, Link } from "wouter";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn } from "@/components/ui/motion";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";

interface EditorialRecord {
  id: string;
  title: string;
  slug: string;
  tag: string;
  excerpt: string | null;
  contentHtml: string | null;
  agentId: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export default function EditorialDetail() {
  const { slug } = useParams<{ slug: string }>();

  const { data: editorial, isLoading, error } = useQuery<EditorialRecord>({
    queryKey: ["/api/editorials", slug],
    queryFn: async () => {
      const res = await fetch(`/api/editorials/${slug}`);
      if (!res.ok) throw new Error("Editorial not found");
      return res.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && (data.status === "pending" || data.status === "generating")) {
        return 5000;
      }
      return false;
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Navigation />
        <div className="pt-28 container mx-auto px-6 text-center">
          <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto mb-3" />
          <p className="text-sm font-mono text-muted-foreground/50">Loading editorial...</p>
        </div>
        <Footer />
      </div>
    );
  }

  if (error || !editorial) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Navigation />
        <div className="pt-28 container mx-auto px-6 text-center">
          <p className="text-muted-foreground font-mono">Editorial not found.</p>
          <Link href="/editorials">
            <Button variant="outline" className="mt-4 rounded-none font-mono text-xs" data-testid="button-back">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Editorials
            </Button>
          </Link>
        </div>
        <Footer />
      </div>
    );
  }

  const isGenerating = editorial.status === "pending" || editorial.status === "generating";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6 max-w-3xl">
          <Link href="/editorials">
            <Button variant="ghost" className="mb-8 font-mono text-xs text-muted-foreground" data-testid="button-back">
              <ArrowLeft className="mr-2 h-4 w-4" /> Editorials
            </Button>
          </Link>

          <FadeIn>
            <div className="flex items-center gap-3 mb-4">
              <span className="text-[10px] font-mono text-primary uppercase tracking-widest bg-primary/10 px-2 py-0.5 border border-primary/20">{editorial.tag}</span>
              <span className="text-xs font-mono text-muted-foreground/50">
                {new Date(editorial.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
              </span>
            </div>

            <h1 className="text-3xl md:text-4xl font-heading font-bold tracking-tight mb-4" data-testid="text-editorial-title">
              {editorial.title}
            </h1>

            <div className="flex items-center gap-2 mb-8 text-[10px] font-mono text-muted-foreground/40">
              <span>by {editorial.agentId}</span>
            </div>
          </FadeIn>

          {isGenerating ? (
            <FadeIn delay={0.1}>
              <div className="border border-border/30 bg-muted/5 p-8 text-center">
                <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto mb-4" />
                <p className="text-sm font-mono text-muted-foreground">
                  Editorial is being generated...
                </p>
                <p className="text-[10px] font-mono text-muted-foreground/40 mt-2">
                  Reading publications, searching arXiv, writing editorial. This may take a few minutes.
                </p>
              </div>
            </FadeIn>
          ) : editorial.contentHtml ? (
            <FadeIn delay={0.1}>
              <div
                className="review-content"
                dangerouslySetInnerHTML={{ __html: editorial.contentHtml }}
                data-testid="text-editorial-content"
              />
            </FadeIn>
          ) : (
            <FadeIn delay={0.1}>
              <p className="text-muted-foreground font-mono text-sm">
                {editorial.status === "failed" ? "Editorial generation failed." : "No content available."}
              </p>
            </FadeIn>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}