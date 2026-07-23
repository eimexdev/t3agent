import {
  ApprovalRequestId,
  EventId,
  type HermesBridgeApprovalRequest,
  HermesBridgeChatId,
  type HermesBridgeChoice,
  type HermesBridgeClarificationRequest,
  type HermesBridgeHermesToT3Request,
  HermesBridgeHermesToT3Request as HermesBridgeHermesToT3RequestSchema,
  type HermesBridgeImageAttachment,
  HermesBridgeImageAttachmentId,
  HermesBridgeRequestId,
  HermesBridgeSessionKey,
  HermesBridgeThreadId,
  HERMES_BRIDGE_PROTOCOL_VERSION,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as NodeBuffer from "node:buffer";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { parseBase64DataUrl } from "../../imageMime.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { HermesBridgeClient } from "../hermes/HermesBridgeClient.ts";

const PROVIDER = ProviderDriverKind.make("hermes");
const RESUME_SCHEMA_VERSION = 1 as const;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const INTERACTIVE_REQUEST_PREFIX = "hermes:v1:";
const USER_MESSAGE_TURN_PREFIX = "hermes-user:";
const decodeCallback = Schema.decodeUnknownEffect(HermesBridgeHermesToT3RequestSchema);

interface PendingApproval {
  readonly kind: "approval";
  readonly sessionKey: HermesBridgeSessionKey;
  readonly approvalId: string;
  readonly providerRequestId: string;
  readonly choices: ReadonlyArray<HermesBridgeChoice>;
}

interface PendingClarification {
  readonly kind: "clarification";
  readonly sessionKey: HermesBridgeSessionKey;
  readonly clarifyId: string;
  readonly providerRequestId: string;
}

interface PendingConfirmation {
  readonly kind: "confirmation";
  readonly sessionKey: HermesBridgeSessionKey;
  readonly confirmId: string;
  readonly choices: ReadonlyArray<HermesBridgeChoice>;
}

type PendingRequest = PendingApproval | PendingClarification | PendingConfirmation;

function interactiveRequestId(pending: PendingRequest): ApprovalRequestId {
  return ApprovalRequestId.make(
    `${INTERACTIVE_REQUEST_PREFIX}${NodeBuffer.Buffer.from(JSON.stringify(pending), "utf8").toString("base64url")}`,
  );
}

function parseInteractiveRequestId(requestId: string): PendingRequest | undefined {
  if (!requestId.startsWith(INTERACTIVE_REQUEST_PREFIX)) return undefined;
  try {
    const decoded: unknown = JSON.parse(
      NodeBuffer.Buffer.from(
        requestId.slice(INTERACTIVE_REQUEST_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    );
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
    const value = decoded as Record<string, unknown>;
    if (typeof value.sessionKey !== "string") return undefined;
    if (value.kind === "clarification") {
      if (typeof value.clarifyId !== "string" || typeof value.providerRequestId !== "string") {
        return undefined;
      }
      return {
        kind: "clarification",
        sessionKey: HermesBridgeSessionKey.make(value.sessionKey),
        clarifyId: value.clarifyId,
        providerRequestId: value.providerRequestId,
      };
    }
    if (value.kind !== "approval" && value.kind !== "confirmation") return undefined;
    if (!Array.isArray(value.choices)) return undefined;
    const choices = value.choices.flatMap((choice): Array<HermesBridgeChoice> => {
      if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return [];
      const record = choice as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.label !== "string") return [];
      return [
        {
          id: record.id,
          label: record.label,
          ...(typeof record.description === "string" ? { description: record.description } : {}),
        },
      ];
    });
    if (choices.length !== value.choices.length) return undefined;
    if (value.kind === "approval") {
      if (typeof value.approvalId !== "string" || typeof value.providerRequestId !== "string") {
        return undefined;
      }
      return {
        kind: "approval",
        sessionKey: HermesBridgeSessionKey.make(value.sessionKey),
        approvalId: value.approvalId,
        providerRequestId: value.providerRequestId,
        choices,
      };
    }
    if (typeof value.confirmId !== "string") return undefined;
    return {
      kind: "confirmation",
      sessionKey: HermesBridgeSessionKey.make(value.sessionKey),
      confirmId: value.confirmId,
      choices,
    };
  } catch {
    return undefined;
  }
}

interface HermesMessageState {
  readonly text: string;
  readonly itemId: RuntimeItemId;
  readonly completed: boolean;
}

interface HermesSessionContext {
  session: ProviderSession;
  sessionKey?: HermesBridgeSessionKey;
  activeTurnId: TurnId | undefined;
  readonly activeTurnIds: Array<TurnId>;
  readonly messages: Map<string, HermesMessageState>;
  readonly pendingRequests: Map<string, PendingRequest>;
  readonly seenDeliveries: Set<string>;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
}

interface HermesResumeCursor {
  readonly schemaVersion: typeof RESUME_SCHEMA_VERSION;
  readonly chatId: string;
  readonly threadId: string;
  readonly sessionKey?: string;
}

function parseResumeCursor(value: unknown): HermesResumeCursor | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== RESUME_SCHEMA_VERSION ||
    typeof record.chatId !== "string" ||
    typeof record.threadId !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: RESUME_SCHEMA_VERSION,
    chatId: record.chatId,
    threadId: record.threadId,
    ...(typeof record.sessionKey === "string" ? { sessionKey: record.sessionKey } : {}),
  };
}

