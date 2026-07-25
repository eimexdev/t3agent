import { describe, expect, it } from "vite-plus/test";

import {
  downsampleVoiceWaveform,
  finalizeVoiceRecordingBlob,
  patchMediaRecorderWebmDuration,
  rollingVoiceWaveform,
  voiceLevelFromTimeDomain,
  voiceRecordingElapsedMs,
} from "./voiceRecorderStore";

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

  it("renders live capture as a fixed-density rolling window", () => {
    const samples = Array.from({ length: 80 }, (_, index) => index / 100);
    const result = rollingVoiceWaveform(samples, 48);

    expect(result).toHaveLength(48);
    expect(result[0]).toBe(0.32);
    expect(result.at(-1)).toBe(0.79);
  });

  it("left-pads a short live capture instead of changing its visual density", () => {
    const result = rollingVoiceWaveform([0.4, 0.8], 5);

    expect(result).toEqual([0.04, 0.04, 0.04, 0.4, 0.8]);
  });

  it("excludes completed and active pauses from the recording duration", () => {
    expect(voiceRecordingElapsedMs(1_000, 10_000, null, 2_000)).toBe(7_000);
    expect(voiceRecordingElapsedMs(1_000, 10_000, 8_000, 2_000)).toBe(5_000);
  });
});

describe("voice recording finalization", () => {
  const webmWithoutDuration = () =>
    new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f,
      0x42, 0x40, 0x1f, 0x43, 0xb6, 0x75,
    ]);

  it("adds duration metadata to WebM recordings before they become drafts", async () => {
    const source = new Blob([webmWithoutDuration()], {
      type: "audio/webm;codecs=opus",
    });
    const result = await finalizeVoiceRecordingBlob(source, 12_345);
    const bytes = new Uint8Array(await result.arrayBuffer());
    const durationOffset = bytes.findIndex(
      (byte, index) => byte === 0x44 && bytes[index + 1] === 0x89,
    );

    expect(result).not.toBe(source);
    expect(bytes[9]).toBe(0x92);
    expect(durationOffset).toBe(10);
    expect(new DataView(bytes.buffer).getFloat64(durationOffset + 3, false)).toBe(12_345);
  });

  it("leaves non-WebM recordings unchanged", async () => {
    const source = new Blob(["source"], { type: "audio/mp4" });

    expect(await finalizeVoiceRecordingBlob(source, 12_345)).toBe(source);
  });

  it("keeps the original playable WebM if its metadata is not recognized", async () => {
    const source = new Blob(["not a WebM"], { type: "audio/webm" });

    expect(await finalizeVoiceRecordingBlob(source, 12_345)).toBe(source);
  });

  it("does not duplicate existing duration metadata", () => {
    const source = webmWithoutDuration();
    const first = patchMediaRecorderWebmDuration(source, 12_345);

    expect(first).not.toBeNull();
    expect(patchMediaRecorderWebmDuration(first!, 12_345)).toBeNull();
  });
});
