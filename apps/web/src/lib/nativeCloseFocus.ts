export type NativeCloseFocusOwner = "drawer-terminal" | "right-panel-terminal" | "right-panel";

const RIGHT_PANEL_SELECTOR =
  "[data-right-panel-tabbar], [data-right-panel-content], [data-right-panel-control]";

let retainedOwner: NativeCloseFocusOwner | null = null;
let pointerTransitionActive = false;

function ownerForElement(
  element: Element,
  activePreviewTabId: string | null,
): NativeCloseFocusOwner | null {
  if (!element.isConnected) return null;

  const terminalOwner =
    element.closest<HTMLElement>("[data-terminal-owner]")?.dataset.terminalOwner;
  if (terminalOwner === "drawer") return "drawer-terminal";
  if (terminalOwner === "right-panel") return "right-panel-terminal";

  const previewViewport = element.closest<HTMLElement>("[data-preview-viewport]");
  const focusedPreviewTabId =
    element.tagName.toLowerCase() === "webview"
      ? element.getAttribute("data-preview-tab")
      : (previewViewport?.getAttribute("data-preview-viewport") ?? null);
  if (focusedPreviewTabId !== null) {
    return focusedPreviewTabId === activePreviewTabId ? "right-panel" : null;
  }

  if (element.closest(RIGHT_PANEL_SELECTOR)) return "right-panel";
  return null;
}

/** Records an in-document focus or pointer transition before native UI can obscure DOM focus. */
export function recordNativeCloseFocus(
  target: EventTarget | null,
  activePreviewTabId: string | null,
): void {
  retainedOwner = target instanceof Element ? ownerForElement(target, activePreviewTabId) : null;
}

/** Records pointer intent before a non-focusable target can blur the previous owner to body. */
export function recordNativeClosePointer(
  target: EventTarget | null,
  activePreviewTabId: string | null,
): void {
  pointerTransitionActive = true;
  recordNativeCloseFocus(target, activePreviewTabId);
}

export function finishNativeClosePointer(): void {
  pointerTransitionActive = false;
}

/**
 * Clears real in-document focus exits while preserving ownership when focus
 * temporarily moves into native application UI such as the macOS menu bar.
 */
export function recordNativeCloseFocusOut(
  relatedTarget: EventTarget | null,
  documentHasFocus: boolean,
  activePreviewTabId: string | null,
): void {
  if (relatedTarget instanceof Element) {
    retainedOwner = ownerForElement(relatedTarget, activePreviewTabId);
    return;
  }
  if (documentHasFocus && !pointerTransitionActive) retainedOwner = null;
}

export function getNativeCloseFocusOwner(
  activePreviewTabId: string | null,
): NativeCloseFocusOwner | null {
  const activeElement = document.activeElement;
  if (activeElement instanceof Element && activeElement.isConnected) {
    const liveOwner = ownerForElement(activeElement, activePreviewTabId);
    if (liveOwner !== null) {
      retainedOwner = liveOwner;
      return liveOwner;
    }
    if (activeElement !== document.body) {
      retainedOwner = null;
      return null;
    }
  }
  return retainedOwner;
}

export function clearNativeCloseFocusOwner(owner?: NativeCloseFocusOwner): void {
  if (owner !== undefined && retainedOwner !== owner) return;
  retainedOwner = null;
  pointerTransitionActive = false;
}