function resumeCursor(context: HermesSessionContext): HermesResumeCursor {
  return {
    schemaVersion: RESUME_SCHEMA_VERSION,
    chatId: "t3agent",
    threadId: context.session.threadId,
    ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
  };
}

function destinationThreadId(callback: HermesBridgeHermesToT3Request): ThreadId | undefined {
  if ("threadId" in callback && typeof callback.threadId === "string" && callback.threadId) {
    return ThreadId.make(callback.threadId);
  }
  if (
    "chatId" in callback &&
    typeof callback.chatId === "string" &&
    callback.chatId &&
    callback.chatId !== "t3agent"
  ) {
    return ThreadId.make(callback.chatId);
  }
  return undefined;
}

function sourceTurnId(sourceMessageId: string): TurnId | undefined {
  if (!sourceMessageId.startsWith(USER_MESSAGE_TURN_PREFIX)) return undefined;
  const value = sourceMessageId.slice(USER_MESSAGE_TURN_PREFIX.length);
  return value ? TurnId.make(value) : undefined;
}

function textDelta(previous: string, next: string): string {
  if (next.startsWith(previous)) return next.slice(previous.length);
  return "";
}

function firstAnswer(answers: ProviderUserInputAnswers): unknown {
  return Object.values(answers)[0] ?? "";
}

function answerText(answer: unknown): string {
  if (typeof answer === "string") return answer;
  if (Array.isArray(answer)) return answer.map(String).join(", ");
  if (answer === null || answer === undefined) return "";
  return String(answer);
}

function approvalChoice(
  decision: ProviderApprovalDecision,
  choices: ReadonlyArray<HermesBridgeChoice>,
): string | undefined {
  const allowed = new Set(choices.map((choice) => choice.id));
  switch (decision) {
    case "accept":
      return allowed.has("once") ? "once" : choices.find((choice) => choice.id !== "deny")?.id;
    case "acceptForSession":
      return allowed.has("session")
        ? "session"
        : allowed.has("always")
          ? "always"
          : allowed.has("once")
            ? "once"
            : undefined;
    case "decline":
    case "cancel":
      return allowed.has("deny") ? "deny" : undefined;
  }
}

function selectedChoice(
  answer: unknown,
  choices: ReadonlyArray<HermesBridgeChoice>,
): HermesBridgeChoice | undefined {
  const text = answerText(answer).trim();
  return choices.find((choice) => choice.id === text || choice.label === text);
}

function confirmationChoice(decision: ProviderApprovalDecision): "once" | "always" | "cancel" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
      return "cancel";
  }
}

export interface HermesAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly client: HermesBridgeClient;
}

