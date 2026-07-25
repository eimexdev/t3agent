import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

const DATABASE_NAME = "t3-voice-drafts";
const STORE_NAME = "recordings";
const DRAFT_KEY = "active";
const WAVEFORM_BUCKETS = 64;
const LIVE_WAVEFORM_BUCKETS = 48;
const WAVEFORM_SAMPLE_INTERVAL_MS = 75;

export interface VoiceDraft {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly durationMs: number;
  readonly waveform: ReadonlyArray<number>;
  readonly previewUrl: string;
}

type VoiceRecorderState =
  | { readonly status: "idle" }
  | {
      readonly status: "recording";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly startedAt: number;
      readonly elapsedMs: number;
      readonly waveform: ReadonlyArray<number>;
      readonly paused: boolean;
    }
  | {
      readonly status: "draft";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly draft: VoiceDraft;
    };

interface VoiceRecorderStore {
  readonly recorder: VoiceRecorderState;
  readonly error: string | null;
  start: (environmentId: EnvironmentId, threadId: ThreadId, maxBytes: number) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<VoiceDraft | null>;
  discard: () => void;
  consumeDraft: () => void;
  clearError: () => void;
  restore: () => Promise<void>;
}

let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let chunks: Blob[] = [];
let timer: number | null = null;
let analyserFrame: number | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let waveformSamples: number[] = [];
let lastWaveformSampleAt = 0;
let pausedAt: number | null = null;
let pausedDurationMs = 0;

export function downsampleVoiceWaveform(
  samples: ReadonlyArray<number>,
  bucketCount = WAVEFORM_BUCKETS,
): ReadonlyArray<number> {
  if (samples.length <= bucketCount) return [...samples];
  return Array.from({ length: bucketCount }, (_, bucketIndex) => {
    const start = Math.floor((bucketIndex * samples.length) / bucketCount);
    const end = Math.max(start + 1, Math.floor(((bucketIndex + 1) * samples.length) / bucketCount));
    return Math.max(...samples.slice(start, end));
  });
}

export function rollingVoiceWaveform(
  samples: ReadonlyArray<number>,
  bucketCount = LIVE_WAVEFORM_BUCKETS,
): ReadonlyArray<number> {
  const visible = samples.slice(-bucketCount);
  return [
    ...Array.from({ length: Math.max(0, bucketCount - visible.length) }, () => 0.04),
    ...visible,
  ];
}

export function voiceLevelFromTimeDomain(samples: Uint8Array): number {
  if (samples.length === 0) return 0.04;
  let squaredTotal = 0;
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    squaredTotal += centered * centered;
  }
  const rms = Math.sqrt(squaredTotal / samples.length);
  return Math.max(0.04, Math.min(1, Math.sqrt(rms) * 1.8));
}

export function voiceRecordingElapsedMs(
  startedAt: number,
  now: number,
  pausedSince: number | null,
  completedPausedDurationMs: number,
): number {
  const currentPauseDuration = pausedSince === null ? 0 : Math.max(0, now - pausedSince);
  return Math.max(0, now - startedAt - completedPausedDurationMs - currentPauseDuration);
}

const WEBM_INFO_ID = [0x15, 0x49, 0xa9, 0x66] as const;
const WEBM_DURATION_ID = [0x44, 0x89] as const;
const WEBM_TIMESTAMP_SCALE_ID = [0x2a, 0xd7, 0xb1] as const;

interface EbmlVariableInteger {
  readonly value: number;
  readonly width: number;
  readonly unknown: boolean;
}

function findBytes(
  source: Uint8Array,
  search: ReadonlyArray<number>,
  from = 0,
  until = source.length,
): number {
  const finalStart = Math.min(source.length - search.length, until - search.length);
  for (let index = Math.max(0, from); index <= finalStart; index += 1) {
    if (search.every((byte, offset) => source[index + offset] === byte)) return index;
  }
  return -1;
}

