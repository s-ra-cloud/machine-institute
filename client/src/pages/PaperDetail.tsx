import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { ArrowLeft, ExternalLink, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeIn } from "@/components/ui/motion";
import type { Paper } from "@shared/schema";

export default function PaperDetail() {
  const { slug } = useParams<{ slug: string }>();

  const { data: paper, isLoading, error } = useQuery<Paper & { publicationUrl: string }>({
    queryKey: ["/api/papers", slug],
    queryFn: async () => {
      const res = await fetch(`/api/papers/${slug}`);
      if (!res.ok) throw new Error("Paper not found");
      return res.json();
    }
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <p className="text-muted-foreground font-mono text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (error || !paper) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <p className="text-muted-foreground font-mono text-sm">Paper not found.</p>
          <Link href="/">
            <Button variant="outline" className="rounded-none font-mono text-xs" data-testid="button-back-home">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Home
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const typeLabel = (type: string) => {
    switch (type) {
      case "article": return "Article";
      case "review": return "Review";
      case "revision": return "Revision";
      default: return type;
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="container mx-auto px-6 py-12 max-w-4xl flex-1">
        <FadeIn>
          <Link href="/">
            <Button variant="ghost" className="mb-8 font-mono text-xs text-muted-foreground hover:text-foreground" data-testid="button-back">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>
          </Link>
        </FadeIn>

        <FadeIn delay={0.1}>
          <div className="flex items-center gap-3 mb-6">
            <span className="bg-primary/20 text-primary px-3 py-1 text-xs font-mono border border-primary/30">{typeLabel(paper.type)}</span>
            <span className="text-muted-foreground text-sm font-mono">{new Date(paper.publishedAt).toLocaleDateString()}</span>
          </div>

          <h1 className="text-4xl md:text-5xl font-heading font-bold tracking-tight mb-4" data-testid="text-paper-title">
            {paper.title}
          </h1>

          {paper.subtitle && (
            <p className="text-xl text-muted-foreground font-light mb-6" data-testid="text-paper-subtitle">{paper.subtitle}</p>
          )}

          <div className="flex items-center gap-4 mb-8 pb-8 border-b border-border/50">
            <div className="w-12 h-12 rounded-full bg-muted border border-border/50 flex items-center justify-center text-primary font-mono text-sm">
              {paper.authorFirstName[0]}{paper.authorLastName[0]}
            </div>
            <div>
              <p className="font-medium" data-testid="text-paper-author">{paper.authorFirstName} {paper.authorLastName}</p>
              <p className="text-sm text-muted-foreground">{paper.authorInstitution}</p>
              <p className="text-xs text-primary font-mono mt-0.5">{paper.authorEmail}</p>
            </div>
          </div>
        </FadeIn>

        <FadeIn delay={0.2}>
          <div className="mb-8">
            <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest mb-3">Abstract</h2>
            <p className="text-foreground/90 leading-relaxed text-lg" data-testid="text-paper-abstract">{paper.abstract}</p>
          </div>

          <div className="mb-8">
            <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest mb-3">Keywords</h2>
            <div className="flex flex-wrap gap-2">
              {paper.keywords.map((kw: string) => (
                <span key={kw} className="px-3 py-1 text-xs font-mono text-primary bg-primary/10 border border-primary/20">{kw}</span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8 text-sm">
            {paper.language && (
              <div>
                <span className="text-muted-foreground font-mono text-xs uppercase tracking-wider">Language</span>
                <p className="mt-1">{paper.language}</p>
              </div>
            )}
            {paper.copyright && (
              <div>
                <span className="text-muted-foreground font-mono text-xs uppercase tracking-wider">Copyright</span>
                <p className="mt-1">{paper.copyright}</p>
              </div>
            )}
            {paper.license && (
              <div>
                <span className="text-muted-foreground font-mono text-xs uppercase tracking-wider">License</span>
                <p className="mt-1">{paper.license}</p>
              </div>
            )}
          </div>

          {paper.linkedPaperId && (
            <div className="mb-8 p-4 bg-muted/20 border border-border/50">
              <span className="text-muted-foreground font-mono text-xs uppercase tracking-wider block mb-2">
                {paper.type === "review" ? "Review of" : "Revision of"}
              </span>
              <a href={`/api/papers/${paper.linkedPaperId}`} className="text-primary hover:text-accent transition-colors flex items-center gap-2 font-mono text-sm">
                View original paper <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          {paper.fileUrl && (
            <div className="mb-8">
              <a
                href={paper.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary border border-primary/20 hover:bg-primary hover:text-white transition-all font-mono text-sm"
                data-testid="link-download-file"
              >
                <Download className="h-4 w-4" /> Download Full Text
              </a>
            </div>
          )}

          {paper.contentHtml && (
            <div className="mt-12 pt-8 border-t border-border/50">
              <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest mb-6">Full Text</h2>
              <div
                className="prose prose-invert max-w-none prose-headings:font-heading prose-a:text-primary"
                dangerouslySetInnerHTML={{ __html: paper.contentHtml }}
                data-testid="text-paper-content"
              />
            </div>
          )}
        </FadeIn>
      </div>
    </div>
  );
}