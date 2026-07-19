import { afterEach, describe, expect, it } from "vite-plus/test";

import { isRightPanelFocused } from "./rightPanelFocus";

class MockHTMLElement {
  isConnected = false;
  rightPanelRegion = false;
  inPreviewViewport = false;
  previewTabId: string | null = null;
  tagName = "div";

  closest(selector: string): MockHTMLElement | null {
    if (!this.isConnected) return null;
    if (selector === "[data-preview-viewport]" && this.inPreviewViewport) return this;
    if (
      selector ===
        "[data-right-panel-tabbar], [data-right-panel-content], [data-right-panel-control]" &&
      this.rightPanelRegion
    ) {
      return this;
    }
    return null;
  }

  getAttribute(name: string): string | null {
    if (name === "data-preview-tab" || name === "data-preview-viewport") {
      return this.previewTabId;
    }
    return null;
  }
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }

  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

describe("isRightPanelFocused", () => {
  it("recognizes focus in the right-panel tab bar or active surface", () => {
    const activeElement = new MockHTMLElement();
    activeElement.isConnected = true;
    activeElement.rightPanelRegion = true;

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement } as unknown as Document;

    expect(isRightPanelFocused({ rightPanelOpen: true, activePreviewTabId: null })).toBe(true);
  });

  it("recognizes hosted preview focus while the right panel is open", () => {
    const webview = new MockHTMLElement();
    webview.isConnected = true;
    webview.tagName = "webview";
    webview.previewTabId = "preview-a";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: webview } as unknown as Document;

    expect(isRightPanelFocused({ rightPanelOpen: true, activePreviewTabId: "preview-a" })).toBe(
      true,
    );

    const viewport = new MockHTMLElement();
    viewport.isConnected = true;
    viewport.inPreviewViewport = true;
    viewport.previewTabId = "preview-a";
    globalThis.document = { activeElement: viewport } as unknown as Document;

    expect(isRightPanelFocused({ rightPanelOpen: true, activePreviewTabId: "preview-a" })).toBe(
      true,
    );
    expect(isRightPanelFocused({ rightPanelOpen: true, activePreviewTabId: "preview-b" })).toBe(
      false,
    );
  });

  it("ignores right-panel controls when the panel is closed", () => {
    const activeElement = new MockHTMLElement();
    activeElement.isConnected = true;
    activeElement.rightPanelRegion = true;

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement } as unknown as Document;

    expect(isRightPanelFocused({ rightPanelOpen: false, activePreviewTabId: null })).toBe(false);
  });

  it("ignores detached elements and focus outside the right panel", () => {
    const activeElement = new MockHTMLElement();
    activeElement.rightPanelRegion = true;

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement } as unknown as Document;

    expect(isRightPanelFocused({ rightPanelOpen: true, activePreviewTabId: null })).toBe(false);

    activeElement.isConnected = true;
    activeElement.rightPanelRegion = false;
    expect(isRightPanelFocused({ rightPanelOpen: true, activePreviewTabId: null })).toBe(false);
  });
});
