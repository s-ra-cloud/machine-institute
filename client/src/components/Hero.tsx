import { ParticleBackground } from "./ParticleBackground";
import { FadeIn } from "./ui/motion";
import { Button } from "@/components/ui/button";
import { ArrowRight, FileText } from "lucide-react";

export function Hero() {
  const scrollTo = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <section className="relative min-h-screen flex items-center justify-center pt-20 overflow-hidden" id="hero">
      <ParticleBackground />
      
      <div className="container mx-auto px-6 relative z-10">
        <div className="max-w-4xl mx-auto text-center">
          <FadeIn>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary font-mono text-xs uppercase tracking-widest mb-8">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
              </span>
              Active Research Lab
            </div>
          </FadeIn>
          
          <FadeIn delay={0.1}>
            <h1 className="text-5xl md:text-7xl lg:text-8xl font-heading font-extrabold tracking-tighter mb-6 leading-tight">
              Machine <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">Institute</span>
            </h1>
          </FadeIn>
          
          <FadeIn delay={0.2}>
            <p className="text-xl md:text-2xl text-muted-foreground font-light mb-6">
              A Research Center for AI Agents
            </p>
            <p className="text-lg text-muted-foreground/80 max-w-2xl mx-auto mb-10 leading-relaxed">
              We design, evaluate, and deploy agentic systems with rigorous methods, reproducible benchmarks, and real-world constraints.
            </p>
          </FadeIn>
          
          <FadeIn delay={0.3} className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Button 
              size="lg" 
              className="bg-primary text-white hover:bg-primary/90 rounded-none w-full sm:w-auto font-mono text-sm tracking-widest shadow-[0_0_30px_rgba(124,58,237,0.3)] hover:shadow-[0_0_40px_rgba(124,58,237,0.5)] transition-all"
              onClick={() => scrollTo('research')}
              data-testid="button-explore-research"
            >
              Explore Research <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button 
              variant="outline" 
              size="lg"
              className="rounded-none border-border hover:bg-muted w-full sm:w-auto font-mono text-sm tracking-widest"
              onClick={() => scrollTo('projects')}
              data-testid="button-view-projects"
            >
              <FileText className="mr-2 h-4 w-4" /> View Projects
            </Button>
          </FadeIn>
          
          <FadeIn delay={0.5}>
            <div className="flex flex-wrap justify-center gap-6 md:gap-12 text-sm font-mono tracking-widest text-muted-foreground/60 uppercase">
              <div className="flex items-center gap-2">
                <div className="w-1 h-1 bg-highlight rounded-full" />
                Reproducible
              </div>
              <div className="flex items-center gap-2">
                <div className="w-1 h-1 bg-highlight rounded-full" />
                Open Methods
              </div>
              <div className="flex items-center gap-2">
                <div className="w-1 h-1 bg-highlight rounded-full" />
                Safety-Aware
              </div>
            </div>
          </FadeIn>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent pointer-events-none" />
    </section>
  );
}