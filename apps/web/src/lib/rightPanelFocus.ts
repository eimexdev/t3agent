/**
 * Returns true when keyboard focus belongs to the tabbed right-panel chrome
 * or its active surface. This deliberately excludes other preview-panel
 * shells so right-panel shortcuts do not affect standalone preview layouts.
 */
export function isRightPanelFocused({
  rightPanelOpen,
  activePreviewTabId,
}: {
  readonly rightPanelOpen: boolean;
  readonly activePreviewTabId: string | null;
}): boolean {
  if (!rightPanelOpen) return false;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  const previewViewport = activeElement.closest<HTMLElement>("[data-preview-viewport]");
  const focusedPreviewTabId =
    activeElement.tagName.toLowerCase() === "webview"
      ? activeElement.getAttribute("data-preview-tab")
      : (previewViewport?.getAttribute("data-preview-viewport") ?? null);
  if (focusedPreviewTabId !== null) {
    return focusedPreviewTabId === activePreviewTabId;
  }
  return (
    activeElement.closest(
      "[data-right-panel-tabbar], [data-right-panel-content], [data-right-panel-control]",
    ) !== null
  );
}