export interface HermesAdapter extends ProviderAdapterShape<ProviderAdapterError> {
  readonly receiveCallback: (payload: unknown) => Effect.Effect<unknown, ProviderAdapterError>;
}

export const makeHermesAdapter = Effect.fn("makeHermesAdapter")(function* (
  options: HermesAdapterOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const callbackSemaphore = yield* Semaphore.make(1);
  const sessions = new Map<ThreadId, HermesSessionContext>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);
  const eventBase = (callback: HermesBridgeHermesToT3Request, threadId: ThreadId, suffix: string) =>
    nowIso.pipe(
      Effect.map((createdAt) => {
        const correlatedTurnId =
          "sourceMessageId" in callback && typeof callback.sourceMessageId === "string"
            ? sourceTurnId(callback.sourceMessageId)
            : undefined;
        const turnId = correlatedTurnId;
        return {
          eventId: EventId.make(`hermes:${callback.deliveryId}:${suffix}`),
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId,
          createdAt,
          ...(turnId ? { turnId } : {}),
        };
      }),
    );

  const requestError = (method: string, detail: string, cause?: unknown) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail,
      ...(cause ? { cause } : {}),
    });

  const persistImage = Effect.fn("HermesAdapter.persistImage")(function* (
    threadId: ThreadId,
    image: HermesBridgeImageAttachment,
  ) {
    let bytes: Uint8Array;
    if (image.source.type === "data-url") {
      const parsed = parseBase64DataUrl(image.source.dataUrl);
      if (!parsed || !parsed.mimeType.startsWith("image/")) {
        return yield* requestError("image.persist", `Invalid image payload for ${image.name}.`);
      }
      bytes = Buffer.from(parsed.base64, "base64");
    } else {
      return yield* requestError(
        "image.persist",
        "Only byte-backed data URL images are accepted from Hermes callbacks.",
      );
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      return yield* requestError("image.persist", `Image ${image.name} is empty or too large.`);
    }
    const id = createAttachmentId(threadId);
    if (!id) return yield* requestError("image.persist", "Unable to create attachment id.");
    const attachment: ChatAttachment = {
      type: "image",
      id,
      name: image.name,
      mimeType: image.mimeType.toLowerCase(),
      sizeBytes: bytes.byteLength,
    };
    const target = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!target) return yield* requestError("image.persist", "Unsafe attachment path.");
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFile(target, bytes)),
      Effect.mapError((cause) =>
        requestError("image.persist", `Unable to store ${image.name}.`, cause),
      ),
    );
    return attachment;
  });

  const persistImages = (
    threadId: ThreadId,
    images: ReadonlyArray<HermesBridgeImageAttachment> | undefined,
  ): Effect.Effect<ReadonlyArray<ChatAttachment>, ProviderAdapterRequestError> =>
    Effect.forEach(images ?? [], (image) => persistImage(threadId, image), { concurrency: 1 });

  const ensureContext = Effect.fn("HermesAdapter.ensureContext")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<HermesSessionContext> {
    const existing = sessions.get(threadId);
    if (existing) return existing;
    const createdAt = yield* nowIso;
    const session: ProviderSession = {
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      status: "ready",
      runtimeMode: "full-access",
      threadId,
      createdAt,
      updatedAt: createdAt,
    };
    const context: HermesSessionContext = {
      session,
      activeTurnId: undefined,
      activeTurnIds: [],
      messages: new Map(),
      pendingRequests: new Map(),
      seenDeliveries: new Set(),
      turns: [],
    };
    sessions.set(threadId, context);
    return context;
  });

  const handleMessageCallback = Effect.fn("HermesAdapter.handleMessageCallback")(function* (
    callback: Extract<HermesBridgeHermesToT3Request, { type: "message.send" | "message.edit" }>,
    threadId: ThreadId,
    context: HermesSessionContext,
  ) {
    const previous = context.messages.get(callback.messageId);
    if (previous?.completed) return;
    const itemId = previous?.itemId ?? RuntimeItemId.make(`hermes-message:${callback.messageId}`);
    const delta = textDelta(previous?.text ?? "", callback.content);
    if (delta.length > 0) {
      const base = yield* eventBase(callback, threadId, "content");
      yield* publish({
        ...base,
        type: "content.delta",
        itemId,
        payload: { streamKind: "assistant_text", delta },
      });
    }
    const attachments = callback.final
      ? yield* persistImages(threadId, callback.images)
      : ([] as ReadonlyArray<ChatAttachment>);
    context.messages.set(callback.messageId, {
      text: callback.content,
      itemId,
      completed: callback.final,
    });
    if (!callback.final) return;
    const base = yield* eventBase(callback, threadId, "complete");
    yield* publish({
      ...base,
      type: "item.completed",
      itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        ...(callback.content.trim() ? { detail: callback.content } : {}),
        data: {
          finalText: callback.content,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      },
    });
  });

  const rememberApproval = Effect.fn("HermesAdapter.rememberApproval")(function* (
    callback: HermesBridgeApprovalRequest,
    threadId: ThreadId,
    context: HermesSessionContext,
  ) {
    context.sessionKey = callback.sessionKey;
    const pending: PendingApproval = {
      kind: "approval",
      sessionKey: callback.sessionKey,
      approvalId: callback.approvalId,
      providerRequestId: callback.providerRequestId,
      choices: callback.choices,
    };
    const requestId = RuntimeRequestId.make(interactiveRequestId(pending));
    context.pendingRequests.set(requestId, pending);
    const base = yield* eventBase(callback, threadId, "approval");
    yield* publish({
      ...base,
      type: "user-input.requested",
      requestId,
      payload: {
        questions: [
          {
            id: callback.approvalId,
            header: callback.title ?? "Hermes approval",
            question: callback.message,
            options: callback.choices.map((choice) => ({
              label: choice.label,
              description: choice.description ?? choice.label,
            })),
            multiSelect: false,
          },
        ],
      },
    });
  });

  const rememberClarification = Effect.fn("HermesAdapter.rememberClarification")(function* (
    callback: HermesBridgeClarificationRequest,
    threadId: ThreadId,
    context: HermesSessionContext,
  ) {
    context.sessionKey = callback.sessionKey;
    const pending: PendingClarification = {
      kind: "clarification",
      sessionKey: callback.sessionKey,
      clarifyId: callback.clarifyId,
      providerRequestId: callback.providerRequestId,
    };
    const requestId = RuntimeRequestId.make(interactiveRequestId(pending));
    context.pendingRequests.set(requestId, pending);
    const base = yield* eventBase(callback, threadId, "clarification");
    yield* publish({
      ...base,
      type: "user-input.requested",
      requestId,
      payload: {
        questions: [
          {
            id: callback.clarifyId,
            header: "Hermes needs input",
            question: callback.question,
            options: callback.choices.map((choice) => ({
              label: choice.label,
              description: choice.description ?? choice.label,
            })),
            multiSelect: false,
          },
        ],
      },
    });
  });

  const receiveCallback = (payload: unknown) =>
    callbackSemaphore.withPermits(1)(
      decodeCallback(payload).pipe(
        Effect.mapError((cause) =>
          requestError("callback.decode", "Invalid Hermes callback payload.", cause),
        ),
        Effect.flatMap(
          Effect.fn("HermesAdapter.processCallback")(function* (callback) {
            if (callback.type === "thread.create") {
              return callback;
            }
            const threadId = destinationThreadId(callback);
            if (!threadId) {
              return yield* requestError(
                "callback.route",
                `Callback ${callback.type} did not identify a T3 Agent thread.`,
              );
            }
            const context = yield* ensureContext(threadId);
            if (context.seenDeliveries.has(callback.deliveryId)) {
              return { status: "duplicate", deliveryId: callback.deliveryId };
            }
            switch (callback.type) {
              case "message.send":
              case "message.edit":
                yield* handleMessageCallback(callback, threadId, context);
                break;
              case "message.delete":
                return yield* requestError(
                  "callback.message.delete",
                  "T3 Agent does not support deleting a projected Hermes message.",
                );
              case "typing.set": {
                const base = yield* eventBase(callback, threadId, "typing");
                yield* publish({
                  ...base,
                  type: "session.state.changed",
                  payload: { state: callback.active ? "running" : "ready" },
                });
                break;
              }
              case "turn.complete": {
                const completedTurnId = sourceTurnId(callback.sourceMessageId);
                if (!completedTurnId) {
                  return yield* requestError(
                    "callback.turn.complete",
                    `Turn completion source ${callback.sourceMessageId} is not a T3 Agent turn.`,
                  );
                }
                if (callback.outcome === "cancelled") {
                  const base = yield* eventBase(callback, threadId, "turn-aborted");
                  yield* publish({
                    ...base,
                    type: "turn.aborted",
                    turnId: completedTurnId,
                    payload: { reason: "Hermes turn was cancelled" },
                  });
                } else {
                  const base = yield* eventBase(callback, threadId, "turn-completed");
                  yield* publish({
                    ...base,
                    type: "turn.completed",
                    turnId: completedTurnId,
                    payload:
                      callback.outcome === "success"
                        ? { state: "completed" }
                        : { state: "failed", errorMessage: "Hermes turn failed" },
                  });
                }
                const completedIndex = context.activeTurnIds.indexOf(completedTurnId);
                if (completedIndex >= 0) context.activeTurnIds.splice(completedIndex, 1);
                const remainingTurnId = context.activeTurnIds.at(-1);
                const updatedAt = yield* nowIso;
                context.activeTurnId = remainingTurnId;
                const { activeTurnId: _activeTurnId, ...settledSession } = context.session;
                context.session = {
                  ...settledSession,
                  status: remainingTurnId
                    ? "running"
                    : callback.outcome === "failure"
                      ? "error"
                      : "ready",
                  ...(remainingTurnId ? { activeTurnId: remainingTurnId } : {}),
                  updatedAt,
                  resumeCursor: resumeCursor(context),
                };
                break;
              }
              case "approval.request":
                yield* rememberApproval(callback, threadId, context);
                break;
              case "clarification.request":
                yield* rememberClarification(callback, threadId, context);
                break;
              case "slash-confirmation.request": {
                context.sessionKey = callback.sessionKey;
                const pending: PendingConfirmation = {
                  kind: "confirmation",
                  sessionKey: callback.sessionKey,
                  confirmId: callback.confirmId,
                  choices: [
                    { id: "once", label: "Run once" },
                    { id: "always", label: "Always allow" },
                    { id: "cancel", label: "Cancel" },
                  ],
                };
                const requestId = RuntimeRequestId.make(interactiveRequestId(pending));
                context.pendingRequests.set(requestId, pending);
                const base = yield* eventBase(callback, threadId, "confirmation");
                yield* publish({
                  ...base,
                  type: "user-input.requested",
                  requestId,
                  payload: {
                    questions: [
                      {
                        id: callback.confirmId,
                        header: callback.title,
                        question: callback.message,
                        options: [
                          { label: "Run once", description: "Run this command once." },
                          { label: "Always allow", description: "Remember this command." },
                          { label: "Cancel", description: "Do not run this command." },
                        ],
                        multiSelect: false,
                      },
                    ],
                  },
                });
                break;
              }
            }
            context.seenDeliveries.add(callback.deliveryId);
            return { status: "accepted", deliveryId: callback.deliveryId };
          }),
        ),
      ),
    );

  const getContext = (
    threadId: ThreadId,
  ): Effect.Effect<HermesSessionContext, ProviderAdapterError> =>
    Effect.suspend(() => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }).pipe(
      Effect.filterOrFail(
        (context) => context.session.status !== "closed",
        () => new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }),
      ),
    );

  const startSession = Effect.fn("HermesAdapter.startSession")(function* (
    input: ProviderSessionStartInput,
  ) {
    const existing = sessions.get(input.threadId);
    const createdAt = existing?.session.createdAt ?? (yield* nowIso);
    const updatedAt = yield* nowIso;
    const parsedResume = parseResumeCursor(input.resumeCursor);
    const context: HermesSessionContext = existing ?? {
      session: {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        createdAt,
        updatedAt,
      },
      messages: new Map(),
      activeTurnId: undefined,
      activeTurnIds: [],
      pendingRequests: new Map(),
      seenDeliveries: new Set(),
      turns: [],
    };
    if (parsedResume?.sessionKey) {
      context.sessionKey = HermesBridgeSessionKey.make(parsedResume.sessionKey);
    }
    context.session = {
      ...context.session,
      status: "ready",
      runtimeMode: input.runtimeMode,
      cwd: undefined,
      updatedAt,
      resumeCursor: resumeCursor(context),
    };
    sessions.set(input.threadId, context);
    return context.session;
  });

  const sendTurn = Effect.fn("HermesAdapter.sendTurn")(function* (input: ProviderSendTurnInput) {
    const context = yield* getContext(input.threadId);
    const uuid = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        requestError("crypto/randomUUIDv4", "Unable to create a turn id.", cause),
      ),
    );
    const turnId = TurnId.make(`hermes-${uuid}`);
    const createdAt = yield* nowIso;
    context.activeTurnId = turnId;
    context.activeTurnIds.push(turnId);
    context.turns.push({ id: turnId, items: [] });
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: createdAt,
    };
    const images = yield* Effect.forEach(input.attachments ?? [], (attachment) => {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Unable to resolve attachment ${attachment.name}.`,
          }),
        );
      }
      return Effect.succeed({
        type: "image" as const,
        id: HermesBridgeImageAttachmentId.make(attachment.id),
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        source: { type: "local-path" as const, path: attachmentPath },
      });
    });
    yield* publish({
      eventId: EventId.make(`hermes:${turnId}:started`),
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId: input.threadId,
      createdAt,
      turnId,
      type: "turn.started",
      payload: {},
    });
    const requestId = HermesBridgeRequestId.make(`turn:${turnId}`);
    yield* options.client
      .send({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId,
        type: "message.submit",
        messageId: MessageId.make(`hermes-user:${turnId}`),
        chatId: HermesBridgeChatId.make("t3agent"),
        threadId: HermesBridgeThreadId.make(input.threadId),
        user: { id: "owner", name: "Owner" },
        content: input.input ?? "",
        ...(images.length > 0 ? { images } : {}),
      })
      .pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            const failedIndex = context.activeTurnIds.indexOf(turnId);
            if (failedIndex >= 0) context.activeTurnIds.splice(failedIndex, 1);
            const remainingTurnId = context.activeTurnIds.at(-1);
            context.activeTurnId = remainingTurnId;
            const { activeTurnId: _activeTurnId, ...failedSession } = context.session;
            context.session = {
              ...failedSession,
              status: remainingTurnId ? "running" : "error",
              ...(remainingTurnId ? { activeTurnId: remainingTurnId } : {}),
            };
          }),
        ),
      );
    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: resumeCursor(context),
    } satisfies ProviderTurnStartResult;
  });

  const interruptTurn = Effect.fn("HermesAdapter.interruptTurn")(function* (threadId: ThreadId) {
    const context = yield* getContext(threadId);
    yield* options.client.send({
      protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
      requestId: HermesBridgeRequestId.make(
        `interrupt:${threadId}:${context.activeTurnId ?? "session"}`,
      ),
      type: "turn.interrupt",
      ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
      chatId: HermesBridgeChatId.make("t3agent"),
      threadId: HermesBridgeThreadId.make(threadId),
    });
    const activeTurnIds = [...context.activeTurnIds];
    for (const activeTurnId of activeTurnIds) {
      const createdAt = yield* nowIso;
      yield* publish({
        eventId: EventId.make(`hermes:${activeTurnId}:interrupted`),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId,
        turnId: activeTurnId,
        createdAt,
        type: "turn.aborted",
        payload: { reason: "Interrupted by user" },
      });
    }
    context.activeTurnId = undefined;
    context.activeTurnIds.length = 0;
    const { activeTurnId: _activeTurnId, ...readySession } = context.session;
    context.session = {
      ...readySession,
      status: "ready",
      updatedAt: yield* nowIso,
    };
  });

  const respondToRequest = Effect.fn("HermesAdapter.respondToRequest")(function* (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) {
    const context = yield* ensureContext(threadId);
    const pending = context.pendingRequests.get(requestId) ?? parseInteractiveRequestId(requestId);
    if (!pending || pending.kind === "clarification") {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToRequest",
        issue: `Unknown Hermes approval request ${requestId}.`,
      });
    }
    if (pending.kind === "approval") {
      const choice = approvalChoice(decision, pending.choices);
      if (!choice) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: `Hermes approval ${requestId} does not offer that decision.`,
        });
      }
      yield* options.client.send({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: HermesBridgeRequestId.make(`approval-response:${requestId}`),
        type: "approval.respond",
        sessionKey: pending.sessionKey,
        approvalId: pending.approvalId as never,
        providerRequestId: pending.providerRequestId as never,
        choice,
      });
    } else {
      yield* options.client.send({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: HermesBridgeRequestId.make(`confirmation-response:${requestId}`),
        type: "slash-confirmation.respond",
        sessionKey: pending.sessionKey,
        confirmId: pending.confirmId as never,
        choice: confirmationChoice(decision),
      });
    }
    context.pendingRequests.delete(requestId);
  });

  const respondToUserInput = Effect.fn("HermesAdapter.respondToUserInput")(function* (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) {
    const context = yield* ensureContext(threadId);
    const pending = context.pendingRequests.get(requestId) ?? parseInteractiveRequestId(requestId);
    if (!pending) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToUserInput",
        issue: `Unknown Hermes interactive request ${requestId}.`,
      });
    }
    const answer = firstAnswer(answers);
    if (pending.kind === "clarification") {
      yield* options.client.send({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: HermesBridgeRequestId.make(`clarification-response:${requestId}`),
        type: "clarification.respond",
        sessionKey: pending.sessionKey,
        clarifyId: pending.clarifyId as never,
        providerRequestId: pending.providerRequestId as never,
        response: answerText(answer),
      });
    } else {
      const choice = selectedChoice(answer, pending.choices);
      if (!choice) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: `Hermes request ${requestId} does not offer ${answerText(answer)}.`,
        });
      }
      if (pending.kind === "approval") {
        yield* options.client.send({
          protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
          requestId: HermesBridgeRequestId.make(`approval-response:${requestId}`),
          type: "approval.respond",
          sessionKey: pending.sessionKey,
          approvalId: pending.approvalId as never,
          providerRequestId: pending.providerRequestId as never,
          choice: choice.id,
        });
      } else {
        yield* options.client.send({
          protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
          requestId: HermesBridgeRequestId.make(`confirmation-response:${requestId}`),
          type: "slash-confirmation.respond",
          sessionKey: pending.sessionKey,
          confirmId: pending.confirmId as never,
          choice: choice.id as "once" | "always" | "cancel",
        });
      }
    }
    context.pendingRequests.delete(requestId);
  });

  const stopSession = (threadId: ThreadId) =>
    interruptTurn(threadId).pipe(
      Effect.catchTag("ProviderAdapterSessionNotFoundError", () => Effect.void),
      Effect.andThen(
        Effect.sync(() => {
          const context = sessions.get(threadId);
          if (context) context.session = { ...context.session, status: "closed" };
        }),
      ),
    );

  const adapter: HermesAdapter = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () => Effect.succeed([...sessions.values()].map(({ session }) => session)),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) =>
      getContext(threadId).pipe(
        Effect.map((context): ProviderThreadSnapshot => ({ threadId, turns: [...context.turns] })),
      ),
    rollbackThread: (threadId) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: `Hermes conversation rollback is not supported for ${threadId}; use a Hermes slash command.`,
        }),
      ),
    stopAll: () => Effect.forEach([...sessions.keys()], stopSession, { discard: true }),
    streamEvents: Stream.fromPubSub(events),
    receiveCallback,
  };

  return adapter;
});
