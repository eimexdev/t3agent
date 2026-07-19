import { describe, expect, it } from "vite-plus/test";

import {
  CLOSE_ACTIVE_RIGHT_PANEL_SURFACE_EVENT,
  requestCloseActiveRightPanelSurface,
  resolveNativeCloseTarget,
  resolveRightPanelCloseTarget,
  shouldDeferCloseCommandToDesktopMenu,
  shouldDeferCloseShortcutToDesktopMenu,
} from "./rightPanelCloseRequest";

const keyboardEvent = (overrides: Partial<KeyboardEvent> = {}) =>
  ({
    code: "KeyW",
    key: "w",
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  }) as KeyboardEvent;

describe("requestCloseActiveRightPanelSurface", () => {
  it("reports when the active right-panel surface handles the request", () => {
    const target = new EventTarget();
    target.addEventListener(CLOSE_ACTIVE_RIGHT_PANEL_SURFACE_EVENT, (event) => {
      event.preventDefault();
    });

    expect(requestCloseActiveRightPanelSurface(target)).toBe(true);
  });

  it("leaves an unhandled request available for window closing", () => {
    expect(requestCloseActiveRightPanelSurface(new EventTarget())).toBe(false);
  });

  it("defers the native Cmd+W accelerator only in the macOS desktop app", () => {
    expect(
      shouldDeferCloseShortcutToDesktopMenu({
        desktop: true,
        platform: "MacIntel",
        event: keyboardEvent(),
      }),
    ).toBe(true);
    expect(
      shouldDeferCloseShortcutToDesktopMenu({
        desktop: false,
        platform: "MacIntel",
        event: keyboardEvent(),
      }),
    ).toBe(false);
    expect(
      shouldDeferCloseShortcutToDesktopMenu({
        desktop: true,
        platform: "Win32",
        event: keyboardEvent(),
      }),
    ).toBe(false);
  });

  it("keeps rebound macOS shortcuts in the renderer", () => {
    expect(
      shouldDeferCloseShortcutToDesktopMenu({
        desktop: true,
        platform: "MacIntel",
        event: keyboardEvent({ code: "KeyK", key: "k" }),
      }),
    ).toBe(false);
    expect(
      shouldDeferCloseShortcutToDesktopMenu({
        desktop: true,
        platform: "MacIntel",
        event: keyboardEvent({ shiftKey: true }),
      }),
    ).toBe(false);
  });

  it("defers Cmd+W when the physical key and layout character differ", () => {
    expect(
      shouldDeferCloseShortcutToDesktopMenu({
        desktop: true,
        platform: "MacIntel",
        event: keyboardEvent({ key: "z" }),
      }),
    ).toBe(true);
  });

  it("defers native Cmd+W for focused terminal close commands", () => {
    expect(
      shouldDeferCloseCommandToDesktopMenu({
        command: "terminal.close",
        desktop: true,
        event: keyboardEvent(),
        platform: "MacIntel",
        terminalFocused: true,
      }),
    ).toBe(true);
    expect(
      shouldDeferCloseCommandToDesktopMenu({
        command: "terminal.close",
        desktop: true,
        event: keyboardEvent(),
        platform: "MacIntel",
        terminalFocused: false,
      }),
    ).toBe(false);
  });
});

describe("resolveRightPanelCloseTarget", () => {
  it("closes the active surface when the open panel has one", () => {
    expect(
      resolveRightPanelCloseTarget({
        isOpen: true,
        hasActiveSurface: true,
        hasFocusedTerminal: false,
      }),
    ).toBe("surface");
  });

  it("closes the focused terminal pane before its containing surface", () => {
    expect(
      resolveRightPanelCloseTarget({
        isOpen: true,
        hasActiveSurface: true,
        hasFocusedTerminal: true,
      }),
    ).toBe("terminal");
  });

  it("closes the panel itself when it is open without a surface", () => {
    expect(
      resolveRightPanelCloseTarget({
        isOpen: true,
        hasActiveSurface: false,
        hasFocusedTerminal: false,
      }),
    ).toBe("panel");
  });

  it("does not intercept window close when the panel is hidden", () => {
    expect(
      resolveRightPanelCloseTarget({
        isOpen: false,
        hasActiveSurface: true,
        hasFocusedTerminal: false,
      }),
    ).toBeNull();
  });
});

describe("resolveNativeCloseTarget", () => {
  const defaults = {
    focusOwner: null,
    drawerTerminalOpen: true,
    rightPanelOpen: true,
    hasActiveRightPanelSurface: true,
    activeRightPanelSurfaceIsTerminal: false,
  } as const;

  it("does not intercept window close when focus is outside an open panel", () => {
    expect(resolveNativeCloseTarget(defaults)).toBeNull();
  });

  it("closes a focused drawer terminal before an open right panel", () => {
    expect(resolveNativeCloseTarget({ ...defaults, focusOwner: "drawer-terminal" })).toBe(
      "drawer-terminal",
    );
  });

  it("ignores stale drawer ownership after the drawer closes", () => {
    expect(
      resolveNativeCloseTarget({
        ...defaults,
        focusOwner: "drawer-terminal",
        drawerTerminalOpen: false,
      }),
    ).toBeNull();
  });

  it("closes only the focused pane in a right-panel terminal group", () => {
    expect(
      resolveNativeCloseTarget({
        ...defaults,
        focusOwner: "right-panel-terminal",
        activeRightPanelSurfaceIsTerminal: true,
      }),
    ).toBe("right-panel-terminal");
  });

  it("closes the active surface for other right-panel focus", () => {
    expect(resolveNativeCloseTarget({ ...defaults, focusOwner: "right-panel" })).toBe(
      "right-panel-surface",
    );
  });

  it("closes an empty focused panel without closing the window", () => {
    expect(
      resolveNativeCloseTarget({
        ...defaults,
        focusOwner: "right-panel",
        hasActiveRightPanelSurface: false,
      }),
    ).toBe("right-panel");
  });

  it("does not intercept after the right panel closes", () => {
    expect(
      resolveNativeCloseTarget({
        ...defaults,
        focusOwner: "right-panel",
        rightPanelOpen: false,
      }),
    ).toBeNull();
  });
});
