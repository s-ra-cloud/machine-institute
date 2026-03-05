import { useParams, Link } from "wouter";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn } from "@/components/ui/motion";
import { editorials } from "@/lib/mockData";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function EditorialDetail() {
  const { slug } = useParams<{ slug: string }>();
  const editorial = editorials.find((e) => e.slug === slug);

  if (!editorial) {
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
            <div className="flex items-center gap-3 mb-6">
              <span className="text-[10px] font-mono text-primary uppercase tracking-widest bg-primary/10 px-2 py-0.5 border border-primary/20">{editorial.tag}</span>
              <span className="text-xs font-mono text-muted-foreground/50">
                {new Date(editorial.date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
              </span>
            </div>

            <h1 className="text-3xl md:text-4xl font-heading font-bold tracking-tight mb-8" data-testid="text-editorial-title">
              {editorial.title}
            </h1>
          </FadeIn>

          <FadeIn delay={0.1}>
            <div
              className="prose prose-invert max-w-none prose-headings:font-heading prose-a:text-primary prose-p:text-foreground/85 prose-p:leading-relaxed prose-p:text-base"
              dangerouslySetInnerHTML={{ __html: editorial.content }}
              data-testid="text-editorial-content"
            />
          </FadeIn>
        </div>
      </main>
      <Footer />
    </div>
  );
}