import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  clearNativeCloseFocusOwner,
  finishNativeClosePointer,
  getNativeCloseFocusOwner,
  recordNativeCloseFocus,
  recordNativeCloseFocusOut,
  recordNativeClosePointer,
} from "./nativeCloseFocus";

class MockElement extends EventTarget {
  isConnected = true;
  owner: "drawer" | "right-panel" | null = null;
  inRightPanel = false;
  inPreviewViewport = false;
  tagName = "div";

  closest(selector: string): MockElement | null {
    if (!this.isConnected) return null;
    if (selector === "[data-terminal-owner]" && this.owner !== null) return this;
    if (selector.includes("[data-right-panel-tabbar]") && this.inRightPanel) return this;
    if (selector === "[data-preview-viewport]" && this.inPreviewViewport) return this;
    return null;
  }

  get dataset(): DOMStringMap {
    return { terminalOwner: this.owner ?? undefined } as DOMStringMap;
  }
}

const originalDocument = globalThis.document;
const originalElement = globalThis.Element;

afterEach(() => {
  clearNativeCloseFocusOwner();
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }
  if (originalElement === undefined) {
    delete (globalThis as { Element?: typeof Element }).Element;
  } else {
    globalThis.Element = originalElement;
  }
});

function installDom(activeElement: MockElement, body = new MockElement()): void {
  globalThis.Element = MockElement as unknown as typeof Element;
  globalThis.document = { activeElement, body } as unknown as Document;
}

describe("native close focus", () => {
  it("distinguishes drawer terminals, right-panel terminals, and other panel focus", () => {
    const drawer = new MockElement();
    drawer.owner = "drawer";
    installDom(drawer);
    expect(getNativeCloseFocusOwner()).toBe("drawer-terminal");

    const panelTerminal = new MockElement();
    panelTerminal.owner = "right-panel";
    installDom(panelTerminal);
    expect(getNativeCloseFocusOwner()).toBe("right-panel-terminal");

    const panelControl = new MockElement();
    panelControl.inRightPanel = true;
    installDom(panelControl);
    expect(getNativeCloseFocusOwner()).toBe("right-panel");
  });

  it("retains ownership only while focus is obscured by native UI", () => {
    const terminal = new MockElement();
    terminal.owner = "drawer";
    const body = new MockElement();
    installDom(body, body);
    recordNativeCloseFocus(terminal);
    recordNativeCloseFocusOut(null, false);

    expect(getNativeCloseFocusOwner()).toBe("drawer-terminal");

    recordNativeCloseFocusOut(null, true);
    expect(getNativeCloseFocusOwner()).toBeNull();
  });

  it("preserves pointer ownership until the pointer gesture finishes", async () => {
    const panelChrome = new MockElement();
    panelChrome.inRightPanel = true;
    const body = new MockElement();
    installDom(body, body);

    recordNativeClosePointer(panelChrome);
    await Promise.resolve();
    recordNativeCloseFocusOut(null, true);
    finishNativeClosePointer();

    expect(getNativeCloseFocusOwner()).toBe("right-panel");
  });

  it("clears retained ownership on focus or pointer movement outside the panel", () => {
    const panel = new MockElement();
    panel.inRightPanel = true;
    const outside = new MockElement();
    installDom(outside);
    recordNativeCloseFocus(panel);
    recordNativeCloseFocus(outside);

    expect(getNativeCloseFocusOwner()).toBeNull();
  });

  it("updates ownership directly from a focusout related target", () => {
    const drawer = new MockElement();
    drawer.owner = "drawer";
    const panel = new MockElement();
    panel.inRightPanel = true;
    installDom(panel);
    recordNativeCloseFocus(drawer);
    recordNativeCloseFocusOut(panel, true);

    expect(getNativeCloseFocusOwner()).toBe("right-panel");
  });

  it("treats hosted preview webviews and viewport chrome as right-panel focus", () => {
    const webview = new MockElement();
    webview.tagName = "webview";
    installDom(webview);
    expect(getNativeCloseFocusOwner()).toBe("right-panel");

    const viewport = new MockElement();
    viewport.inPreviewViewport = true;
    installDom(viewport);
    expect(getNativeCloseFocusOwner()).toBe("right-panel");
  });

  it("ignores detached retained targets", () => {
    const terminal = new MockElement();
    terminal.owner = "drawer";
    terminal.isConnected = false;
    const body = new MockElement();
    installDom(body, body);
    recordNativeCloseFocus(terminal);

    expect(getNativeCloseFocusOwner()).toBeNull();
  });
});
