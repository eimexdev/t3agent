import { isMacPlatform } from "./utils";
import type { NativeCloseFocusOwner } from "./nativeCloseFocus";

export const CLOSE_ACTIVE_RIGHT_PANEL_SURFACE_EVENT = "t3:close-active-right-panel-surface";

interface NativeCloseShortcutInput {
  readonly desktop: boolean;
  readonly platform: string;
  readonly event: {
    readonly code?: string;
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
  };
}

export function shouldDeferCloseShortcutToDesktopMenu({
  desktop,
  platform,
  event,
}: NativeCloseShortcutInput): boolean {
  return (
    desktop &&
    isMacPlatform(platform) &&
    (event.key.toLowerCase() === "w" || event.code === "KeyW") &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function shouldDeferCloseCommandToDesktopMenu({
  command,
  terminalFocused,
  ...shortcut
}: NativeCloseShortcutInput & {
  readonly command: string;
  readonly terminalFocused: boolean;
}): boolean {
  const isNativeCloseCommand =
    command === "rightPanel.closeActiveSurface" ||
    (command === "terminal.close" && terminalFocused);
  return isNativeCloseCommand && shouldDeferCloseShortcutToDesktopMenu(shortcut);
}

export function resolveRightPanelCloseTarget({
  isOpen,
  hasActiveSurface,
  hasFocusedTerminal,
}: {
  readonly isOpen: boolean;
  readonly hasActiveSurface: boolean;
  readonly hasFocusedTerminal: boolean;
}): "terminal" | "surface" | "panel" | null {
  if (!isOpen) return null;
  if (hasFocusedTerminal) return "terminal";
  return hasActiveSurface ? "surface" : "panel";
}

export function resolveNativeCloseTarget({
  focusOwner,
  drawerTerminalOpen,
  rightPanelOpen,
  hasActiveRightPanelSurface,
  activeRightPanelSurfaceIsTerminal,
}: {
  readonly focusOwner: NativeCloseFocusOwner | null;
  readonly drawerTerminalOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly hasActiveRightPanelSurface: boolean;
  readonly activeRightPanelSurfaceIsTerminal: boolean;
}): "drawer-terminal" | "right-panel-terminal" | "right-panel-surface" | "right-panel" | null {
  if (focusOwner === "drawer-terminal") {
    return drawerTerminalOpen ? "drawer-terminal" : null;
  }
  if (focusOwner !== "right-panel" && focusOwner !== "right-panel-terminal") return null;
  if (!rightPanelOpen) return null;
  if (!hasActiveRightPanelSurface) return "right-panel";
  if (focusOwner === "right-panel-terminal" && activeRightPanelSurfaceIsTerminal) {
    return "right-panel-terminal";
  }
  return "right-panel-surface";
}

export function requestCloseActiveRightPanelSurface(
  target: Pick<Window, "dispatchEvent"> = window,
): boolean {
  const event = new Event(CLOSE_ACTIVE_RIGHT_PANEL_SURFACE_EVENT, {
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
