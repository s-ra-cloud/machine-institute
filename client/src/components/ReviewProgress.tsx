import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";

interface ReviewProgressProps {
  createdAt: string | Date;
  status: string;
  expectedDurationMs?: number;
  stages?: string[];
  queuedLabel?: string;
}

const DEFAULT_STAGES = ["Preparing", "Generating", "Finalizing"];

export function ReviewProgress({
  createdAt,
  status,
  expectedDurationMs = 60000,
  stages = DEFAULT_STAGES,
  queuedLabel = "Queued",
}: ReviewProgressProps) {
  const [now, setNow] = useState(() => Date.now());

  const isDone = status === "completed";

  useEffect(() => {
    if (isDone) return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [isDone]);

  const startMs = new Date(createdAt).getTime();
  const elapsed = Math.max(0, now - startMs);

  // Ease toward ~95% asymptotically; snap to 100 when completed.
  const tau = expectedDurationMs / 2;
  const eased = 95 * (1 - Math.exp(-elapsed / tau));
  const value = isDone ? 100 : Math.min(95, eased);

  const isPending = status === "pending";
  const fraction = value / 100;
  const stageIndex = Math.min(
    stages.length - 1,
    Math.floor(fraction * stages.length),
  );
  const label = isDone
    ? "Complete"
    : isPending
      ? queuedLabel
      : stages[stageIndex];

  return (
    <div className="border border-border/30 bg-muted/5 p-12">
      <div className="flex items-center justify-center gap-2 mb-6">
        <Loader2 className="w-5 h-5 text-primary animate-spin" />
        <p
          className="text-muted-foreground font-mono text-sm"
          data-testid="text-progress-stage"
        >
          {label}
        </p>
      </div>
      <div className="max-w-md mx-auto">
        <Progress
          value={value}
          className="h-2"
          data-testid="progress-review"
        />
        <div className="flex items-center justify-between mt-2">
          <p className="text-muted-foreground/50 text-xs">
            This page updates automatically.
          </p>
          <p
            className="text-muted-foreground/50 text-xs font-mono tabular-nums"
            data-testid="text-progress-percent"
          >
            {Math.round(value)}%
          </p>
        </div>
      </div>
    </div>
  );
}
