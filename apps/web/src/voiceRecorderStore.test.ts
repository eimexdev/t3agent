import { describe, expect, it } from "vite-plus/test";

import { downsampleVoiceWaveform, voiceLevelFromTimeDomain } from "./voiceRecorderStore";

describe("voice waveform capture", () => {
  it("retains peaks across the full recording when downsampling", () => {
    const samples = Array.from({ length: 128 }, (_, index) =>
      index === 8 || index === 104 ? 0.95 : 0.08,
    );
    const result = downsampleVoiceWaveform(samples, 16);

    expect(result).toHaveLength(16);
    expect(result.filter((sample) => sample === 0.95)).toHaveLength(2);
  });

  it("maps silence to a quiet floor and audible input above it", () => {
    expect(voiceLevelFromTimeDomain(new Uint8Array(32).fill(128))).toBe(0.04);
    expect(voiceLevelFromTimeDomain(new Uint8Array([96, 160, 96, 160]))).toBeGreaterThan(0.5);
  });
});
