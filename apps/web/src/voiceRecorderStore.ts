import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

const DATABASE_NAME = "t3-voice-drafts";
const STORE_NAME = "recordings";
const DRAFT_KEY = "active";
const WAVEFORM_BUCKETS = 64;

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
    set({
      recorder: {
        status: "draft",
        environmentId: value.environmentId as EnvironmentId,
        threadId: value.threadId as ThreadId,
        draft: {
          blob: value.draft.blob,
          mimeType: value.draft.mimeType,
          durationMs: value.draft.durationMs,
          waveform: value.draft.waveform.filter(
            (sample): sample is number => typeof sample === "number",
          ),
          previewUrl: URL.createObjectURL(value.draft.blob),
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
            durationMs: Date.now() - current.startedAt,
            waveform: current.waveform,
          },
        });
      });
      mediaRecorder.start(1_000);
      timer = window.setInterval(() => {
        const current = get().recorder;
        if (current.status !== "recording") return;
        set({ recorder: { ...current, elapsedMs: Date.now() - current.startedAt } });
      }, 250);

      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(mediaStream).connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const readLevel = () => {
        const current = get().recorder;
        if (current.status !== "recording" || !analyser) return;
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128) / 128);
        const waveform = [...current.waveform, Math.max(0.05, Math.min(1, peak))].slice(
          -WAVEFORM_BUCKETS,
        );
        set({ recorder: { ...current, waveform } });
        analyserFrame = window.requestAnimationFrame(readLevel);
      };
      readLevel();
    } catch {
      stopCaptureResources();
      mediaRecorder = null;
      set({ error: "Microphone access was denied or the microphone is unavailable." });
    }
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
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    chunks = [];
    if (blob.size === 0) {
      set({ recorder: { status: "idle" } });
      return null;
    }
    const persisted = {
      blob,
      mimeType: blob.type || "audio/webm",
      durationMs: Math.max(0, Date.now() - current.startedAt),
      waveform: current.waveform,
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
