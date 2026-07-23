import { describe, expect, it } from "vite-plus/test";

import { buildExpandedImagePreview } from "./ExpandedImagePreview";

describe("buildExpandedImagePreview", () => {
  it("builds a preview carousel for the selected previewable assistant attachment", () => {
    expect(
      buildExpandedImagePreview(
        [
          { id: "loading", name: "loading.png" },
          { id: "first", name: "first.png", previewUrl: "https://example.test/first.png" },
          { id: "second", name: "second.png", previewUrl: "https://example.test/second.png" },
        ],
        "second",
      ),
    ).toEqual({
      images: [
        { src: "https://example.test/first.png", name: "first.png" },
        { src: "https://example.test/second.png", name: "second.png" },
      ],
      index: 1,
    });
  });

  it("does not open a preview for an attachment whose asset URL is unavailable", () => {
    expect(
      buildExpandedImagePreview(
        [
          { id: "loading", name: "loading.png" },
          { id: "ready", name: "ready.png", previewUrl: "https://example.test/ready.png" },
        ],
        "loading",
      ),
    ).toBeNull();
  });
});
