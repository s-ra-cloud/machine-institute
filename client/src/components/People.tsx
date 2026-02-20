import { FadeIn, StaggerContainer, StaggerItem } from "./ui/motion";

export function People() {
  const people = [
    { name: "Dr. Elena Chen", role: "Research Lead", interest: "Agent Architectures" },
    { name: "Marcus Smith", role: "Applied Scientist", interest: "Evaluation Metrics" },
    { name: "Aisha Patel", role: "Engineer", interest: "Tool-Use Frameworks" },
    { name: "Dr. James Doe", role: "Visiting Fellow", interest: "Multi-Agent Systems" },
    { name: "Sarah Johnson", role: "Research Engineer", interest: "Alignment & Safety" },
    { name: "Lin Wang", role: "Applied Scientist", interest: "Reinforcement Learning" }
  ];

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n.replace('Dr.', '')).filter(n => n.trim().length > 0).map(n => n[0]).join('').substring(0, 2);
  };

  return (
    <section className="py-24 bg-muted/10 border-t border-border/50" id="people">
      <div className="container mx-auto px-6">
        <FadeIn className="mb-16 text-center">
          <h2 className="text-3xl md:text-4xl font-heading font-bold mb-4">Our People</h2>
          <div className="h-1 w-20 bg-primary/50 mx-auto" />
        </FadeIn>

        <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {people.map((person, idx) => (
            <StaggerItem key={idx}>
              <div className="flex items-center gap-4 group">
                <div className="w-16 h-16 rounded-full bg-background border border-border/50 flex items-center justify-center text-primary font-mono tracking-widest text-sm group-hover:border-primary/50 group-hover:shadow-[0_0_15px_rgba(124,58,237,0.2)] transition-all shrink-0">
                  {getInitials(person.name)}
                </div>
                <div>
                  <h3 className="font-medium text-foreground">{person.name}</h3>
                  <p className="text-sm text-primary font-mono mt-1">{person.role}</p>
                  <p className="text-xs text-muted-foreground mt-1">{person.interest}</p>
                </div>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  );
}