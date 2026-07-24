import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { describeThreadRenameFailure } from "./threadRenameFailure";

describe("describeThreadRenameFailure", () => {
  it("explains an interrupted Hermes rename instead of hiding it", () => {
    const message = describeThreadRenameFailure(AsyncResult.failure(Cause.interrupt()));

    expect(message).toEqual({
      title: "Thread rename interrupted",
      description: "The connection changed before Hermes confirmed the new title. Try again.",
    });
  });

  it("preserves an ordinary rename failure message", () => {
    const message = describeThreadRenameFailure(
      AsyncResult.failure(Cause.fail(new Error("Hermes rejected the title"))),
    );

    expect(message).toEqual({
      title: "Failed to rename thread",
      description: "Hermes rejected the title",
    });
  });
});
