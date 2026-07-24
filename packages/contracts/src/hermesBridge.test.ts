import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HermesBridgeAcknowledgement,
  HermesBridgeApprovalRequest,
  HermesBridgeApprovalResponseRequest,
  HermesBridgeCapabilitiesResponse,
  HermesBridgeClarificationRequest,
  HermesBridgeClarificationResponseRequest,
  HermesBridgeHermesToT3Request,
  HermesBridgeInboundMessageRequest,
  HermesBridgeSlashConfirmationRequest,
  HermesBridgeSlashConfirmationResponseRequest,
  HermesBridgeSessionDeleteRequest,
  HermesBridgeSessionTitleUpdatedRequest,
  HermesBridgeSessionTitleUpdateRequest,
  HermesBridgeSessionTitleUpdateResponse,
  HermesBridgeT3ToHermesRequest,
  HermesBridgeThreadCreateRequest,
  HermesBridgeThreadCreateResponse,
  HermesConversationForkInput,
} from "./hermesBridge.ts";

const decodeInboundMessage = Schema.decodeUnknownSync(HermesBridgeInboundMessageRequest);
const decodeT3ToHermes = Schema.decodeUnknownSync(HermesBridgeT3ToHermesRequest);
const decodeHermesToT3 = Schema.decodeUnknownSync(HermesBridgeHermesToT3Request);
const decodeApprovalRequest = Schema.decodeUnknownSync(HermesBridgeApprovalRequest);
const decodeApprovalResponse = Schema.decodeUnknownSync(HermesBridgeApprovalResponseRequest);
const decodeClarificationRequest = Schema.decodeUnknownSync(HermesBridgeClarificationRequest);
const decodeClarificationResponse = Schema.decodeUnknownSync(
  HermesBridgeClarificationResponseRequest,
);
const decodeSlashConfirmationRequest = Schema.decodeUnknownSync(
  HermesBridgeSlashConfirmationRequest,
);
const decodeSlashConfirmationResponse = Schema.decodeUnknownSync(
  HermesBridgeSlashConfirmationResponseRequest,
);
const decodeCapabilitiesResponse = Schema.decodeUnknownSync(HermesBridgeCapabilitiesResponse);
const decodeAcknowledgement = Schema.decodeUnknownSync(HermesBridgeAcknowledgement);
const decodeThreadCreateRequest = Schema.decodeUnknownSync(HermesBridgeThreadCreateRequest);
const decodeThreadCreateResponse = Schema.decodeUnknownSync(HermesBridgeThreadCreateResponse);
const decodeConversationForkInput = Schema.decodeUnknownSync(HermesConversationForkInput);
const decodeSessionDeleteRequest = Schema.decodeUnknownSync(HermesBridgeSessionDeleteRequest);
const decodeSessionTitleUpdateRequest = Schema.decodeUnknownSync(
  HermesBridgeSessionTitleUpdateRequest,
);
const decodeSessionTitleUpdateResponse = Schema.decodeUnknownSync(
  HermesBridgeSessionTitleUpdateResponse,
);
const decodeSessionTitleUpdatedRequest = Schema.decodeUnknownSync(
  HermesBridgeSessionTitleUpdatedRequest,
);

const requestFields = {
  protocolVersion: 1,
  requestId: "request-1",
} as const;

const callbackFields = {
  ...requestFields,
  deliveryId: "delivery-1",
} as const;

