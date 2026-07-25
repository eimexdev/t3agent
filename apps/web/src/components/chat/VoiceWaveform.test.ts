import { describe, expect, it } from "vite-plus/test";

import { keyboardSeekProgress, pointerSeekProgress, voiceSeekTargetSeconds } from "./VoiceWaveform";

describe("voice waveform seeking", () => {
  it("clamps pointer scrubbing to the waveform bounds", () => {
    expect(pointerSeekProgress(150, 100, 200)).toBe(0.25);
    expect(pointerSeekProgress(50, 100, 200)).toBe(0);
    expect(pointerSeekProgress(350, 100, 200)).toBe(1);
  });

  it("supports keyboard scrubbing without leaving the valid range", () => {
    expect(keyboardSeekProgress(0.5, "ArrowRight")).toBe(0.55);
    expect(keyboardSeekProgress(0.02, "ArrowLeft")).toBe(0);
    expect(keyboardSeekProgress(0.4, "Home")).toBe(0);
    expect(keyboardSeekProgress(0.4, "End")).toBe(1);
    expect(keyboardSeekProgress(0.4, "Enter")).toBeNull();
  });

  it("uses the recorded duration when WebM metadata has no finite duration", () => {
    expect(voiceSeekTargetSeconds(0.5, Number.NaN, 15_200)).toBe(7.6);
    expect(voiceSeekTargetSeconds(0.25, 20, 15_200)).toBe(5);
  });
});
