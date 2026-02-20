import { FadeIn } from "./ui/motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function Collaborate() {
  return (
    <section className="py-24 bg-background border-t border-border/50 relative overflow-hidden" id="collaborate">
      <div className="absolute right-0 top-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      
      <div className="container mx-auto px-6 relative z-10 max-w-6xl">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16">
          <FadeIn>
            <h2 className="text-3xl md:text-4xl font-heading font-bold mb-4">Collaborate</h2>
            <div className="h-1 w-20 bg-primary/50 mb-8" />
            
            <p className="text-muted-foreground text-lg mb-8 leading-relaxed">
              We partner with academic institutions, industry labs, and independent researchers to advance the frontier of agentic systems.
            </p>
            
            <div className="space-y-6">
              {[
                { title: "Visiting Fellowship", desc: "For postdocs and faculty looking to embed within our research groups." },
                { title: "Industry Research Partnership", desc: "Co-development of benchmarks and evaluation suites for proprietary models." },
                { title: "Benchmark Contributions", desc: "Open-source collaborations on our evaluation harnesses." }
              ].map((item, idx) => (
                <div key={idx} className="flex gap-4">
                  <div className="mt-1 h-2 w-2 rounded-full bg-highlight shrink-0" />
                  <div>
                    <h4 className="font-heading font-semibold text-foreground mb-1">{item.title}</h4>
                    <p className="text-sm text-muted-foreground">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </FadeIn>
          
          <FadeIn delay={0.2}>
            <div className="bg-muted/10 border border-border/50 p-8 backdrop-blur-sm relative">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-accent" />
              
              <h3 className="text-xl font-heading font-semibold mb-6">Get in Touch</h3>
              
              <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Name</label>
                    <Input className="bg-background/50 border-border/50 focus-visible:ring-primary/50 rounded-none" placeholder="Jane Doe" data-testid="input-name" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Email</label>
                    <Input type="email" className="bg-background/50 border-border/50 focus-visible:ring-primary/50 rounded-none" placeholder="jane@example.com" data-testid="input-email" />
                  </div>
                </div>
                
                <div className="space-y-2">
                  <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Message</label>
                  <Textarea className="bg-background/50 border-border/50 focus-visible:ring-primary/50 rounded-none min-h-[120px]" placeholder="How would you like to collaborate?" data-testid="input-message" />
                </div>
                
                <div className="flex items-start gap-2 pt-2">
                  <input type="checkbox" id="consent" className="mt-1 shrink-0 accent-primary" data-testid="checkbox-consent" />
                  <label htmlFor="consent" className="text-xs text-muted-foreground">
                    I consent to having my information processed for contact purposes.
                  </label>
                </div>
                
                <Button className="w-full bg-primary text-white hover:bg-primary/90 rounded-none font-mono tracking-widest mt-4" data-testid="button-send">
                  Send Message
                </Button>
                
                <p className="text-center text-[10px] font-mono text-muted-foreground/50 mt-4">
                  * This demo form does not send emails.
                </p>
              </form>
            </div>
          </FadeIn>
        </div>
      </div>
    </section>
  );
}