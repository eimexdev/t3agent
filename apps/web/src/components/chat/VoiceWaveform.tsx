import { useId, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "~/lib/utils";

const FALLBACK_LEVELS = Array.from({ length: 48 }, () => 0.12);

export function pointerSeekProgress(clientX: number, left: number, width: number): number {
  return Math.max(0, Math.min(1, (clientX - left) / Math.max(1, width)));
}

export function keyboardSeekProgress(progress: number, key: string): number | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return Math.max(0, progress - 0.05);
    case "ArrowRight":
    case "ArrowUp":
      return Math.min(1, progress + 0.05);
    case "Home":
      return 0;
    case "End":
      return 1;
    default:
      return null;
  }
}

export function voiceSeekTargetSeconds(
  progress: number,
  mediaDurationSeconds: number,
  fallbackDurationMs: number,
): number {
  const durationSeconds =
    Number.isFinite(mediaDurationSeconds) && mediaDurationSeconds > 0
      ? mediaDurationSeconds
      : Math.max(0, fallbackDurationMs / 1_000);
  return Math.max(0, Math.min(1, progress)) * durationSeconds;
}

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
  const seekFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (!onSeek) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    onSeek(pointerSeekProgress(event.clientX, bounds.left, bounds.width));
  };
  const seekFromKeyboard = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!onSeek) return;
    const nextProgress = keyboardSeekProgress(clampedProgress, event.key);
    if (nextProgress === null) return;
    event.preventDefault();
    onSeek(nextProgress);
  };

  return (
    <svg
      viewBox={`0 0 ${width} 28`}
      preserveAspectRatio="none"
      className={cn(
        "h-7 min-w-24 flex-1",
        onSeek && "touch-none cursor-ew-resize select-none focus-visible:outline-2",
        className,
      )}
      aria-label={onSeek ? "Seek voice note" : "Voice waveform"}
      role={onSeek ? "slider" : "img"}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? 100 : undefined}
      aria-valuenow={onSeek ? Math.round(clampedProgress * 100) : undefined}
      tabIndex={onSeek ? 0 : undefined}
      onPointerDown={(event) => {
        if (!onSeek || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        seekFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (!onSeek || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        seekFromPointer(event);
      }}
      onPointerUp={(event) => {
        if (!onSeek || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        seekFromPointer(event);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onKeyDown={seekFromKeyboard}
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
