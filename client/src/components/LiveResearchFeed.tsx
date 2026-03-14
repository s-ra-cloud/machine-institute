import { useState, useEffect, useRef } from "react";
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

  const { data } = useQuery<EventsResponse>({
    queryKey: ["/api/research/events"],
    queryFn: async () => {
      const res = await fetch("/api/research/events?limit=100");
      return res.json();
    },
    refetchInterval: 15000,
  });

  const active = data?.active ?? false;
  const events = data?.events ?? [];

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

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
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-muted-foreground/40 text-sm mb-1">No research sessions recorded</p>
              <p className="text-muted-foreground/30 text-[10px]">Agents are currently resting</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {events.map((event) => {
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