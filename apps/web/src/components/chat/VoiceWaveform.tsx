import { useId, type MouseEvent } from "react";

import { cn } from "~/lib/utils";

const FALLBACK_LEVELS = Array.from({ length: 48 }, () => 0.12);

export function VoiceWaveform({
  levels,
  progress = 0,
  live = false,
  onSeek,
  className,
}: {
  readonly levels: ReadonlyArray<number>;
  readonly progress?: number;
  readonly live?: boolean;
  readonly onSeek?: (progress: number) => void;
  readonly className?: string;
}) {
  const clipId = useId().replaceAll(":", "");
  const waveform = levels.length > 0 ? levels : FALLBACK_LEVELS;
  const width = waveform.length * 4;
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const path = waveform
    .map((level, index) => {
      const height = Math.max(3, Math.min(26, level * 26));
      const x = index * 4 + 2;
      return `M${x} ${14 - height / 2}V${14 + height / 2}`;
    })
    .join(" ");
  const seek = (event: MouseEvent<SVGSVGElement>) => {
    if (!onSeek) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    onSeek((event.clientX - bounds.left) / Math.max(1, bounds.width));
  };

  return (
    <svg
      viewBox={`0 0 ${width} 28`}
      preserveAspectRatio="none"
      className={cn("h-7 min-w-24 flex-1", onSeek && "cursor-pointer", className)}
      aria-label={onSeek ? "Seek voice note" : "Voice waveform"}
      role={onSeek ? "slider" : "img"}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? 100 : undefined}
      aria-valuenow={onSeek ? Math.round(clampedProgress * 100) : undefined}
      onClick={seek}
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        className="text-muted-foreground/30"
      />
      <defs>
        <clipPath id={clipId}>
          <rect width={live ? width : width * clampedProgress} height="28" />
        </clipPath>
      </defs>
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        clipPath={`url(#${clipId})`}
        className={live ? "text-red-500" : "text-foreground/80"}
      />
    </svg>
  );
}