function readEbmlVariableInteger(source: Uint8Array, offset: number): EbmlVariableInteger | null {
  const first = source[offset];
  if (first === undefined || first === 0) return null;
  let width = 1;
  let marker = 0x80;
  while (width <= 8 && (first & marker) === 0) {
    width += 1;
    marker >>= 1;
  }
  if (width > 8 || offset + width > source.length) return null;
  let value = first & (marker - 1);
  let unknown = value === marker - 1;
  for (let index = 1; index < width; index += 1) {
    const byte = source[offset + index]!;
    value = value * 256 + byte;
    unknown &&= byte === 0xff;
  }
  return { value, width, unknown };
}

function encodeEbmlVariableInteger(value: number, preferredWidth: number): Uint8Array | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  let width = Math.max(1, preferredWidth);
  while (width <= 8 && value > 2 ** (7 * width) - 2) width += 1;
  if (width > 8) return null;
  const encoded = new Uint8Array(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    encoded[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  encoded[0]! |= 1 << (8 - width);
  return encoded;
}

function readUnsignedInteger(source: Uint8Array, offset: number, length: number): number | null {
  if (length < 1 || length > 6 || offset + length > source.length) return null;
  let result = 0;
  for (let index = 0; index < length; index += 1) {
    result = result * 256 + source[offset + index]!;
  }
  return result;
}

/**
 * Chromium's MediaRecorder leaves Duration out of audio-only WebM metadata,
 * which makes the resulting Blob unseekable until it has played through once.
 * Its Segment has unknown length, so inserting Duration into the bounded Info
 * element is sufficient and does not require rewriting offsets in the media
 * clusters.
 */
export function patchMediaRecorderWebmDuration(
  source: Uint8Array<ArrayBufferLike>,
  durationMs: number,
): Uint8Array<ArrayBuffer> | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const infoOffset = findBytes(source, WEBM_INFO_ID, 0, Math.min(source.length, 16 * 1024));
  if (infoOffset < 0) return null;
  const infoSizeOffset = infoOffset + WEBM_INFO_ID.length;
  const infoSize = readEbmlVariableInteger(source, infoSizeOffset);
  if (!infoSize || infoSize.unknown) return null;
  const infoDataOffset = infoSizeOffset + infoSize.width;
  const infoEnd = infoDataOffset + infoSize.value;
  if (infoEnd > source.length) return null;
  if (findBytes(source, WEBM_DURATION_ID, infoDataOffset, infoEnd) >= 0) return null;

  const timestampScaleOffset = findBytes(source, WEBM_TIMESTAMP_SCALE_ID, infoDataOffset, infoEnd);
  let timestampScale = 1_000_000;
  if (timestampScaleOffset >= 0) {
    const valueSizeOffset = timestampScaleOffset + WEBM_TIMESTAMP_SCALE_ID.length;
    const valueSize = readEbmlVariableInteger(source, valueSizeOffset);
    if (valueSize && !valueSize.unknown) {
      timestampScale =
        readUnsignedInteger(source, valueSizeOffset + valueSize.width, valueSize.value) ??
        timestampScale;
    }
  }

  const durationInTimestampUnits = (durationMs * 1_000_000) / timestampScale;
  const durationElement = new Uint8Array(11);
  durationElement.set(WEBM_DURATION_ID, 0);
  durationElement[2] = 0x88;
  new DataView(durationElement.buffer).setFloat64(3, durationInTimestampUnits, false);
  const encodedInfoSize = encodeEbmlVariableInteger(
    infoSize.value + durationElement.length,
    infoSize.width,
  );
  if (!encodedInfoSize) return null;

  const output = new Uint8Array(
    source.length + durationElement.length + encodedInfoSize.length - infoSize.width,
  );
  output.set(source.subarray(0, infoSizeOffset), 0);
  output.set(encodedInfoSize, infoSizeOffset);
  const nextInfoDataOffset = infoSizeOffset + encodedInfoSize.length;
  output.set(durationElement, nextInfoDataOffset);
  output.set(source.subarray(infoDataOffset), nextInfoDataOffset + durationElement.length);
  return output;
}