it("decodes model inventory and effective reasoning from capabilities", () => {
  const decoded = decodeCapabilitiesResponse({
    ...requestFields,
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
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    models: [
      {
        provider: "openai-codex",
        slug: "gpt-5.6-sol",
        isDefault: true,
        reasoningEfforts: ["none", "low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
    ],
  });

  expect(decoded.models?.[0]?.slug).toBe("gpt-5.6-sol");
  expect(decoded.reasoningEffort).toBe("high");
});

describe("Hermes bridge T3 to Hermes requests", () => {
  it("decodes an image-bearing inbound message and preserves future fields", () => {
    const decoded = decodeInboundMessage({
      ...requestFields,
      type: "message.submit",
      messageId: "message-1",
      chatId: "chat-1",
      threadId: "thread-1",
      user: {
        id: "owner-1",
        name: "Owner",
        futureUserField: "preserved",
      },
      content: "Inspect this image",
      modelSelection: {
        model: "gpt-5.6-sol",
        provider: "openai-codex",
        reasoningEffort: "high",
      },
      images: [
        {
          type: "image",
          id: "image-1",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 42,
          source: {
            type: "local-path",
            path: "/tmp/screen.png",
            futureSourceField: true,
          },
          futureImageField: 1,
        },
      ],
      futureMessageField: { supportedLater: true },
    });

    expect(decoded.futureMessageField).toEqual({ supportedLater: true });
    expect(decoded.user.futureUserField).toBe("preserved");
    expect(decoded.images?.[0]?.futureImageField).toBe(1);
    expect(decoded.images?.[0]?.source.futureSourceField).toBe(true);
    expect(decoded.modelSelection).toEqual({
      model: "gpt-5.6-sol",
      provider: "openai-codex",
      reasoningEffort: "high",
    });
  });

  it("accepts every T3 to Hermes request discriminant", () => {
    const requests = [
      {
        ...requestFields,
        type: "message.submit",
        messageId: "message-1",
        chatId: "chat-1",
        user: { id: "owner-1", name: "Owner" },
        content: "hello",
      },
      { ...requestFields, type: "turn.interrupt" },
      {
        ...requestFields,
        type: "approval.respond",
        sessionKey: "session-1",
        approvalId: "approval-1",
        providerRequestId: "provider-request-1",
        choice: "approve_once",
      },
      {
        ...requestFields,
        type: "clarification.respond",
        sessionKey: "session-1",
        clarifyId: "clarify-1",
        providerRequestId: "provider-request-2",
        response: { answer: "Tailscale" },
      },
      {
        ...requestFields,
        type: "slash-confirmation.respond",
        sessionKey: "session-1",
        confirmId: "confirm-1",
        choice: "always",
      },
    ];

    expect(requests.map((request) => decodeT3ToHermes(request).type)).toEqual([
      "message.submit",
      "turn.interrupt",
      "approval.respond",
      "clarification.respond",
      "slash-confirmation.respond",
    ]);
  });

  it("rejects missing correlation fields and unsupported protocol versions", () => {
    expect(() =>
      decodeInboundMessage({
        protocolVersion: 1,
        type: "message.submit",
        messageId: "message-1",
        chatId: "chat-1",
        user: { id: "owner-1", name: "Owner" },
        content: "hello",
      }),
    ).toThrow();

    expect(() =>
      decodeInboundMessage({
        ...requestFields,
        protocolVersion: 2,
        type: "message.submit",
        messageId: "message-1",
        chatId: "chat-1",
        user: { id: "owner-1", name: "Owner" },
        content: "hello",
      }),
    ).toThrow();
  });

  it("validates approval and clarification provider correlation", () => {
    expect(
      decodeApprovalResponse({
        ...requestFields,
        type: "approval.respond",
        sessionKey: "session-1",
        approvalId: "approval-1",
        providerRequestId: "provider-request-1",
        choice: "approve_session",
      }).providerRequestId,
    ).toBe("provider-request-1");

    expect(
      decodeClarificationResponse({
        ...requestFields,
        type: "clarification.respond",
        sessionKey: "session-1",
        clarifyId: "clarify-1",
        providerRequestId: "provider-request-2",
        response: ["one", "two"],
      }).response,
    ).toEqual(["one", "two"]);

    expect(() =>
      decodeApprovalResponse({
        ...requestFields,
        type: "approval.respond",
        sessionKey: "session-1",
        approvalId: "approval-1",
        choice: "approve_once",
      }),
    ).toThrow();
  });

  it("limits slash confirmation responses to supported choices", () => {
    expect(
      decodeSlashConfirmationResponse({
        ...requestFields,
        type: "slash-confirmation.respond",
        sessionKey: "session-1",
        confirmId: "confirm-1",
        choice: "once",
      }).choice,
    ).toBe("once");

    expect(() =>
      decodeSlashConfirmationResponse({
        ...requestFields,
        type: "slash-confirmation.respond",
        sessionKey: "session-1",
        confirmId: "confirm-1",
        choice: "yes",
      }),
    ).toThrow();
  });
});

describe("Hermes session titles", () => {
  it("decodes title updates in both directions", () => {
    expect(
      decodeSessionTitleUpdateRequest({
        ...requestFields,
        type: "session.title.update",
        sessionId: "session-1",
        targetThreadId: "thread-1",
        title: "Renamed in the sidebar",
      }).title,
    ).toBe("Renamed in the sidebar");

    expect(
      decodeSessionTitleUpdateResponse({
        ...requestFields,
        status: "accepted",
        title: "Renamed in the sidebar",
      }).status,
    ).toBe("accepted");

    expect(
      decodeSessionTitleUpdatedRequest({
        ...callbackFields,
        type: "session.title.updated",
        chatId: "t3agent",
        threadId: "thread-1",
        sessionId: "session-1",
        title: "Renamed with /title",
      }).title,
    ).toBe("Renamed with /title");
  });

  it("rejects empty session titles", () => {
    expect(() =>
      decodeSessionTitleUpdateRequest({
        ...requestFields,
        type: "session.title.update",
        sessionId: "session-1",
        targetThreadId: "thread-1",
        title: " ",
      }),
    ).toThrow();
  });
});

describe("Hermes bridge Hermes to T3 callbacks", () => {
  it("decodes send and cumulative edit callbacks with final state", () => {
    const send = decodeHermesToT3({
      ...callbackFields,
      type: "message.send",
      chatId: "chat-1",
      threadId: "thread-1",
      messageId: "message-1",
      content: "partial",
      final: false,
    });
    const edit = decodeHermesToT3({
      ...callbackFields,
      requestId: "request-2",
      deliveryId: "delivery-2",
      type: "message.edit",
      threadId: "thread-1",
      messageId: "message-1",
      content: "partial response completed",
      final: true,
      futurePresentation: "markdown-v2",
    });

    expect(send.type).toBe("message.send");
    expect(send.final).toBe(false);
    expect(edit.type).toBe("message.edit");
    expect(edit.final).toBe(true);
    expect(edit.futurePresentation).toBe("markdown-v2");
  });

  it("decodes structured tool lifecycle callbacks", () => {
    const started = decodeHermesToT3({
      ...callbackFields,
      type: "tool.started",
      chatId: "t3agent",
      threadId: "thread-1",
      sourceMessageId: "hermes-user:turn-1",
      toolCallId: "call-1",
      name: "skill_view",
      input: { name: "query" },
    });
    const completed = decodeHermesToT3({
      ...callbackFields,
      requestId: "request-2",
      deliveryId: "delivery-2",
      type: "tool.completed",
      chatId: "t3agent",
      threadId: "thread-1",
      sourceMessageId: "hermes-user:turn-1",
      toolCallId: "call-1",
      name: "skill_view",
      input: { name: "query" },
      result: "Skill loaded",
      isError: false,
    });

    expect(started.type).toBe("tool.started");
    expect(started.input).toEqual({ name: "query" });
    expect(completed.type).toBe("tool.completed");
    expect(completed.result).toBe("Skill loaded");
  });

  it("accepts delete, typing, interactions, confirmation, and thread creation", () => {
    const callbacks = [
      { ...callbackFields, type: "message.delete", messageId: "message-1" },
      { ...callbackFields, type: "typing.set", active: true },
      {
        ...callbackFields,
        type: "turn.complete",
        sourceMessageId: "user-message-1",
        outcome: "success",
      },
      {
        ...callbackFields,
        type: "approval.request",
        sessionKey: "session-1",
        approvalId: "approval-1",
        providerRequestId: "provider-request-1",
        message: "Run the command?",
        choices: [{ id: "once", label: "Approve once" }],
      },
      {
        ...callbackFields,
        type: "clarification.request",
        sessionKey: "session-1",
        clarifyId: "clarify-1",
        providerRequestId: "provider-request-2",
        question: "Which network?",
        choices: [],
      },
      {
        ...callbackFields,
        type: "slash-confirmation.request",
        sessionKey: "session-1",
        confirmId: "confirm-1",
        title: "Restart Hermes",
        message: "Restart the running gateway?",
      },
      {
        ...callbackFields,
        type: "thread.create",
        parentChatId: "chat-1",
        name: "Nightly report",
        occurrenceId: "nightly-report-1",
      },
    ];

    expect(callbacks.map((callback) => decodeHermesToT3(callback).type)).toEqual([
      "message.delete",
      "typing.set",
      "turn.complete",
      "approval.request",
      "clarification.request",
      "slash-confirmation.request",
      "thread.create",
    ]);
  });

  it("requires stable delivery and message lifecycle fields", () => {
    expect(() =>
      decodeHermesToT3({
        ...requestFields,
        type: "message.send",
        messageId: "message-1",
        content: "done",
        final: true,
      }),
    ).toThrow();

    expect(() =>
      decodeHermesToT3({
        ...callbackFields,
        type: "message.edit",
        messageId: "message-1",
        content: "done",
      }),
    ).toThrow();
  });

  it("validates provider requests and choices", () => {
    const approval = decodeApprovalRequest({
      ...callbackFields,
      type: "approval.request",
      sessionKey: "session-1",
      approvalId: "approval-1",
      providerRequestId: "provider-request-1",
      message: "Allow shell command?",
      choices: [
        { id: "once", label: "Approve once" },
        { id: "deny", label: "Deny", description: "Do not run it" },
      ],
    });
    const clarification = decodeClarificationRequest({
      ...callbackFields,
      type: "clarification.request",
      sessionKey: "session-1",
      clarifyId: "clarify-1",
      providerRequestId: "provider-request-2",
      question: "Where should the cron output go?",
      choices: [{ id: "origin", label: "Origin thread" }],
    });
    const confirmation = decodeSlashConfirmationRequest({
      ...callbackFields,
      type: "slash-confirmation.request",
      sessionKey: "session-1",
      confirmId: "confirm-1",
      title: "Restart Hermes",
      message: "This interrupts active work.",
    });

    expect(approval.choices).toHaveLength(2);
    expect(clarification.providerRequestId).toBe("provider-request-2");
    expect(confirmation.confirmId).toBe("confirm-1");

    expect(() =>
      decodeApprovalRequest({
        ...callbackFields,
        type: "approval.request",
        sessionKey: "session-1",
        approvalId: "approval-1",
        providerRequestId: "provider-request-1",
        message: "Allow?",
        choices: [],
      }),
    ).toThrow();
  });
});

describe("Hermes bridge discovery and responses", () => {
  it("requires exactly one typed conversation source", () => {
    expect(
      decodeConversationForkInput({
        source: { type: "session", sessionId: "discord-source" },
        forceNew: true,
      }).source,
    ).toEqual({ type: "session", sessionId: "discord-source" });
    expect(
      decodeConversationForkInput({
        source: {
          type: "thread",
          threadId: "00000000-0000-4000-8000-000000000001",
        },
      }).source.type,
    ).toBe("thread");
    expect(() =>
      decodeConversationForkInput({
        sourceSessionId: "discord-source",
        sourceThreadId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
  });

  it("correlates child-session cleanup to its T3 thread", () => {
    expect(
      decodeSessionDeleteRequest({
        ...requestFields,
        type: "session.delete",
        sessionId: "t3-child",
        targetThreadId: "00000000-0000-4000-8000-000000000001",
      }).sessionId,
    ).toBe("t3-child");
  });

  it("requires a logical occurrence id when creating a thread", () => {
    const decoded = decodeThreadCreateRequest({
      ...callbackFields,
      type: "thread.create",
      parentChatId: "t3agent",
      name: "Research",
      occurrenceId: "occurrence-1",
    });
    expect(decoded.occurrenceId).toBe("occurrence-1");
    expect(() =>
      decodeThreadCreateRequest({
        ...callbackFields,
        type: "thread.create",
        parentChatId: "t3agent",
        name: "Research",
      }),
    ).toThrow();
  });

  it("decodes capabilities and the command catalog", () => {
    const decoded = decodeCapabilitiesResponse({
      ...requestFields,
      capabilities: {
        asynchronousDelivery: true,
        imageAttachments: true,
        interrupts: true,
        approvals: true,
        clarifications: true,
        slashConfirmations: true,
        threadCreation: true,
        commandCatalog: true,
        futureCapability: "voice-messages",
      },
      commands: [
        {
          name: "restart",
          description: "Restart Hermes",
          aliases: ["reboot"],
          futureCommandField: true,
        },
      ],
      provider: "openrouter",
      model: "model-1",
    });

    expect(decoded.capabilities.futureCapability).toBe("voice-messages");
    expect(decoded.commands[0]?.futureCommandField).toBe(true);
  });

  it("correlates acknowledgements and created threads", () => {
    expect(
      decodeAcknowledgement({
        ...requestFields,
        deliveryId: "delivery-1",
        status: "duplicate",
      }).deliveryId,
    ).toBe("delivery-1");

    expect(
      decodeThreadCreateResponse({
        ...requestFields,
        deliveryId: "delivery-1",
        chatId: "chat-2",
        threadId: "thread-2",
        futureThreadField: "preserved",
      }).futureThreadField,
    ).toBe("preserved");
  });
});
