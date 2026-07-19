import type { RightPanelSurface } from "~/rightPanelStore";

interface SurfaceTabAuxClickEvent {
  readonly button: number;
  preventDefault(): void;
  stopPropagation(): void;
}

export function handleSurfaceTabAuxClick(
  event: SurfaceTabAuxClickEvent,
  surface: RightPanelSurface,
  onCloseSurface: (surface: RightPanelSurface) => void,
): void {
  if (event.button !== 1) return;
  event.preventDefault();
  event.stopPropagation();
  onCloseSurface(surface);
}
