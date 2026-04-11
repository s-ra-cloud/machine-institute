import { useParams, Link } from "wouter";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn } from "@/components/ui/motion";
import { ArrowLeft, Loader2, ExternalLink, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

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
  orchestratorName: string | null;
  modelProvider: string | null;
  modelName: string | null;
  providerMode: string | null;
  topic: string | null;
  publishedDocumentId: string | null;
  promptTrace: string | null;
  sourceTrace: string | null;
}

export default function EditorialDetail() {
  const { slug } = useParams<{ slug: string }>();
  const [showMeta, setShowMeta] = useState(false);

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

          {editorial.status === "completed" && (editorial.modelProvider || editorial.orchestratorName || editorial.publishedDocumentId) && (
            <FadeIn delay={0.2}>
              <div className="mt-12 border-t border-border/30 pt-6">
                <button
                  onClick={() => setShowMeta(!showMeta)}
                  className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                  data-testid="button-toggle-metadata"
                >
                  <Info className="w-3 h-3" />
                  {showMeta ? "Hide" : "Show"} generation metadata
                </button>

                {showMeta && (
                  <div className="mt-4 border border-border/20 bg-muted/5 p-5 space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-[10px] font-mono">
                      {editorial.topic && (
                        <div className="col-span-2 md:col-span-4">
                          <span className="text-muted-foreground/40 block">Topic</span>
                          <span className="text-foreground/70">{editorial.topic}</span>
                        </div>
                      )}
                      {editorial.modelName && (
                        <div>
                          <span className="text-muted-foreground/40 block">Model</span>
                          <span className="text-foreground/70">{editorial.modelName}</span>
                        </div>
                      )}
                      {editorial.modelProvider && (
                        <div>
                          <span className="text-muted-foreground/40 block">Provider</span>
                          <span className="text-foreground/70">{editorial.modelProvider}</span>
                        </div>
                      )}
                      {editorial.providerMode && (
                        <div>
                          <span className="text-muted-foreground/40 block">Mode</span>
                          <span className="text-foreground/70">{editorial.providerMode}</span>
                        </div>
                      )}
                      {editorial.orchestratorName && (
                        <div>
                          <span className="text-muted-foreground/40 block">Orchestrator</span>
                          <span className="text-foreground/70">{editorial.orchestratorName}</span>
                        </div>
                      )}
                    </div>

                    {editorial.publishedDocumentId && (
                      <div>
                        <a
                          href={`https://future-science.org/papers/${editorial.publishedDocumentId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-mono text-primary hover:underline flex items-center gap-1"
                          data-testid="link-publication"
                        >
                          View on Future Science <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}

                    {editorial.promptTrace && (
                      <details className="text-[10px] font-mono text-foreground/50">
                        <summary className="cursor-pointer hover:text-foreground/70">Prompt trace</summary>
                        <pre className="mt-2 p-3 bg-background border border-border/20 overflow-x-auto max-h-48 text-[9px] whitespace-pre-wrap">
                          {JSON.stringify(JSON.parse(editorial.promptTrace), null, 2)}
                        </pre>
                      </details>
                    )}

                    {editorial.sourceTrace && (
                      <details className="text-[10px] font-mono text-foreground/50">
                        <summary className="cursor-pointer hover:text-foreground/70">Source trace</summary>
                        <pre className="mt-2 p-3 bg-background border border-border/20 overflow-x-auto max-h-48 text-[9px] whitespace-pre-wrap">
                          {JSON.stringify(JSON.parse(editorial.sourceTrace), null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </FadeIn>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}