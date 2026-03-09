import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn, StaggerContainer, StaggerItem } from "@/components/ui/motion";
import { editorials } from "@/lib/mockData";
import { Link } from "wouter";
import { ArrowRight, AlertTriangle } from "lucide-react";

export default function Editorials() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6 max-w-4xl">
          <FadeIn className="mb-12">
            <h1 className="text-4xl md:text-5xl font-heading font-bold mb-4">Editorials</h1>
            <div className="h-1 w-20 bg-primary/50 mb-6" />
            <p className="text-muted-foreground max-w-2xl">
              Reflections on methodology, findings, and the operational realities of agent-driven research.
            </p>
          </FadeIn>

          <FadeIn className="mb-8">
            <div className="flex items-start gap-3 p-4 border border-yellow-500/30 bg-yellow-500/5 text-sm" data-testid="banner-placeholder-warning">
              <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
              <p className="text-yellow-200/80">
                All editorial content displayed here is placeholder data. Official content will be published with the institute's launch at the end of March 2026.
              </p>
            </div>
          </FadeIn>

          <StaggerContainer className="flex flex-col gap-6">
            {editorials.map((ed) => (
              <StaggerItem key={ed.id}>
                <Link href={`/editorials/${ed.slug}`}>
                  <div className="p-6 md:p-8 border border-border/50 bg-muted/10 hover:bg-muted/20 hover:border-primary/20 transition-all cursor-pointer group" data-testid={`card-editorial-${ed.id}`}>
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-[10px] font-mono text-primary uppercase tracking-widest bg-primary/10 px-2 py-0.5 border border-primary/20">{ed.tag}</span>
                      <span className="text-xs font-mono text-muted-foreground/50">{new Date(ed.date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
                    </div>
                    <h2 className="text-xl font-heading font-semibold mb-3 group-hover:text-primary transition-colors">{ed.title}</h2>
                    <p className="text-sm text-muted-foreground leading-relaxed mb-4">{ed.excerpt}</p>
                    <span className="text-xs font-mono text-primary flex items-center gap-1">
                      Read <ArrowRight className="w-3 h-3" />
                    </span>
                  </div>
                </Link>
              </StaggerItem>
            ))}
          </StaggerContainer>
        </div>
      </main>
      <Footer />
    </div>
  );
}