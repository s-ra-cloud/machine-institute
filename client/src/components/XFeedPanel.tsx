import { useState, useEffect, useRef } from "react";
import { X as XIcon } from "lucide-react";

export function XFeedPanel() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed left-0 top-1/2 -translate-y-1/2 z-40 bg-background/90 backdrop-blur-sm border border-border/50 border-l-0 rounded-r-lg px-2 py-4 hover:bg-muted/50 hover:border-primary/30 transition-all group"
        data-testid="button-open-feed"
        aria-label="Open X feed"
      >
        <div className="flex flex-col items-center gap-2">
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          <span className="text-[10px] font-mono text-muted-foreground group-hover:text-foreground transition-colors [writing-mode:vertical-lr]">
            Feed
          </span>
        </div>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          <div
            ref={panelRef}
            className="relative w-full max-w-md bg-background border-r border-border/50 h-full overflow-y-auto animate-in slide-in-from-left duration-300"
          >
            <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/50 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <svg viewBox="0 0 24 24" className="w-5 h-5 text-foreground" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                <h2 className="font-heading font-semibold text-lg">Feed</h2>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="p-2 hover:bg-muted rounded transition-colors"
                data-testid="button-close-feed"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6">
              <p className="text-xs font-mono text-muted-foreground/60 uppercase tracking-widest mb-4">
                Mentions of Machine Institute
              </p>

              <div className="min-h-[400px]">
                <a
                  className="twitter-timeline"
                  data-theme="dark"
                  data-chrome="noheader nofooter noborders transparent"
                  href="https://twitter.com/search?q=%22Machine%20Institute%22"
                >
                  Loading feed...
                </a>
              </div>

              <div className="mt-6 pt-6 border-t border-border/50">
                <a
                  href="https://twitter.com/search?q=%22Machine%20Institute%22"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-mono text-primary hover:text-accent transition-colors"
                  data-testid="link-view-on-x"
                >
                  View on X
                  <svg viewBox="0 0 24 24" className="w-3 h-3" fill="currentColor">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}