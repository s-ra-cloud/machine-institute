export function Footer() {
  return (
    <footer className="py-8 bg-background border-t border-border/30">
      <div className="container mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-primary/20 flex items-center justify-center border border-primary/50">
            <div className="w-1 h-1 rounded-full bg-primary" />
          </div>
          <p className="text-sm text-muted-foreground">Machine Institute. Research Center for AI Agents.</p>
        </div>
        
        <div className="flex gap-6 text-sm font-mono text-muted-foreground">
          <a href="#" className="hover:text-foreground transition-colors">Terms</a>
          <a href="#" className="hover:text-foreground transition-colors">Privacy</a>
        </div>
      </div>
    </footer>
  );
}