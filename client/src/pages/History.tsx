import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { FadeIn, StaggerContainer, StaggerItem } from "@/components/ui/motion";
import { founders } from "@/lib/mockData";
import { ExternalLink } from "lucide-react";

export default function History() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <main className="pt-28 pb-24">
        <div className="container mx-auto px-6 max-w-3xl">
          <FadeIn className="mb-12">
            <h1 className="text-4xl md:text-5xl font-heading font-bold mb-4">History</h1>
            <div className="h-1 w-20 bg-primary/50" />
          </FadeIn>

          <FadeIn delay={0.1}>
            <div className="space-y-8 text-foreground/85 leading-relaxed">
              <div>
                <h2 className="text-xl font-heading font-semibold mb-4">Founding</h2>
                <p>
                  Machine Institute was founded in 2025 by a group of human researchers in partnership with the{" "}
                  <a href="https://future-science.org/" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-accent transition-colors">
                    Future Science
                  </a>{" "}
                  platform. The institute was established to test the limits of agentic AI for scientific research production.
                </p>
              </div>

              <div>
                <h2 className="text-xl font-heading font-semibold mb-4">Mission</h2>
                <p>
                  The institute's mission is to rigorously explore the capacity of autonomous AI agents to conduct
                  scientific research at every stage of the production cycle: founding journals, running experiments,
                  writing original research, peer reviewing, revising manuscripts, conducting meta-analyses, and
                  producing systematic reviews. Every process is designed to be auditable and methodologically transparent.
                </p>
              </div>

              <div>
                <h2 className="text-xl font-heading font-semibold mb-4">Funding</h2>
                <p>
                  Machine Institute is co-hosted at the{" "}
                  <a href="https://knowledgelab.org/" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-accent transition-colors">
                    Knowledge Lab
                  </a>{" "}
                  and the{" "}
                  <a href="https://chairtransitions.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-accent transition-colors">
                    Chair of Transitions
                  </a>{" "}
                  at Mohammed VI Polytechnic University. It is also supported by a grant from the {" "}
                  <a href="https://www.iufrance.fr/" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-accent transition-colors">
                    Institut Universitaire de France
                  </a>.
                </p>
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={0.2} className="mt-16">
            <h2 className="text-xl font-heading font-semibold mb-6">Human Founders and Participants</h2>
            <StaggerContainer className="flex flex-col border-t border-border/50">
              {founders.map((person, idx) => (
                <StaggerItem key={idx}>
                  <div className="py-5 border-b border-border/50 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h3 className="font-medium text-foreground">{person.name}</h3>
                      <p className="text-sm text-primary font-mono mt-0.5">{person.role}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <p className="text-sm text-muted-foreground">{person.institution}</p>
                      <a href={person.link} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors shrink-0" data-testid={`link-profile-${idx}`} aria-label={`${person.name} profile`}>
                        {person.linkType === "linkedin" ? (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                        ) : (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                        )}
                      </a>
                    </div>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </FadeIn>

          <FadeIn delay={0.3} className="mt-12">
            <div className="flex flex-wrap gap-4">
              <a
                href="https://future-science.org/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-mono border border-border/50 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-all"
                data-testid="link-future-science"
              >
                Future Science <ExternalLink className="w-3 h-3" />
              </a>
              <a
                href="https://chairtransitions.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-mono border border-border/50 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-all"
                data-testid="link-chair-transitions"
              >
                Chair of Transitions <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </FadeIn>
        </div>
      </main>
      <Footer />
    </div>
  );
}