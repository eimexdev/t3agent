import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { handleSurfaceTabAuxClick } from "~/lib/rightPanelTabPointer";

import { RightPanelTabs } from "./RightPanelTabs";
import {
  PanelLayoutControls,
  RightPanelCloseControl,
  RightPanelMaximizeControl,
} from "./chat/PanelLayoutControls";

vi.mock("~/env", () => ({ isElectron: false }));

function renderTabs(mode: "inline" | "sheet"): string {
  return renderToStaticMarkup(
    <RightPanelTabs
      mode={mode}
      surfaces={[]}
      activeSurfaceId={null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      terminalLabelsById={new Map()}
      onActivate={vi.fn()}
      onCloseSurface={vi.fn()}
      onCloseOtherSurfaces={vi.fn()}
      onCloseSurfacesToRight={vi.fn()}
      onCloseAllSurfaces={vi.fn()}
      onCopyFilePath={vi.fn()}
      onAddBrowser={vi.fn()}
      onAddTerminal={vi.fn()}
      onAddDiff={vi.fn()}
      onAddFiles={vi.fn()}
      browserAvailable
      diffAvailable
      filesAvailable
    >
      <div>Active surface</div>
    </RightPanelTabs>,
  );
}

describe("RightPanelTabs", () => {
  it("closes the clicked surface on middle mouse button", () => {
    const surface = { id: "files", kind: "files" } as const;
    const event = {
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const onCloseSurface = vi.fn();

    handleSurfaceTabAuxClick(event, surface, onCloseSurface);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onCloseSurface).toHaveBeenCalledOnce();
    expect(onCloseSurface).toHaveBeenCalledWith(surface);
  });

  it.each([0, 2])("ignores auxiliary click button %s", (button) => {
    const event = {
      button,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const onCloseSurface = vi.fn();

    handleSurfaceTabAuxClick(event, { id: "files", kind: "files" }, onCloseSurface);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(onCloseSurface).not.toHaveBeenCalled();
  });

  it("marks the panel content region", () => {
    const markup = renderTabs("inline");

    expect(markup).toContain("data-right-panel-content");
  });

  it("places the whole-panel close control after the other title-bar controls", () => {
    const markup = renderToStaticMarkup(
      <div>
        <RightPanelMaximizeControl maximized={false} onToggle={vi.fn()} />
        <PanelLayoutControls
          terminalAvailable
          terminalOpen={false}
          terminalShortcutLabel={null}
          rightPanelAvailable
          rightPanelOpen
          rightPanelShortcutLabel={null}
          onToggleTerminal={vi.fn()}
          onToggleRightPanel={vi.fn()}
        />
        <RightPanelCloseControl onClose={vi.fn()} />
      </div>,
    );

    expect(markup.indexOf('aria-label="Close right panel"')).toBeGreaterThan(
      markup.indexOf('aria-label="Toggle right panel"'),
    );
  });
});
