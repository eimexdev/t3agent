import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  HERMES_BRIDGE_PROTOCOL_VERSION,
  HermesBridgeRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type HermesBridgeT3ToHermesRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import type { HermesBridgeClient } from "../hermes/HermesBridgeClient.ts";
import { type HermesAdapter, makeHermesAdapter } from "./HermesAdapter.ts";

interface HermesAdapterTestHarnessShape {
  readonly adapter: HermesAdapter;
  readonly client: HermesBridgeClient;
  readonly sent: Array<HermesBridgeT3ToHermesRequest>;
  readonly rejectNext: (message: string) => void;
}

class HermesAdapterTestHarness extends Context.Service<
  HermesAdapterTestHarness,
  HermesAdapterTestHarnessShape
>()("t3/provider/Layers/HermesAdapter.test/HermesAdapterTestHarness") {}

const testLayer = Layer.effect(
  HermesAdapterTestHarness,
  Effect.gen(function* () {
    const sent: Array<HermesBridgeT3ToHermesRequest> = [];
    let nextRejection: string | undefined;
    const client: HermesBridgeClient = {
      getCapabilities: Effect.succeed({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: HermesBridgeRequestId.make("test-capabilities"),
        capabilities: {
          asynchronousDelivery: true,
          imageAttachments: true,
          interrupts: true,
          approvals: true,
          clarifications: true,
          slashConfirmations: true,
          threadCreation: true,
          commandCatalog: true,
        },
        commands: [],
      }),
      send: (request) =>
        Effect.sync(() => {
          sent.push(request);
          const rejection = nextRejection;
          nextRejection = undefined;
          return {
            protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
            requestId: request.requestId,
            ...(rejection
              ? { status: "rejected" as const, message: rejection }
              : { status: "accepted" as const }),
          };
        }),
      listSessions: Effect.die("not used by adapter tests"),
      forkSession: () => Effect.die("not used by adapter tests"),
      deleteSession: () => Effect.die("not used by adapter tests"),
    };
    const adapter = yield* makeHermesAdapter({
      instanceId: ProviderInstanceId.make("hermes-test"),
      client,
    });
    return HermesAdapterTestHarness.of({
      adapter,
      client,
      sent,
      rejectNext: (message) => {
        nextRejection = message;
      },
    });
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hermes-adapter-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("HermesAdapter", (it) => {
  it.effect("routes turns by T3 thread identity without forwarding cwd", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* HermesAdapterTestHarness;
      sent.length = 0;
      const threadId = ThreadId.make("hermes-route-thread");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        providerInstanceId: ProviderInstanceId.make("hermes-test"),
        threadId,
        cwd: "/workspace/that-must-not-be-forwarded",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello Hermes" });

      NodeAssert.equal(session.cwd, undefined);
      NodeAssert.equal(sent.length, 1);
      const request = sent[0];
      NodeAssert.equal(request?.type, "message.submit");
      if (request?.type !== "message.submit") return;
      NodeAssert.equal(request.chatId, "t3agent");
      NodeAssert.equal(request.threadId, threadId);
      NodeAssert.equal(request.content, "hello Hermes");
      NodeAssert.equal("cwd" in request, false);
    }),
  );

  it.effect("forwards provider-aware model and reasoning selections", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* HermesAdapterTestHarness;
      sent.length = 0;
      const threadId = ThreadId.make("hermes-model-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "use these controls",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes-test"),
          model: "openai-codex::gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });

      const request = sent[0];
      NodeAssert.equal(request?.type, "message.submit");
      if (request?.type !== "message.submit") return;
      NodeAssert.deepEqual(request.modelSelection, {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      });
    }),
  );

  it.effect("surfaces a rejected Hermes acknowledgement without starting the prompt", () =>
    Effect.gen(function* () {
      const { adapter, rejectNext } = yield* HermesAdapterTestHarness;
      const threadId = ThreadId.make("hermes-rejected-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });
      rejectNext("Approve the model change, then send the message again.");

      const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "wait for approval" }));

      NodeAssert.equal(error._tag, "ProviderAdapterValidationError");
      NodeAssert.match(error.message, /Approve the model change/);
    }),
  );

  it.effect("emits only cumulative text deltas and completes the active turn", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* HermesAdapterTestHarness;
      sent.length = 0;
      const threadId = ThreadId.make("hermes-stream-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const turn = yield* adapter.sendTurn({ threadId, input: "stream a reply" });
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "callback-request-1",
        deliveryId: "callback-delivery-1",
        type: "message.send",
        threadId,
        sourceMessageId: `hermes-user:${turn.turnId}`,
        messageId: "hermes-message-1",
        content: "Hel",
        final: false,
      });
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "callback-request-2",
        deliveryId: "callback-delivery-2",
        type: "message.edit",
        threadId,
        sourceMessageId: `hermes-user:${turn.turnId}`,
        messageId: "hermes-message-1",
        content: "Hello",
        final: true,
      });
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "callback-request-3",
        deliveryId: "callback-delivery-3",
        type: "turn.complete",
        threadId,
        sourceMessageId: `hermes-user:${turn.turnId}`,
        outcome: "success",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["turn.started", "content.delta", "content.delta", "item.completed", "turn.completed"],
      );
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta),
        ["Hel", "lo"],
      );
      const completed = events.find((event) => event.type === "item.completed");
      NodeAssert.equal(completed?.type, "item.completed");
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "Hello");
      }
    }),
  );

  it.effect("emits correlated native tool lifecycle events with full tool data", () =>
    Effect.gen(function* () {
      const { adapter } = yield* HermesAdapterTestHarness;
      const threadId = ThreadId.make("hermes-tool-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const turn = yield* adapter.sendTurn({ threadId, input: "read the skill" });
      const sourceMessageId = `hermes-user:${turn.turnId}`;
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "callback-tool-start-request",
        deliveryId: "callback-tool-start-delivery",
        type: "tool.started",
        chatId: "t3agent",
        threadId,
        sourceMessageId,
        toolCallId: "call-skill",
        name: "skill_view",
        input: { name: "query" },
      });
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "callback-tool-complete-request",
        deliveryId: "callback-tool-complete-delivery",
        type: "tool.completed",
        chatId: "t3agent",
        threadId,
        sourceMessageId,
        toolCallId: "call-skill",
        name: "skill_view",
        input: { name: "query" },
        result: "Skill loaded",
        isError: false,
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["turn.started", "item.started", "item.completed"],
      );
      const started = events[1];
      const completed = events[2];
      NodeAssert.equal(started?.itemId, completed?.itemId);
      NodeAssert.deepEqual(completed?.payload, {
        itemType: "mcp_tool_call",
        status: "completed",
        title: "Read skill",
        detail: "Skill loaded",
        data: {
          toolCallId: "call-skill",
          item: {
            toolCallId: "call-skill",
            name: "skill_view",
            input: { name: "query" },
            result: { output: "Skill loaded" },
          },
        },
      });
    }),
  );

  it.effect("acknowledges a repeated delivery id as a duplicate", () =>
    Effect.gen(function* () {
      const { adapter } = yield* HermesAdapterTestHarness;
      const threadId = ThreadId.make("hermes-duplicate-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });
      const callback = {
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "duplicate-request",
        deliveryId: "duplicate-delivery",
        type: "typing.set",
        threadId,
        active: true,
      } as const;

      const accepted = yield* adapter.receiveCallback(callback);
      const duplicate = yield* adapter.receiveCallback(callback);

      NodeAssert.deepEqual(accepted, {
        status: "accepted",
        deliveryId: "duplicate-delivery",
      });
      NodeAssert.deepEqual(duplicate, {
        status: "duplicate",
        deliveryId: "duplicate-delivery",
      });
    }),
  );

  it.effect("round-trips approval and clarification responses through the bridge", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* HermesAdapterTestHarness;
      sent.length = 0;
      const threadId = ThreadId.make("hermes-interaction-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "approval-request-callback",
        deliveryId: "approval-request-delivery",
        type: "approval.request",
        threadId,
        sessionKey: "session-interactions",
        providerRequestId: "provider-approval-1",
        approvalId: "approval-1",
        title: "Run command",
        message: "Allow this command?",
        choices: [
          { id: "once", label: "Allow once" },
          { id: "session", label: "Allow for this session" },
          { id: "always", label: "Always allow" },
          { id: "deny", label: "Deny" },
        ],
      });
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "clarification-request-callback",
        deliveryId: "clarification-request-delivery",
        type: "clarification.request",
        threadId,
        sessionKey: "session-interactions",
        providerRequestId: "provider-clarification-1",
        clarifyId: "clarify-1",
        question: "Which environment?",
        choices: [{ id: "staging", label: "Staging" }],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["user-input.requested", "user-input.requested"],
      );

      const approvalEvent = events[0];
      const clarificationEvent = events[1];
      NodeAssert.equal(approvalEvent?.type, "user-input.requested");
      NodeAssert.equal(clarificationEvent?.type, "user-input.requested");
      if (
        approvalEvent?.type !== "user-input.requested" ||
        clarificationEvent?.type !== "user-input.requested"
      ) {
        return;
      }

      NodeAssert.ok(approvalEvent.requestId);
      NodeAssert.ok(clarificationEvent.requestId);
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(approvalEvent.requestId), {
        "approval-1": "Always allow",
      });
      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(clarificationEvent.requestId),
        { "clarify-1": "Staging" },
      );

      NodeAssert.equal(sent[0]?.type, "approval.respond");
      NodeAssert.deepEqual(
        sent[0]?.type === "approval.respond"
          ? {
              sessionKey: sent[0].sessionKey,
              approvalId: sent[0].approvalId,
              providerRequestId: sent[0].providerRequestId,
              choice: sent[0].choice,
            }
          : undefined,
        {
          sessionKey: "session-interactions",
          approvalId: "approval-1",
          providerRequestId: "provider-approval-1",
          choice: "always",
        },
      );
      NodeAssert.equal(sent[1]?.type, "clarification.respond");
      NodeAssert.deepEqual(
        sent[1]?.type === "clarification.respond"
          ? {
              sessionKey: sent[1].sessionKey,
              clarifyId: sent[1].clarifyId,
              providerRequestId: sent[1].providerRequestId,
              response: sent[1].response,
            }
          : undefined,
        {
          sessionKey: "session-interactions",
          clarifyId: "clarify-1",
          providerRequestId: "provider-clarification-1",
          response: "Staging",
        },
      );
    }),
  );

  it.effect("emits user-input resolution after submitting a custom clarification answer", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* HermesAdapterTestHarness;
      sent.length = 0;
      const threadId = ThreadId.make("hermes-custom-clarification-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });

      const emitted: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            emitted.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "custom-clarification-request",
        deliveryId: "custom-clarification-delivery",
        type: "clarification.request",
        threadId,
        sessionKey: "session-custom-clarification",
        providerRequestId: "provider-custom-clarification",
        clarifyId: "clarify-custom",
        question: "Which area should we prioritize?",
        choices: [{ id: "sales", label: "Sales" }],
      });
      yield* Effect.yieldNow;

      const requested = emitted.find((event) => event.type === "user-input.requested");
      NodeAssert.equal(requested?.type, "user-input.requested");
      if (requested?.type !== "user-input.requested" || !requested.requestId) return;

      const answers = { "clarify-custom": "None of the above because this is a test" };
      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(requested.requestId),
        answers,
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(eventFiber);

      const resolved = emitted.find((event) => event.type === "user-input.resolved");
      NodeAssert.equal(resolved?.type, "user-input.resolved");
      if (resolved?.type === "user-input.resolved") {
        NodeAssert.equal(resolved.requestId, requested.requestId);
        NodeAssert.deepEqual(resolved.payload.answers, answers);
      }
      NodeAssert.equal(sent[0]?.type, "clarification.respond");
    }),
  );

  it.effect("presents slash confirmations as resolvable choices", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* HermesAdapterTestHarness;
      sent.length = 0;
      const threadId = ThreadId.make("hermes-confirmation-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });

      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "confirmation-callback",
        deliveryId: "confirmation-delivery",
        type: "slash-confirmation.request",
        threadId,
        sessionKey: "session-confirmation",
        confirmId: "confirm-1",
        title: "Confirm restart",
        message: "Restart Hermes?",
      });

      const events = Array.from(yield* Fiber.join(eventFiber));
      NodeAssert.equal(events[0]?.type, "user-input.requested");
      if (events[0]?.type !== "user-input.requested") return;
      NodeAssert.ok(events[0].requestId);
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(events[0].requestId), {
        "confirm-1": "Run once",
      });
      NodeAssert.equal(sent[0]?.type, "slash-confirmation.respond");
      if (sent[0]?.type !== "slash-confirmation.respond") return;
      NodeAssert.equal(sent[0].sessionKey, "session-confirmation");
      NodeAssert.equal(sent[0].confirmId, "confirm-1");
      NodeAssert.equal(sent[0].choice, "once");
    }),
  );

  it.effect("rehydrates an interactive resolver from its persisted request id after restart", () =>
    Effect.gen(function* () {
      const { adapter, client, sent } = yield* HermesAdapterTestHarness;
      sent.length = 0;
      const threadId = ThreadId.make("hermes-restart-interaction-thread");
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "restart-approval-callback",
        deliveryId: "restart-approval-delivery",
        type: "approval.request",
        threadId,
        sessionKey: "session-after-restart",
        providerRequestId: "provider-request-after-restart",
        approvalId: "approval-after-restart",
        message: "Allow after restart?",
        choices: [
          { id: "once", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      });
      const events = Array.from(yield* Fiber.join(eventFiber));
      const request = events[0];
      NodeAssert.equal(request?.type, "user-input.requested");
      if (request?.type !== "user-input.requested") return;
      NodeAssert.ok(request.requestId);

      const restarted = yield* makeHermesAdapter({
        instanceId: ProviderInstanceId.make("hermes-test"),
        client,
      });
      yield* restarted.respondToUserInput(threadId, ApprovalRequestId.make(request.requestId), {
        "approval-after-restart": "Allow once",
      });

      const response = sent[0];
      NodeAssert.equal(response?.type, "approval.respond");
      if (response?.type !== "approval.respond") return;
      NodeAssert.equal(response.sessionKey, "session-after-restart");
      NodeAssert.equal(response.approvalId, "approval-after-restart");
      NodeAssert.equal(response.providerRequestId, "provider-request-after-restart");
      NodeAssert.equal(response.choice, "once");
    }),
  );

  it.effect("correlates a delayed completion to its source turn after restart", () =>
    Effect.gen(function* () {
      const { client } = yield* HermesAdapterTestHarness;
      const restarted = yield* makeHermesAdapter({
        instanceId: ProviderInstanceId.make("hermes-test"),
        client,
      });
      const eventFiber = yield* restarted.streamEvents.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* restarted.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "delayed-turn-complete-request",
        deliveryId: "delayed-turn-complete-delivery",
        type: "turn.complete",
        threadId: "hermes-delayed-thread",
        sourceMessageId: "hermes-user:hermes-original-turn",
        outcome: "success",
      });

      const events = Array.from(yield* Fiber.join(eventFiber));
      NodeAssert.equal(events[0]?.type, "turn.completed");
      NodeAssert.equal(events[0]?.turnId, "hermes-original-turn");
    }),
  );

  it.effect("does not let a delayed completion close a newer active turn", () =>
    Effect.gen(function* () {
      const { adapter } = yield* HermesAdapterTestHarness;
      const threadId = ThreadId.make("hermes-delayed-newer-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });
      const original = yield* adapter.sendTurn({ threadId, input: "first" });
      const newer = yield* adapter.sendTurn({ threadId, input: "second" });
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "older-turn-complete-request",
        deliveryId: "older-turn-complete-delivery",
        type: "turn.complete",
        threadId,
        sourceMessageId: `hermes-user:${original.turnId}`,
        outcome: "success",
      });

      const events = Array.from(yield* Fiber.join(eventFiber));
      NodeAssert.equal(events[0]?.turnId, original.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, newer.turnId);
    }),
  );

  it.effect("attributes queued output to its source turn while a newer turn stays active", () =>
    Effect.gen(function* () {
      const { adapter } = yield* HermesAdapterTestHarness;
      const threadId = ThreadId.make("hermes-queued-attribution-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });
      const original = yield* adapter.sendTurn({ threadId, input: "first" });
      const newer = yield* adapter.sendTurn({ threadId, input: "second" });
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "content.delta" ||
            event.type === "item.completed" ||
            event.type === "turn.completed",
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "queued-message-request",
        deliveryId: "queued-message-delivery",
        type: "message.send",
        threadId,
        sourceMessageId: `hermes-user:${original.turnId}`,
        messageId: "queued-message",
        content: "first answer",
        final: true,
      });
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "queued-complete-request",
        deliveryId: "queued-complete-delivery",
        type: "turn.complete",
        threadId,
        sourceMessageId: `hermes-user:${original.turnId}`,
        outcome: "success",
      });

      const events = Array.from(yield* Fiber.join(eventFiber));
      NodeAssert.deepEqual(
        events.map((event) => event.turnId),
        [original.turnId, original.turnId, original.turnId],
      );
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, newer.turnId);
    }),
  );

  it.effect("restores the still-running turn after an inline command completes", () =>
    Effect.gen(function* () {
      const { adapter } = yield* HermesAdapterTestHarness;
      const threadId = ThreadId.make("hermes-inline-command-state-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });
      const original = yield* adapter.sendTurn({ threadId, input: "long task" });
      const command = yield* adapter.sendTurn({ threadId, input: "/status" });
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "inline-command-complete-request",
        deliveryId: "inline-command-complete-delivery",
        type: "turn.complete",
        threadId,
        sourceMessageId: `hermes-user:${command.turnId}`,
        outcome: "success",
      });

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, original.turnId);
    }),
  );

  it.effect("keeps source-less proactive output independent from an active turn", () =>
    Effect.gen(function* () {
      const { adapter } = yield* HermesAdapterTestHarness;
      const threadId = ThreadId.make("hermes-proactive-output-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });
      const active = yield* adapter.sendTurn({ threadId, input: "foreground work" });
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "content.delta" || event.type === "item.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "proactive-message-request",
        deliveryId: "proactive-message-delivery",
        type: "message.send",
        threadId,
        messageId: "proactive-message",
        content: "scheduled result",
        final: true,
      });

      const events = Array.from(yield* Fiber.join(eventFiber));
      NodeAssert.deepEqual(
        events.map((event) => event.turnId),
        [undefined, undefined],
      );
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.activeTurnId, active.turnId);
    }),
  );

  it.effect("interrupts a session before Hermes has supplied a session key", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* HermesAdapterTestHarness;
      sent.length = 0;
      const threadId = ThreadId.make("hermes-interrupt-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.interruptTurn(threadId);

      NodeAssert.equal(sent.length, 1);
      const request = sent[0];
      NodeAssert.equal(request?.type, "turn.interrupt");
      if (request?.type !== "turn.interrupt") return;
      NodeAssert.equal(request.chatId, "t3agent");
      NodeAssert.equal(request.threadId, threadId);
      NodeAssert.equal("sessionKey" in request, false);
    }),
  );

  it.effect("completes an image-only assistant message with a persisted attachment", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* HermesAdapterTestHarness;
      sent.length = 0;
      const threadId = ThreadId.make("hermes-image-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const turn = yield* adapter.sendTurn({ threadId, input: "send an image" });
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "image-request",
        deliveryId: "image-delivery",
        type: "message.send",
        threadId,
        messageId: "image-message",
        content: "",
        final: true,
        images: [
          {
            type: "image",
            id: "hermes-image-1",
            name: "tiny.png",
            mimeType: "image/png",
            sizeBytes: 8,
            source: { type: "data-url", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
          },
        ],
      });
      yield* adapter.receiveCallback({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "image-turn-complete-request",
        deliveryId: "image-turn-complete-delivery",
        type: "turn.complete",
        threadId,
        sourceMessageId: `hermes-user:${turn.turnId}`,
        outcome: "success",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["turn.started", "item.completed", "turn.completed"],
      );
      const completed = events.find((event) => event.type === "item.completed");
      NodeAssert.equal(completed?.type, "item.completed");
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, undefined);
        const data = completed.payload.data as {
          readonly attachments?: ReadonlyArray<Record<string, unknown>>;
        };
        NodeAssert.equal(data.attachments?.length, 1);
        NodeAssert.equal(data.attachments?.[0]?.type, "image");
        NodeAssert.equal(data.attachments?.[0]?.name, "tiny.png");
        NodeAssert.equal(data.attachments?.[0]?.mimeType, "image/png");
        NodeAssert.equal(data.attachments?.[0]?.sizeBytes, 8);
        NodeAssert.match(String(data.attachments?.[0]?.id), /^hermes-image-thread-/);
      }
    }),
  );

  it.effect("does not commit a failed delivery before a safe retry succeeds", () =>
    Effect.gen(function* () {
      const { adapter } = yield* HermesAdapterTestHarness;
      const threadId = ThreadId.make("hermes-delivery-retry-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("hermes"),
        threadId,
        runtimeMode: "full-access",
      });
      const base = {
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "retry-request",
        deliveryId: "retry-delivery",
        type: "message.send" as const,
        threadId,
        messageId: "retry-message",
        content: "image",
        final: true,
      };

      const failedAsExpected = yield* adapter
        .receiveCallback({
          ...base,
          images: [
            {
              type: "image",
              id: "unsafe-image",
              name: "unsafe.png",
              mimeType: "image/png",
              source: { type: "local-path", path: "/etc/passwd" },
            },
          ],
        })
        .pipe(
          Effect.as(false),
          Effect.catch((error) =>
            Effect.sync(() => {
              NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
              return true;
            }),
          ),
        );
      NodeAssert.equal(failedAsExpected, true);

      const accepted = yield* adapter.receiveCallback({
        ...base,
        images: [
          {
            type: "image",
            id: "safe-image",
            name: "safe.png",
            mimeType: "image/png",
            source: { type: "data-url", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
          },
        ],
      });
      NodeAssert.deepEqual(accepted, { status: "accepted", deliveryId: "retry-delivery" });
    }),
  );
});
