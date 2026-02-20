import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";

export function Navigation() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollTo = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <header 
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 border-b border-transparent ${
        scrolled ? "bg-background/80 backdrop-blur-md border-border/50 py-3" : "bg-transparent py-5"
      }`}
    >
      <div className="container mx-auto px-6 flex items-center justify-between">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} data-testid="link-home">
          <div className="w-6 h-6 rounded bg-primary/20 flex items-center justify-center border border-primary/50">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          </div>
          <span className="font-heading font-bold text-lg tracking-tight">Machine<span className="text-muted-foreground font-light">Institute</span></span>
        </div>

        <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-muted-foreground">
          {['Research', 'Projects', 'Publications', 'People'].map((item) => (
            <button 
              key={item}
              onClick={() => scrollTo(item.toLowerCase())}
              className="hover:text-foreground transition-colors"
              data-testid={`link-nav-${item.toLowerCase()}`}
            >
              {item}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-4">
          <Button 
            onClick={() => scrollTo('collaborate')}
            className="bg-primary/10 text-primary hover:bg-primary hover:text-white border border-primary/20 transition-all duration-300 shadow-[0_0_15px_rgba(124,58,237,0.15)] hover:shadow-[0_0_25px_rgba(124,58,237,0.4)] hidden sm:flex font-mono text-xs uppercase tracking-wider"
            data-testid="button-collaborate-nav"
          >
            Collaborate
          </Button>
        </div>
      </div>
    </header>
  );
}