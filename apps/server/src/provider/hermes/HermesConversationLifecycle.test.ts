import { assert, describe, it, vi } from "@effect/vitest";
import {
  HERMES_BRIDGE_PROTOCOL_VERSION,
  HermesBridgeRequestId,
  HermesBridgeSessionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type HermesBridgeSessionListResponse,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { HermesBridgeClient } from "./HermesBridgeClient.ts";
import {
  makeHermesConversationLifecycle,
  type HermesConversationLifecycleDependencies,
} from "./HermesConversationLifecycle.ts";

const NOW = "2026-07-23T10:00:00.000Z";
const PROJECT_ID = ProjectId.make("project");
const SOURCE_SESSION_ID = HermesBridgeSessionId.make("discord-source");
const CHILD_SESSION_ID = HermesBridgeSessionId.make("t3-child");
const T3_SOURCE_SESSION_ID = HermesBridgeSessionId.make("t3-source");
const SOURCE_THREAD_ID = ThreadId.make("source-thread");
const LIVE_IMPORTED_THREAD_ID = ThreadId.make("live-import");
const DELETED_IMPORTED_THREAD_ID = ThreadId.make("deleted-import");

const sessionList = {
  protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
  requestId: HermesBridgeRequestId.make("sessions-list"),
  sessions: [
    {
      sessionId: SOURCE_SESSION_ID,
      source: "discord",
      title: "Planning",
      startedAt: NOW,
      messageCount: 8,
      importedThreadIds: [LIVE_IMPORTED_THREAD_ID, DELETED_IMPORTED_THREAD_ID],
    },
    {
      sessionId: T3_SOURCE_SESSION_ID,
      source: "t3agent",
      title: "Native conversation",
      threadId: SOURCE_THREAD_ID,
      startedAt: NOW,
      messageCount: 2,
    },
  ],
} satisfies HermesBridgeSessionListResponse;

type FailureTarget = "remote-fork" | "history-import" | "lineage-import";

class TestLifecycleDependencyError extends Schema.TaggedErrorClass<TestLifecycleDependencyError>()(
  "TestLifecycleDependencyError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

function makeHarness(input: {
  readonly sessions?: HermesBridgeSessionListResponse;
  readonly failureTarget?: FailureTarget;
  readonly liveImportedThread?: boolean;
  readonly titleUpdateRejection?: string;
}) {
  const commands: Array<OrchestrationCommand> = [];
  const createdThreadIds: Array<ThreadId> = [];
  let uuid = 0;
  const forkSession = vi.fn<HermesBridgeClient["forkSession"]>((request) =>
    input.failureTarget === "remote-fork"
      ? Effect.fail(
          new ProviderAdapterRequestError({
            provider: "hermes",
            method: "session.fork",
            detail: "Hermes fork unavailable",
          }),
        )
      : Effect.succeed({
          protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
          requestId: request.requestId,
          sourceSessionId: request.sourceSessionId,
          childSessionId: request.childSessionId,
          targetThreadId: request.targetThreadId,
          source: "discord",
          title: "Planning copy",
          modelSelection: {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
          },
          messages: [
            {
              role: "user",
              content: "Continue this",
              createdAt: NOW,
            },
            {
              role: "assistant",
              content: "Continuing",
              createdAt: NOW,
            },
          ],
        }),
  );
  const deleteSession = vi.fn<HermesBridgeClient["deleteSession"]>((request) =>
    Effect.succeed({
      protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
      requestId: request.requestId,
      status: "accepted",
    }),
  );
  const updateSessionTitle = vi.fn<HermesBridgeClient["updateSessionTitle"]>((request) =>
    Effect.succeed(
      input.titleUpdateRejection
        ? {
            protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
            requestId: request.requestId,
            status: "rejected" as const,
            message: input.titleUpdateRejection,
          }
        : {
            protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
            requestId: request.requestId,
            status: "accepted" as const,
            title: request.title.trim(),
          },
    ),
  );
  const baseSessions = input.sessions ?? sessionList;
  const client: Pick<
    HermesBridgeClient,
    "listSessions" | "forkSession" | "deleteSession" | "updateSessionTitle"
  > = {
    listSessions: Effect.sync(() => ({
      ...baseSessions,
      sessions: baseSessions.sessions.map((session) =>
        session.sessionId === SOURCE_SESSION_ID
          ? {
              ...session,
              importedThreadIds: [...(session.importedThreadIds ?? []), ...createdThreadIds],
            }
          : session,
      ),
    })),
    forkSession,
    deleteSession,
    updateSessionTitle,
  };
  const dispatch: HermesConversationLifecycleDependencies["dispatch"] = (command) => {
    commands.push(command);
    if (command.type === "thread.create") {
      createdThreadIds.push(command.threadId);
    }
    const isLineage = command.type === "thread.message.import" && command.role === "system";
    const isHistory = command.type === "thread.message.import" && command.role !== "system";
    if (
      (input.failureTarget === "history-import" && isHistory) ||
      (input.failureTarget === "lineage-import" && isLineage)
    ) {
      return Effect.fail(
        new TestLifecycleDependencyError({
          detail: `Failed ${input.failureTarget}`,
        }),
      );
    }
    return Effect.succeed({ sequence: commands.length });
  };
  const dependencies: HermesConversationLifecycleDependencies = {
    getClient: () => Effect.succeed(client),
    getSnapshot: () =>
      Effect.succeed({
        projects: [{ id: PROJECT_ID, deletedAt: null }],
        threads: [
          {
            id: LIVE_IMPORTED_THREAD_ID,
            title: "Imported conversation",
            deletedAt: input.liveImportedThread === false ? NOW : null,
          },
          { id: DELETED_IMPORTED_THREAD_ID, title: "Deleted", deletedAt: NOW },
          { id: SOURCE_THREAD_ID, title: "Provisional title", deletedAt: null },
          ...createdThreadIds.map((id) => ({ id, deletedAt: null })),
        ],
      }),
    getProviders: Effect.succeed([
      {
        instanceId: ProviderInstanceId.make("hermes"),
        models: [{ slug: "openrouter::anthropic/claude-sonnet-4", isDefault: true }],
      },
    ]),
    dispatch,
    randomUuid: Effect.sync(() => `generated-${String((uuid += 1))}`),
    nowIso: Effect.succeed(NOW),
  };
  return {
    lifecycle: makeHermesConversationLifecycle(dependencies),
    commands,
    forkSession,
    deleteSession,
    updateSessionTitle,
  };
}

function assertCompensates(failureTarget: FailureTarget) {
  const { lifecycle, commands, deleteSession } = makeHarness({
    failureTarget,
    liveImportedThread: false,
  });
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      lifecycle.forkConversation({
        source: { type: "session", sessionId: SOURCE_SESSION_ID },
        forceNew: true,
      }),
    );

    assert.isTrue(Result.isFailure(result));
    if (Result.isSuccess(result)) return;
    assert.strictEqual(result.failure.operation, "conversation.fork");
    assert.strictEqual(result.failure.sourceSessionId, SOURCE_SESSION_ID);
    if (failureTarget === "remote-fork") {
      assert.lengthOf(commands, 0);
      assert.strictEqual(deleteSession.mock.calls.length, 1);
      return;
    }
    assert.deepStrictEqual(
      commands.at(-1)?.type,
      "thread.delete",
      `${failureTarget} should delete the partial T3 thread`,
    );
    const created = commands.find((command) => command.type === "thread.create");
    const deleted = commands.at(-1);
    assert.strictEqual(created?.type, "thread.create");
    assert.strictEqual(deleted?.type, "thread.delete");
    if (created?.type === "thread.create" && deleted?.type === "thread.delete") {
      assert.strictEqual(deleted.threadId, created.threadId);
    }
    assert.strictEqual(deleteSession.mock.calls.length, 1);
  });
}

