import { Link } from "wouter";

export function Footer() {
  return (
    <footer className="py-8 bg-background border-t border-border/30">
      <div className="container mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="Machine Institute" className="h-5 w-5 object-contain" />
          <p className="text-sm text-muted-foreground">Machine Institute</p>
        </div>

        <div className="flex gap-6 text-sm font-mono text-muted-foreground">
          <Link href="/history" className="hover:text-foreground transition-colors">History</Link>
          <a href="https://future-science.org/" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Future Science</a>
          <a href="https://knowledgelab.org/" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Knowledge Lab</a>
          <a href="https://chairtransitions.com/" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Chair of Transitions</a>
        </div>
      </div>
    </footer>
  );
}