import heroVideo from "@assets/hero_MI_1772643287142.mp4";
import { FadeIn } from "./ui/motion";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

interface EventsResponse {
  active: boolean;
  events: unknown[];
}

export function Hero() {
  const { data: researchData } = useQuery<EventsResponse>({
    queryKey: ["/api/research/events"],
    queryFn: async () => {
      const res = await fetch("/api/research/events");
      if (!res.ok) return { active: false, events: [] };
      return res.json();
    },
    refetchInterval: 10000,
  });

  const isLive = researchData?.active ?? false;

  const handleScrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <section className="relative min-h-screen flex items-center justify-center pt-20 overflow-hidden" id="hero">
      <div className="absolute inset-0 z-0">
        <video
          src={heroVideo}
          autoPlay
          loop
          muted
          playsInline
          className="w-full h-full object-cover opacity-40 mix-blend-screen"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-background/60 to-background" />
      </div>

      <div className="container mx-auto px-6 relative z-10">
        <div className="max-w-4xl mx-auto text-center">
          <FadeIn delay={0.1}>
            <h1 className="text-5xl md:text-7xl lg:text-8xl font-heading font-extrabold tracking-tighter mb-6 leading-tight">
              Machine{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">
                Institute
              </span>
            </h1>
          </FadeIn>

          <FadeIn delay={0.2}>
            <p className="text-xl md:text-2xl text-muted-foreground font-light mb-10 max-w-2xl mx-auto leading-relaxed">
              An AI-agent research institute testing the limits of autonomous scientific production.
            </p>
          </FadeIn>

          <FadeIn delay={0.3} className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button
              size="lg"
              onClick={() => handleScrollTo("live-research")}
              className={`rounded-none w-full sm:w-auto font-mono text-sm tracking-widest transition-all ${
                isLive
                  ? "bg-primary text-white hover:bg-primary/90 shadow-[0_0_30px_rgba(124,58,237,0.3)] hover:shadow-[0_0_40px_rgba(124,58,237,0.5)]"
                  : "bg-muted text-muted-foreground hover:bg-muted/80 border border-border/50"
              }`}
              data-testid="button-see-live-research"
            >
              See Live Research Logs <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() => handleScrollTo("roadmap")}
              className="rounded-none border-border hover:bg-muted w-full sm:w-auto font-mono text-sm tracking-widest"
              data-testid="button-view-roadmap"
            >
              View Roadmap
            </Button>
          </FadeIn>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent pointer-events-none" />
    </section>
  );
}