export async function finalizeVoiceRecordingBlob(blob: Blob, durationMs: number): Promise<Blob> {
  if (!blob.type.toLowerCase().startsWith("audio/webm") || durationMs <= 0) return blob;
  try {
    const patched = patchMediaRecorderWebmDuration(
      new Uint8Array(await blob.arrayBuffer()),
      durationMs,
    );
    return patched ? new Blob([patched], { type: blob.type }) : blob;
  } catch {
    // Keep the original playable recording if a browser emits a WebM variant
    // that does not match MediaRecorder's bounded Info metadata.
    return blob;
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

async function persistDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draft: Omit<VoiceDraft, "previewUrl">;
}): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(input, DRAFT_KEY);
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
  database.close();
}

async function deletePersistedDraft(): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).delete(DRAFT_KEY);
  database.close();
}

function chooseMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function stopCaptureResources(): void {
  if (timer !== null) window.clearInterval(timer);
  if (analyserFrame !== null) window.cancelAnimationFrame(analyserFrame);
  timer = null;
  analyserFrame = null;
  analyser = null;
  void audioContext?.close();
  audioContext = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

export const useVoiceRecorderStore = create<VoiceRecorderStore>((set, get) => ({
  recorder: { status: "idle" },
  error: null,
  clearError: () => set({ error: null }),
  restore: async () => {
    if (get().recorder.status !== "idle") return;
    const database = await openDatabase();
    if (!database) return;
    const stored = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(DRAFT_KEY);
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    database.close();
    if (typeof stored !== "object" || stored === null) return;
    const value = stored as {
      environmentId?: unknown;
      threadId?: unknown;
      draft?: Partial<Omit<VoiceDraft, "previewUrl">>;
    };
    if (
      typeof value.environmentId !== "string" ||
      typeof value.threadId !== "string" ||
      !(value.draft?.blob instanceof Blob) ||
      typeof value.draft.mimeType !== "string" ||
      typeof value.draft.durationMs !== "number" ||
      !Array.isArray(value.draft.waveform)
    ) {
      return;
    }
    const restoredBlob = await finalizeVoiceRecordingBlob(value.draft.blob, value.draft.durationMs);
    set({
      recorder: {
        status: "draft",
        environmentId: value.environmentId as EnvironmentId,
        threadId: value.threadId as ThreadId,
        draft: {
          blob: restoredBlob,
          mimeType: restoredBlob.type || value.draft.mimeType,
          durationMs: value.draft.durationMs,
          waveform: value.draft.waveform.filter(
            (sample): sample is number => typeof sample === "number",
          ),
          previewUrl: URL.createObjectURL(restoredBlob),
        },
      },
    });
  },
  start: async (environmentId, threadId, maxBytes) => {
    if (get().recorder.status !== "idle") return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      set({ error: "Voice recording is not supported in this browser." });
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      waveformSamples = [];
      lastWaveformSampleAt = 0;
      pausedAt = null;
      pausedDurationMs = 0;
      const mimeType = chooseMimeType();
      mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
      const startedAt = Date.now();
      set({
        error: null,
        recorder: {
          status: "recording",
          environmentId,
          threadId,
          startedAt,
          elapsedMs: 0,
          waveform: [],
          paused: false,
        },
      });
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size === 0) return;
        chunks.push(event.data);
        const recordedBytes = chunks.reduce((total, chunk) => total + chunk.size, 0);
        if (recordedBytes >= maxBytes) {
          void get().stop();
        }
        const current = get().recorder;
        if (current.status !== "recording") return;
        const checkpoint = new Blob(chunks, { type: mediaRecorder?.mimeType || "audio/webm" });
        void persistDraft({
          environmentId: current.environmentId,
          threadId: current.threadId,
          draft: {
            blob: checkpoint,
            mimeType: checkpoint.type,
            durationMs: voiceRecordingElapsedMs(
              current.startedAt,
              Date.now(),
              pausedAt,
              pausedDurationMs,
            ),
            waveform: downsampleVoiceWaveform(waveformSamples),
          },
        });
      });
      mediaRecorder.start(1_000);
      timer = window.setInterval(() => {
        const current = get().recorder;
        if (current.status !== "recording") return;
        set({
          recorder: {
            ...current,
            elapsedMs: voiceRecordingElapsedMs(
              current.startedAt,
              Date.now(),
              pausedAt,
              pausedDurationMs,
            ),
          },
        });
      }, 250);

      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(mediaStream).connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const readLevel = () => {
        const current = get().recorder;
        if (current.status !== "recording" || !analyser) return;
        if (current.paused) {
          analyserFrame = window.requestAnimationFrame(readLevel);
          return;
        }
        const now = performance.now();
        if (now - lastWaveformSampleAt >= WAVEFORM_SAMPLE_INTERVAL_MS) {
          analyser.getByteTimeDomainData(samples);
          waveformSamples.push(voiceLevelFromTimeDomain(samples));
          lastWaveformSampleAt = now;
          set({
            recorder: {
              ...current,
              waveform: rollingVoiceWaveform(waveformSamples),
            },
          });
        }
        analyserFrame = window.requestAnimationFrame(readLevel);
      };
      readLevel();
    } catch {
      stopCaptureResources();
      mediaRecorder = null;
      set({ error: "Microphone access was denied or the microphone is unavailable." });
    }
  },
  pause: () => {
    const current = get().recorder;
    if (
      current.status !== "recording" ||
      current.paused ||
      !mediaRecorder ||
      mediaRecorder.state !== "recording"
    ) {
      return;
    }
    mediaRecorder.pause();
    pausedAt = Date.now();
    void audioContext?.suspend();
    set({ recorder: { ...current, paused: true } });
  },
  resume: () => {
    const current = get().recorder;
    if (
      current.status !== "recording" ||
      !current.paused ||
      !mediaRecorder ||
      mediaRecorder.state !== "paused"
    ) {
      return;
    }
    const resumedAt = Date.now();
    if (pausedAt !== null) pausedDurationMs += Math.max(0, resumedAt - pausedAt);
    pausedAt = null;
    mediaRecorder.resume();
    void audioContext?.resume();
    set({ recorder: { ...current, paused: false } });
  },
  stop: async () => {
    const current = get().recorder;
    if (current.status !== "recording" || !mediaRecorder) return null;
    const recorder = mediaRecorder;
    const completed = new Promise<void>((resolve) =>
      recorder.addEventListener("stop", () => resolve(), { once: true }),
    );
    recorder.stop();
    await completed;
    stopCaptureResources();
    mediaRecorder = null;
    const rawBlob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    chunks = [];
    const durationMs = voiceRecordingElapsedMs(
      current.startedAt,
      Date.now(),
      pausedAt,
      pausedDurationMs,
    );
    pausedAt = null;
    pausedDurationMs = 0;
    const blob = await finalizeVoiceRecordingBlob(rawBlob, durationMs);
    const completedWaveform = downsampleVoiceWaveform(waveformSamples);
    waveformSamples = [];
    if (blob.size === 0) {
      set({ recorder: { status: "idle" } });
      return null;
    }
    const persisted = {
      blob,
      mimeType: blob.type || "audio/webm",
      durationMs,
      waveform: completedWaveform,
    };
    const draft: VoiceDraft = { ...persisted, previewUrl: URL.createObjectURL(blob) };
    set({
      recorder: {
        status: "draft",
        environmentId: current.environmentId,
        threadId: current.threadId,
        draft,
      },
    });
    void persistDraft({
      environmentId: current.environmentId,
      threadId: current.threadId,
      draft: persisted,
    });
    return draft;
  },
  discard: () => {
    const current = get().recorder;
    if (current.status === "recording") {
      mediaRecorder?.stop();
      stopCaptureResources();
      mediaRecorder = null;
      chunks = [];
      pausedAt = null;
      pausedDurationMs = 0;
    } else if (current.status === "draft") {
      URL.revokeObjectURL(current.draft.previewUrl);
    }
    set({ recorder: { status: "idle" }, error: null });
    void deletePersistedDraft();
  },
  consumeDraft: () => {
    set({ recorder: { status: "idle" }, error: null });
    void deletePersistedDraft();
  },
}));

export function formatVoiceDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
