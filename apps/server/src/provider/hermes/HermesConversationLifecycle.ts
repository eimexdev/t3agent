import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  HERMES_BRIDGE_PROTOCOL_VERSION,
  HermesBridgeRequestId,
  HermesBridgeSessionId,
  HermesLineageMetadata,
  HermesLifecycleError,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type HermesBridgeSessionListResponse,
  type HermesConversationForkInput,
  type HermesConversationForkResult,
  type HermesConversationRenameInput,
  type HermesConversationRenameResult,
  type OrchestrationCommand,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { HermesBridgeClient } from "./HermesBridgeClient.ts";
import { encodeHermesModelSlug } from "./HermesModel.ts";

const HERMES_INSTANCE_ID = ProviderInstanceId.make("hermes");
const isHermesLifecycleError = Schema.is(HermesLifecycleError);
const encodeLineage = Schema.encodeEffect(Schema.fromJsonString(HermesLineageMetadata));

interface LifecycleSnapshot {
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly deletedAt: string | null;
  }>;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly title?: string;
    readonly deletedAt: string | null;
  }>;
}

interface LifecycleProvider {
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
}

export interface HermesConversationLifecycleDependencies {
  readonly getClient: () => Effect.Effect<
    Pick<
      HermesBridgeClient,
      "listSessions" | "forkSession" | "deleteSession" | "updateSessionTitle"
    >,
    Error
  >;
  readonly getSnapshot: () => Effect.Effect<LifecycleSnapshot, Error>;
  readonly getProviders: Effect.Effect<ReadonlyArray<LifecycleProvider>, Error>;
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, Error>;
  readonly randomUuid: Effect.Effect<string, Error>;
  readonly nowIso: Effect.Effect<string, Error>;
}

export interface HermesConversationLifecycle {
  readonly listSessions: Effect.Effect<HermesBridgeSessionListResponse, HermesLifecycleError>;
  readonly forkConversation: (
    input: HermesConversationForkInput,
  ) => Effect.Effect<HermesConversationForkResult, HermesLifecycleError>;
  readonly renameConversation: (
    input: HermesConversationRenameInput,
  ) => Effect.Effect<HermesConversationRenameResult, HermesLifecycleError>;
  readonly reconcileTitles: Effect.Effect<void, HermesLifecycleError>;
}

type LifecycleOperation = HermesLifecycleError["operation"];

interface LifecycleErrorContext {
  readonly sourceSessionId?: HermesLifecycleError["sourceSessionId"];
  readonly sourceThreadId?: HermesLifecycleError["sourceThreadId"];
}

function sourceContext(input: HermesConversationForkInput): LifecycleErrorContext {
  return input.source.type === "session"
    ? { sourceSessionId: input.source.sessionId }
    : { sourceThreadId: input.source.threadId };
}

function lifecycleError(
  operation: LifecycleOperation,
  cause: unknown,
  fallback: string,
  context: LifecycleErrorContext = {},
): HermesLifecycleError {
  if (isHermesLifecycleError(cause)) {
    return cause;
  }
  const detail =
    cause instanceof Error && cause.message.trim().length > 0 ? cause.message.trim() : undefined;
  return new HermesLifecycleError({
    operation,
    message: detail ?? fallback,
    ...(detail !== undefined ? { detail } : {}),
    ...context,
  });
}

