import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

interface ResearchEvent {
  id: string;
  source: string;
  agentId: string;
  phase: string;
  message: string;
  timestamp: string;
}

interface EventsResponse {
  active: boolean;
  events: ResearchEvent[];
  hasMore?: boolean;
}

function formatTime(ts: string) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(ts: string) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function LiveResearchFeed() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [atTop, setAtTop] = useState(false);
  const [olderEvents, setOlderEvents] = useState<ResearchEvent[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMoreOlder, setNoMoreOlder] = useState(false);

  const { data } = useQuery<EventsResponse>({
    queryKey: ["/api/research/events"],
    queryFn: async () => {
      const res = await fetch("/api/research/events?limit=200");
      return res.json();
    },
    refetchInterval: 15000,
  });

  const active = data?.active ?? false;
  const recentEvents = data?.events ?? [];

  const allEvents: ResearchEvent[] = (() => {
    const seen = new Set<string>();
    const merged: ResearchEvent[] = [];
    for (const e of [...olderEvents, ...recentEvents]) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        merged.push(e);
      }
    }
    merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return merged;
  })();

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allEvents, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
    setAtTop(scrollTop < 40);
  };

  const loadEarlier = useCallback(async () => {
    const oldest = allEvents[0];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/research/events?before=${encodeURIComponent(oldest.timestamp)}&limit=200`);
      const json: EventsResponse = await res.json();
      if (json.events.length === 0) {
        setNoMoreOlder(true);
      } else {
        const prevScrollHeight = scrollRef.current?.scrollHeight ?? 0;
        setOlderEvents(prev => {
          const seen = new Set(prev.map(e => e.id));
          const newOnes = json.events.filter(e => !seen.has(e.id));
          return [...newOnes, ...prev];
        });
        requestAnimationFrame(() => {
          if (scrollRef.current) {
            const newScrollHeight = scrollRef.current.scrollHeight;
            scrollRef.current.scrollTop = newScrollHeight - prevScrollHeight;
          }
        });
      }
    } finally {
      setLoadingMore(false);
    }
  }, [allEvents, loadingMore]);

  let lastDate = "";

  return (
    <div className="border border-border/50 bg-background overflow-hidden" data-testid="live-research-feed">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 bg-muted/10">
        <div className="flex items-center gap-3">
          <h3 className="font-mono text-sm font-semibold text-foreground">Execution Logs</h3>
        </div>
        <div className="flex items-center gap-2">
          {active ? (
            <>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              <span className="text-[10px] font-mono text-green-400 uppercase tracking-widest">Live</span>
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
              <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest">Idle</span>
            </>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-72 overflow-y-auto p-4 font-mono text-xs leading-relaxed"
      >
        {allEvents.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-muted-foreground/40 text-sm mb-1">No research sessions recorded</p>
              <p className="text-muted-foreground/30 text-[10px]">Agents are currently resting</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {atTop && !noMoreOlder && (
              <div className="flex justify-center mb-2">
                <button
                  onClick={loadEarlier}
                  disabled={loadingMore}
                  data-testid="button-load-earlier"
                  className="text-[10px] font-mono text-muted-foreground/50 hover:text-primary border border-border/40 hover:border-primary/30 px-3 py-1 transition-colors disabled:opacity-40"
                >
                  {loadingMore ? "Loading…" : "↑ Load earlier events"}
                </button>
              </div>
            )}
            {noMoreOlder && atTop && (
              <div className="text-center mb-2">
                <span className="text-[10px] font-mono text-muted-foreground/30">— beginning of log —</span>
              </div>
            )}

            {allEvents.map((event) => {
              const eventDate = formatDate(event.timestamp);
              const showDateSeparator = eventDate !== lastDate;
              lastDate = eventDate;

              return (
                <div key={event.id}>
                  {showDateSeparator && (
                    <div className="flex items-center gap-3 my-2 first:mt-0">
                      <div className="h-px flex-1 bg-border/30" />
                      <span className="text-[10px] font-mono text-muted-foreground/30 uppercase tracking-widest">{eventDate}</span>
                      <div className="h-px flex-1 bg-border/30" />
                    </div>
                  )}
                  <div className="flex gap-2 group hover:bg-muted/10 px-1 -mx-1 rounded" data-testid={`event-${event.id}`}>
                    <span className="text-muted-foreground/40 shrink-0">{formatTime(event.timestamp)}</span>
                    <span className="text-orange-400 shrink-0">{event.source}</span>
                    <span className="text-primary shrink-0">{event.agentId}</span>
                    <span className="text-muted-foreground/70">—</span>
                    <span className="text-green-400/70">{event.message}</span>
                  </div>
                </div>
              );
            })}

            {!active && (
              <div className="mt-3 pt-3 border-t border-border/20 text-center">
                <p className="text-muted-foreground/30 text-[10px]">Agents are currently resting</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
