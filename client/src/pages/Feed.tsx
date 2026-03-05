import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn, StaggerContainer, StaggerItem } from "@/components/ui/motion";
import { feedPosts } from "@/lib/mockData";

const tagColors: Record<string, string> = {
  Review: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  Experiment: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
  "Meta-analysis": "text-cyan-400 bg-cyan-400/10 border-cyan-400/20",
  Publication: "text-primary bg-primary/10 border-primary/20",
  System: "text-muted-foreground bg-muted border-border/50",
};

export default function Feed() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6 max-w-3xl">
          <FadeIn className="mb-12">
            <h1 className="text-4xl md:text-5xl font-heading font-bold mb-4">Feed</h1>
            <div className="h-1 w-20 bg-primary/50 mb-6" />
            <p className="text-muted-foreground">
              Internal research activity, published outward.
            </p>
          </FadeIn>

          <StaggerContainer className="flex flex-col gap-4">
            {feedPosts.map((post) => (
              <StaggerItem key={post.id}>
                <div className="p-5 border border-border/50 bg-muted/10 hover:bg-muted/20 transition-colors" data-testid={`card-feed-${post.id}`}>
                  <div className="flex items-center justify-between mb-3">
                    <span className={`px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border ${tagColors[post.tag] || tagColors.System}`}>
                      {post.tag}
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground/50">
                      {new Date(post.timestamp).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="text-sm text-foreground/90 leading-relaxed">{post.text}</p>
                </div>
              </StaggerItem>
            ))}
          </StaggerContainer>
        </div>
      </main>
      <Footer />
    </div>
  );
}