export function makeHermesConversationLifecycle(
  dependencies: HermesConversationLifecycleDependencies,
): HermesConversationLifecycle {
  const forkLock = Semaphore.makeUnsafe(1);
  const renameLock = Semaphore.makeUnsafe(1);
  const nextCommandId = Effect.fn("HermesConversationLifecycle.nextCommandId")(function* (
    tag: string,
  ) {
    const uuid = yield* dependencies.randomUuid;
    return CommandId.make(`server:${tag}:${uuid}`);
  });

  const deleteThread = Effect.fn("HermesConversationLifecycle.deleteThread")(function* (
    threadId: ThreadId,
  ) {
    yield* dependencies
      .dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`server:hermes-conversation-fork-cleanup:${threadId}`),
        threadId,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const reconcileTitleProjection = Effect.fn(
    "HermesConversationLifecycle.reconcileTitleProjection",
  )(function* (sessions: HermesBridgeSessionListResponse, snapshot: LifecycleSnapshot) {
    const liveThreads = new Map(
      snapshot.threads
        .filter((thread) => thread.deletedAt === null)
        .map((thread) => [thread.id, thread] as const),
    );
    yield* Effect.forEach(
      sessions.sessions,
      Effect.fnUntraced(function* (session) {
        if (session.threadId === undefined || session.title === undefined) return;
        const thread = liveThreads.get(session.threadId);
        if (thread === undefined || thread.title === session.title) return;
        yield* dependencies.dispatch({
          type: "thread.meta.update",
          commandId: yield* nextCommandId("hermes-title-reconcile"),
          threadId: session.threadId,
          title: session.title,
        });
      }),
      { concurrency: 1, discard: true },
    );
  });

  const listSessions = Effect.gen(function* () {
    const client = yield* dependencies.getClient();
    const [response, snapshot] = yield* Effect.all([
      client.listSessions,
      dependencies.getSnapshot(),
    ]);
    yield* reconcileTitleProjection(response, snapshot);
    const liveThreadIds = new Set(
      snapshot.threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
    );
    return {
      ...response,
      sessions: response.sessions.map((session) => {
        const { threadId, importedThreadIds, ...metadata } = session;
        return {
          ...metadata,
          ...(threadId && liveThreadIds.has(threadId) ? { threadId } : {}),
          ...(importedThreadIds
            ? {
                importedThreadIds: importedThreadIds.filter((candidate) =>
                  liveThreadIds.has(candidate),
                ),
              }
            : {}),
        };
      }),
    };
  }).pipe(
    Effect.withSpan("HermesConversationLifecycle.listSessions"),
    Effect.mapError((cause) =>
      lifecycleError("sessions.list", cause, "Unable to load Hermes sessions."),
    ),
  );

  const reconcileTitles = Effect.gen(function* () {
    const client = yield* dependencies.getClient();
    const [sessions, snapshot] = yield* Effect.all([
      client.listSessions,
      dependencies.getSnapshot(),
    ]);
    yield* reconcileTitleProjection(sessions, snapshot);
  }).pipe(
    Effect.withSpan("HermesConversationLifecycle.reconcileTitles"),
    Effect.mapError((cause) =>
      lifecycleError("titles.reconcile", cause, "Unable to reconcile Hermes session titles."),
    ),
  );

  const renameConversation = Effect.fn("HermesConversationLifecycle.renameConversation")(
    function* (input: HermesConversationRenameInput) {
      const client = yield* dependencies.getClient();
      const [sessions, snapshot] = yield* Effect.all([
        client.listSessions,
        dependencies.getSnapshot(),
      ]);
      const thread = snapshot.threads.find(
        (candidate) => candidate.id === input.threadId && candidate.deletedAt === null,
      );
      if (thread === undefined) {
        return yield* new HermesLifecycleError({
          operation: "conversation.rename",
          message: "The T3 Agent conversation is no longer available.",
          sourceThreadId: input.threadId,
        });
      }
      const session = sessions.sessions.find((candidate) => candidate.threadId === input.threadId);
      if (session === undefined) {
        return yield* new HermesLifecycleError({
          operation: "conversation.rename",
          message: "The Hermes session is not available yet.",
          sourceThreadId: input.threadId,
        });
      }

      const response = yield* client.updateSessionTitle({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: HermesBridgeRequestId.make(
          `conversation-rename:${session.sessionId}:${yield* dependencies.randomUuid}`,
        ),
        type: "session.title.update",
        sessionId: session.sessionId,
        targetThreadId: input.threadId,
        title: input.title,
      });
      if (response.status === "rejected") {
        return yield* new HermesLifecycleError({
          operation: "conversation.rename",
          message: response.message ?? "Hermes rejected the session title.",
          sourceSessionId: session.sessionId,
          sourceThreadId: input.threadId,
        });
      }
      if (response.title === undefined) {
        return yield* new HermesLifecycleError({
          operation: "conversation.rename",
          message: "Hermes accepted the rename without returning the session title.",
          sourceSessionId: session.sessionId,
          sourceThreadId: input.threadId,
        });
      }
      if (thread.title !== response.title) {
        yield* dependencies.dispatch({
          type: "thread.meta.update",
          commandId: yield* nextCommandId("hermes-conversation-rename"),
          threadId: input.threadId,
          title: response.title,
        });
      }
      return {
        threadId: input.threadId,
        title: response.title,
      };
    },
    (effect) =>
      renameLock
        .withPermit(effect)
        .pipe(
          Effect.mapError((cause) =>
            lifecycleError("conversation.rename", cause, "Unable to rename the Hermes session."),
          ),
        ),
  );

  const forkConversation = Effect.fn("HermesConversationLifecycle.forkConversation")(
    function* (input: HermesConversationForkInput) {
      const client = yield* dependencies.getClient();
      const [sessions, snapshot] = yield* Effect.all([
        client.listSessions,
        dependencies.getSnapshot(),
      ]);
      const source =
        input.source.type === "session"
          ? (() => {
              const sourceSessionId = input.source.sessionId;
              return sessions.sessions.find((session) => session.sessionId === sourceSessionId);
            })()
          : (() => {
              const sourceThreadId = input.source.threadId;
              return sessions.sessions.find((session) => session.threadId === sourceThreadId);
            })();
      if (!source) {
        return yield* new HermesLifecycleError({
          operation: "conversation.fork",
          message: "The source Hermes session is no longer available.",
          ...sourceContext(input),
        });
      }

      const existingThreadId = source.importedThreadIds?.find((threadId) =>
        snapshot.threads.some((thread) => thread.id === threadId && thread.deletedAt === null),
      );
      if (
        input.forceNew !== true &&
        source.source !== "t3agent" &&
        existingThreadId !== undefined
      ) {
        return {
          threadId: existingThreadId,
          existing: true,
        };
      }

      const project = snapshot.projects.find((candidate) => candidate.deletedAt === null);
      if (!project) {
        return yield* new HermesLifecycleError({
          operation: "conversation.fork",
          message: "T3 Agent's internal conversation workspace is unavailable.",
          ...sourceContext(input),
        });
      }

      const providers = yield* dependencies.getProviders;
      const hermesProvider = providers.find(
        (provider) => provider.instanceId === HERMES_INSTANCE_ID,
      );
      const defaultModel =
        hermesProvider?.models.find((model) => model.isDefault) ?? hermesProvider?.models[0];
      if (!defaultModel) {
        return yield* new HermesLifecycleError({
          operation: "conversation.fork",
          message: "Hermes has not reported an available model.",
          ...sourceContext(input),
        });
      }

      const threadId = ThreadId.make(yield* dependencies.randomUuid);
      const childSessionId = HermesBridgeSessionId.make(`t3-${threadId}`);
      const createdAt = yield* dependencies.nowIso;
      const forkRequest = {
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: HermesBridgeRequestId.make(`conversation-fork:${source.sessionId}:${threadId}`),
        type: "session.fork" as const,
        sourceSessionId: source.sessionId,
        childSessionId,
        targetThreadId: threadId,
        ...(input.userTurnCount !== undefined ? { userTurnCount: input.userTurnCount } : {}),
      };
      const deleteChildSession = Effect.fn("HermesConversationLifecycle.deleteChildSession")(
        function* () {
          yield* client
            .deleteSession({
              protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
              requestId: HermesBridgeRequestId.make(
                `conversation-fork-cleanup:${childSessionId}:${threadId}`,
              ),
              type: "session.delete",
              sessionId: childSessionId,
              targetThreadId: threadId,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        },
      );
      const fork = yield* client.forkSession(forkRequest).pipe(
        Effect.retry({ times: 1 }),
        Effect.onError(() => deleteChildSession()),
      );

      const sourceThread =
        source.threadId === undefined
          ? undefined
          : snapshot.threads.find((thread) => thread.id === source.threadId);
      const sourceTitle = sourceThread?.title ?? source.title ?? "Conversation";
      const modelSelection = fork.modelSelection
        ? {
            instanceId: HERMES_INSTANCE_ID,
            model: encodeHermesModelSlug(fork.modelSelection.provider, fork.modelSelection.model),
            ...(fork.modelSelection.reasoningEffort
              ? {
                  options: [
                    {
                      id: "reasoningEffort",
                      value: fork.modelSelection.reasoningEffort,
                    },
                  ],
                }
              : {}),
          }
        : {
            instanceId: HERMES_INSTANCE_ID,
            model: defaultModel.slug,
          };

      return yield* Effect.gen(function* () {
        yield* dependencies.dispatch({
          type: "thread.create",
          commandId: yield* nextCommandId("hermes-conversation-fork-create"),
          threadId,
          projectId: project.id,
          title: `${sourceTitle} copy`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* dependencies.dispatch({
          type: "thread.meta.update",
          commandId: yield* nextCommandId("hermes-conversation-fork-title"),
          threadId,
          title: fork.title,
        });
        for (const [index, message] of fork.messages.entries()) {
          yield* dependencies.dispatch({
            type: "thread.message.import",
            commandId: yield* nextCommandId(`hermes-history-${index}`),
            threadId,
            messageId: MessageId.make(`hermes-history:${fork.childSessionId}:${index}`),
            role: message.role,
            text: message.content,
            createdAt: message.createdAt,
          });
        }

        const isT3Fork = source.source === "t3agent" && source.threadId !== undefined;
        const lineage: HermesLineageMetadata = {
          kind: isT3Fork ? "fork" : "import",
          label: isT3Fork ? `Continued from ${sourceTitle}` : `Imported from ${source.source}`,
          sourceProvider: source.source,
          sourceSessionId: source.sessionId,
          ...(source.threadId ? { sourceThreadId: source.threadId } : {}),
        };
        const lineageJson = yield* encodeLineage(lineage);
        yield* dependencies.dispatch({
          type: "thread.message.import",
          commandId: yield* nextCommandId("hermes-lineage"),
          threadId,
          messageId: MessageId.make(`hermes-lineage:${fork.childSessionId}`),
          role: "system",
          text: `t3agent-lineage:${lineageJson}`,
          createdAt,
        });
        return { threadId, existing: false };
      }).pipe(
        Effect.onError(() =>
          Effect.all([deleteThread(threadId), deleteChildSession()], {
            concurrency: "unbounded",
          }).pipe(Effect.asVoid),
        ),
      );
    },
    (effect, input) =>
      forkLock
        .withPermit(effect)
        .pipe(
          Effect.mapError((cause) =>
            lifecycleError(
              "conversation.fork",
              cause,
              "Unable to create the Hermes conversation copy.",
              sourceContext(input),
            ),
          ),
        ),
  );

  return { listSessions, forkConversation, renameConversation, reconcileTitles };
}
