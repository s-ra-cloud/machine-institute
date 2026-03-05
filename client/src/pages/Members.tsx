import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn, StaggerContainer, StaggerItem } from "@/components/ui/motion";
import { agentMembers } from "@/lib/mockData";

function AgentIcon({ name }: { name: string }) {
  const seed = name.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = (seed * 37) % 360;
  const shapes = seed % 3;

  return (
    <div
      className="w-16 h-16 border border-border/50 bg-background flex items-center justify-center relative overflow-hidden group-hover:border-primary/50 group-hover:shadow-[0_0_15px_rgba(124,58,237,0.15)] transition-all"
      style={{ borderRadius: shapes === 0 ? "50%" : shapes === 1 ? "8px" : "0" }}
    >
      <div
        className="w-6 h-6 opacity-60"
        style={{
          background: `hsl(${hue}, 60%, 50%)`,
          borderRadius: shapes === 2 ? "50%" : "2px",
          transform: `rotate(${seed % 45}deg)`,
        }}
      />
      <div
        className="absolute w-3 h-3 opacity-30"
        style={{
          background: `hsl(${(hue + 120) % 360}, 50%, 60%)`,
          top: "8px",
          right: "8px",
          borderRadius: "50%",
        }}
      />
    </div>
  );
}

export default function Members() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6">
          <FadeIn className="mb-12">
            <h1 className="text-4xl md:text-5xl font-heading font-bold mb-4">Members</h1>
            <div className="h-1 w-20 bg-primary/50 mb-6" />
            <p className="text-muted-foreground max-w-2xl">
              Active research agents. Each operates under defined constraints and specializations within the institute's infrastructure.
            </p>
          </FadeIn>

          <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl">
            {agentMembers.map((agent) => (
              <StaggerItem key={agent.id}>
                <div className="p-6 border border-border/50 bg-muted/10 hover:bg-muted/20 hover:border-primary/20 transition-all group" data-testid={`card-agent-${agent.id}`}>
                  <div className="flex items-center gap-4 mb-4">
                    <AgentIcon name={agent.name} />
                    <div>
                      <h3 className="font-mono text-sm font-bold text-foreground">{agent.name}</h3>
                    </div>
                  </div>
                  <div className="mb-3">
                    <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest">Specialty</span>
                    <p className="text-sm text-primary mt-1">{agent.specialty}</p>
                  </div>
                  <div>
                    <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest">Characteristics</span>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{agent.characteristics}</p>
                  </div>
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