describe("HermesConversationLifecycle", () => {
  it.effect("lists sessions without stale T3 thread links", () => {
    const { lifecycle, commands } = makeHarness({});
    return Effect.gen(function* () {
      const result = yield* lifecycle.listSessions;

      assert.deepStrictEqual(result.sessions[0]?.importedThreadIds, [LIVE_IMPORTED_THREAD_ID]);
      assert.strictEqual(result.sessions[1]?.threadId, SOURCE_THREAD_ID);
      const titleUpdate = commands.find(
        (command) => command.type === "thread.meta.update" && command.threadId === SOURCE_THREAD_ID,
      );
      assert.strictEqual(titleUpdate?.type, "thread.meta.update");
      if (titleUpdate?.type === "thread.meta.update") {
        assert.strictEqual(titleUpdate.title, "Native conversation");
      }
    });
  });

  it.effect("renames Hermes before updating the local projection", () => {
    const { lifecycle, commands, updateSessionTitle } = makeHarness({});
    return Effect.gen(function* () {
      const result = yield* lifecycle.renameConversation({
        threadId: SOURCE_THREAD_ID,
        title: "  Sidebar rename  ",
      });

      assert.deepStrictEqual(result, {
        threadId: SOURCE_THREAD_ID,
        title: "Sidebar rename",
      });
      assert.strictEqual(updateSessionTitle.mock.calls.length, 1);
      assert.deepInclude(updateSessionTitle.mock.calls[0]?.[0], {
        type: "session.title.update",
        sessionId: T3_SOURCE_SESSION_ID,
        targetThreadId: SOURCE_THREAD_ID,
      });
      assert.deepInclude(commands.at(-1), {
        type: "thread.meta.update",
        threadId: SOURCE_THREAD_ID,
        title: "Sidebar rename",
      });
    });
  });

  it.effect("preserves the local projection when Hermes rejects a rename", () => {
    const { lifecycle, commands } = makeHarness({
      titleUpdateRejection: "Title is already in use.",
    });
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        lifecycle.renameConversation({
          threadId: SOURCE_THREAD_ID,
          title: "Duplicate",
        }),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isSuccess(result)) return;
      assert.strictEqual(result.failure.operation, "conversation.rename");
      assert.match(result.failure.message, /already in use/);
      assert.lengthOf(commands, 0);
    });
  });

  it.effect("reconciles titled Hermes sessions and ignores missing titles", () => {
    const sessions = {
      ...sessionList,
      sessions: [
        sessionList.sessions[0]!,
        sessionList.sessions[1]!,
        {
          sessionId: HermesBridgeSessionId.make("untitled"),
          source: "t3agent",
          threadId: LIVE_IMPORTED_THREAD_ID,
          startedAt: NOW,
          messageCount: 1,
        },
      ],
    } satisfies HermesBridgeSessionListResponse;
    const { lifecycle, commands } = makeHarness({ sessions });
    return Effect.gen(function* () {
      yield* lifecycle.reconcileTitles;

      assert.deepStrictEqual(
        commands.map((command) =>
          command.type === "thread.meta.update"
            ? { threadId: command.threadId, title: command.title }
            : { type: command.type },
        ),
        [{ threadId: SOURCE_THREAD_ID, title: "Native conversation" }],
      );
    });
  });

  it.effect("reuses an existing live import unless another copy is requested", () => {
    const { lifecycle, commands, forkSession } = makeHarness({});
    return Effect.gen(function* () {
      const result = yield* lifecycle.forkConversation({
        source: { type: "session", sessionId: SOURCE_SESSION_ID },
      });

      assert.deepStrictEqual(result, {
        threadId: LIVE_IMPORTED_THREAD_ID,
        existing: true,
      });
      assert.lengthOf(commands, 0);
      assert.strictEqual(forkSession.mock.calls.length, 0);
    });
  });

  it.effect("creates a child conversation with copied history and lineage", () => {
    const { lifecycle, commands, forkSession } = makeHarness({
      liveImportedThread: false,
    });
    return Effect.gen(function* () {
      const result = yield* lifecycle.forkConversation({
        source: { type: "session", sessionId: SOURCE_SESSION_ID },
        userTurnCount: 1,
      });

      assert.isFalse(result.existing);
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        [
          "thread.create",
          "thread.meta.update",
          "thread.message.import",
          "thread.message.import",
          "thread.message.import",
        ],
      );
      const request = forkSession.mock.calls[0]?.[0];
      assert.strictEqual(request?.userTurnCount, 1);
      assert.strictEqual(
        request?.childSessionId,
        HermesBridgeSessionId.make(`t3-${result.threadId}`),
      );
      const create = commands[0];
      assert.strictEqual(create?.type, "thread.create");
      if (create?.type === "thread.create") {
        assert.deepStrictEqual(create.modelSelection, {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "openai-codex::gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        });
      }
      const lineage = commands.at(-1);
      assert.strictEqual(lineage?.type, "thread.message.import");
      if (lineage?.type === "thread.message.import") {
        assert.include(lineage.text, '"kind":"import"');
        assert.include(lineage.text, '"label":"Imported from discord"');
      }
    });
  });

  it.effect("deletes the partial thread when the Hermes fork fails", () =>
    assertCompensates("remote-fork"),
  );

  it.effect("deletes the partial thread when history import fails", () =>
    assertCompensates("history-import"),
  );

  it.effect("deletes the partial thread when lineage import fails", () =>
    assertCompensates("lineage-import"),
  );

  it.effect("serializes duplicate imports and reuses the first copy", () => {
    const { lifecycle, commands, forkSession } = makeHarness({
      liveImportedThread: false,
    });
    const importSource = () =>
      lifecycle.forkConversation({
        source: { type: "session" as const, sessionId: SOURCE_SESSION_ID },
      });

    return Effect.gen(function* () {
      const [first, second] = yield* Effect.all([importSource(), importSource()], {
        concurrency: "unbounded",
      });

      assert.strictEqual(first.threadId, second.threadId);
      assert.deepStrictEqual([first.existing, second.existing].sort(), [false, true]);
      assert.strictEqual(forkSession.mock.calls.length, 1);
      assert.strictEqual(commands.filter((command) => command.type === "thread.create").length, 1);
    });
  });
});
