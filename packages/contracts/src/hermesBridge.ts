import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const HERMES_BRIDGE_MAX_IMAGES = 8;
export const HERMES_BRIDGE_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;

/**
 * Wire contracts shared by the T3 Agent server and the Hermes `t3` platform
 * adapter. Authentication belongs to the HTTP transport (Authorization
 * bearer), so credentials are deliberately excluded from persisted payloads.
 */

export const HERMES_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const HermesBridgeProtocolVersion = Schema.Literal(HERMES_BRIDGE_PROTOCOL_VERSION);
export type HermesBridgeProtocolVersion = typeof HermesBridgeProtocolVersion.Type;

const UnknownFields = Schema.Record(Schema.String, Schema.Unknown);

const openStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [UnknownFields] as const);

const makeBridgeId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const HermesBridgeRequestId = makeBridgeId("HermesBridgeRequestId");
export type HermesBridgeRequestId = typeof HermesBridgeRequestId.Type;

export const HermesBridgeDeliveryId = makeBridgeId("HermesBridgeDeliveryId");
export type HermesBridgeDeliveryId = typeof HermesBridgeDeliveryId.Type;

export const HermesBridgeChatId = makeBridgeId("HermesBridgeChatId");
export type HermesBridgeChatId = typeof HermesBridgeChatId.Type;

export const HermesBridgeThreadId = makeBridgeId("HermesBridgeThreadId");
export type HermesBridgeThreadId = typeof HermesBridgeThreadId.Type;

export const HermesBridgeSessionKey = makeBridgeId("HermesBridgeSessionKey");
export type HermesBridgeSessionKey = typeof HermesBridgeSessionKey.Type;

export const HermesBridgeProviderRequestId = makeBridgeId("HermesBridgeProviderRequestId");
export type HermesBridgeProviderRequestId = typeof HermesBridgeProviderRequestId.Type;

export const HermesBridgeApprovalId = makeBridgeId("HermesBridgeApprovalId");
export type HermesBridgeApprovalId = typeof HermesBridgeApprovalId.Type;

export const HermesBridgeClarifyId = makeBridgeId("HermesBridgeClarifyId");
export type HermesBridgeClarifyId = typeof HermesBridgeClarifyId.Type;

export const HermesBridgeConfirmationId = makeBridgeId("HermesBridgeConfirmationId");
export type HermesBridgeConfirmationId = typeof HermesBridgeConfirmationId.Type;

export const HermesBridgeImageAttachmentId = makeBridgeId("HermesBridgeImageAttachmentId");
export type HermesBridgeImageAttachmentId = typeof HermesBridgeImageAttachmentId.Type;

const RequestFields = {
  protocolVersion: HermesBridgeProtocolVersion,
  requestId: HermesBridgeRequestId,
} as const;

const CallbackFields = {
  ...RequestFields,
  deliveryId: HermesBridgeDeliveryId,
} as const;

export const HermesBridgeImageSource = Schema.Union([
  openStruct({
    type: Schema.Literal("local-path"),
    path: TrimmedNonEmptyString,
  }),
  openStruct({
    type: Schema.Literal("url"),
    url: TrimmedNonEmptyString,
  }),
  openStruct({
    type: Schema.Literal("data-url"),
    dataUrl: TrimmedNonEmptyString.check(
      Schema.isMaxLength(HERMES_BRIDGE_MAX_IMAGE_DATA_URL_CHARS),
    ),
  }),
]);
export type HermesBridgeImageSource = typeof HermesBridgeImageSource.Type;

export const HermesBridgeImageAttachment = openStruct({
  type: Schema.Literal("image"),
  id: HermesBridgeImageAttachmentId,
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString.check(Schema.isPattern(/^image\//i)),
  sizeBytes: Schema.optionalKey(NonNegativeInt),
  source: HermesBridgeImageSource,
});
export type HermesBridgeImageAttachment = typeof HermesBridgeImageAttachment.Type;

export const HermesBridgeUser = openStruct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type HermesBridgeUser = typeof HermesBridgeUser.Type;

export const HermesBridgeChoice = openStruct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HermesBridgeChoice = typeof HermesBridgeChoice.Type;

// T3 Agent -> Hermes

export const HermesBridgeInboundMessageRequest = openStruct({
  ...RequestFields,
  type: Schema.Literal("message.submit"),
  messageId: MessageId,
  chatId: HermesBridgeChatId,
  threadId: Schema.optionalKey(HermesBridgeThreadId),
  user: HermesBridgeUser,
  content: Schema.String,
  model: Schema.optionalKey(TrimmedNonEmptyString),
  modelProvider: Schema.optionalKey(TrimmedNonEmptyString),
  reasoningEffort: Schema.optionalKey(TrimmedNonEmptyString),
  images: Schema.optionalKey(
    Schema.Array(HermesBridgeImageAttachment).check(Schema.isMaxLength(HERMES_BRIDGE_MAX_IMAGES)),
  ),
});
export type HermesBridgeInboundMessageRequest = typeof HermesBridgeInboundMessageRequest.Type;

export const HermesBridgeInterruptRequest = openStruct({
  ...RequestFields,
  type: Schema.Literal("turn.interrupt"),
  sessionKey: Schema.optionalKey(HermesBridgeSessionKey),
  chatId: Schema.optionalKey(HermesBridgeChatId),
  threadId: Schema.optionalKey(HermesBridgeThreadId),
});
export type HermesBridgeInterruptRequest = typeof HermesBridgeInterruptRequest.Type;

export const HermesBridgeApprovalResponseRequest = openStruct({
  ...RequestFields,
  type: Schema.Literal("approval.respond"),
  sessionKey: HermesBridgeSessionKey,
  approvalId: HermesBridgeApprovalId,
  providerRequestId: HermesBridgeProviderRequestId,
  choice: TrimmedNonEmptyString,
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HermesBridgeApprovalResponseRequest = typeof HermesBridgeApprovalResponseRequest.Type;

export const HermesBridgeClarificationResponseRequest = openStruct({
  ...RequestFields,
  type: Schema.Literal("clarification.respond"),
  sessionKey: HermesBridgeSessionKey,
  clarifyId: HermesBridgeClarifyId,
  providerRequestId: HermesBridgeProviderRequestId,
  response: Schema.Unknown,
});
export type HermesBridgeClarificationResponseRequest =
  typeof HermesBridgeClarificationResponseRequest.Type;

export const HermesBridgeSlashConfirmationChoice = Schema.Literals(["once", "always", "cancel"]);
export type HermesBridgeSlashConfirmationChoice = typeof HermesBridgeSlashConfirmationChoice.Type;

export const HermesBridgeSlashConfirmationResponseRequest = openStruct({
  ...RequestFields,
  type: Schema.Literal("slash-confirmation.respond"),
  sessionKey: HermesBridgeSessionKey,
  confirmId: HermesBridgeConfirmationId,
  choice: HermesBridgeSlashConfirmationChoice,
});
export type HermesBridgeSlashConfirmationResponseRequest =
  typeof HermesBridgeSlashConfirmationResponseRequest.Type;

export const HermesBridgeT3ToHermesRequest = Schema.Union([
  HermesBridgeInboundMessageRequest,
  HermesBridgeInterruptRequest,
  HermesBridgeApprovalResponseRequest,
  HermesBridgeClarificationResponseRequest,
  HermesBridgeSlashConfirmationResponseRequest,
]);
export type HermesBridgeT3ToHermesRequest = typeof HermesBridgeT3ToHermesRequest.Type;

// Hermes -> T3 Agent callbacks

const DestinationFields = {
  chatId: Schema.optionalKey(HermesBridgeChatId),
  threadId: Schema.optionalKey(HermesBridgeThreadId),
  sourceMessageId: Schema.optionalKey(MessageId),
} as const;

const MessageCallbackFields = {
  ...CallbackFields,
  ...DestinationFields,
  messageId: MessageId,
  content: Schema.String,
  images: Schema.optionalKey(
    Schema.Array(HermesBridgeImageAttachment).check(Schema.isMaxLength(HERMES_BRIDGE_MAX_IMAGES)),
  ),
  final: Schema.Boolean,
} as const;

export const HermesBridgeSendMessageRequest = openStruct({
  ...MessageCallbackFields,
  type: Schema.Literal("message.send"),
});
export type HermesBridgeSendMessageRequest = typeof HermesBridgeSendMessageRequest.Type;

export const HermesBridgeEditMessageRequest = openStruct({
  ...MessageCallbackFields,
  type: Schema.Literal("message.edit"),
});
export type HermesBridgeEditMessageRequest = typeof HermesBridgeEditMessageRequest.Type;

export const HermesBridgeDeleteMessageRequest = openStruct({
  ...CallbackFields,
  ...DestinationFields,
  type: Schema.Literal("message.delete"),
  messageId: MessageId,
});
export type HermesBridgeDeleteMessageRequest = typeof HermesBridgeDeleteMessageRequest.Type;

export const HermesBridgeTypingRequest = openStruct({
  ...CallbackFields,
  ...DestinationFields,
  type: Schema.Literal("typing.set"),
  active: Schema.Boolean,
});
export type HermesBridgeTypingRequest = typeof HermesBridgeTypingRequest.Type;

export const HermesBridgeTurnCompleteRequest = openStruct({
  ...CallbackFields,
  ...DestinationFields,
  type: Schema.Literal("turn.complete"),
  sourceMessageId: MessageId,
  outcome: Schema.Literals(["success", "failure", "cancelled"]),
});
export type HermesBridgeTurnCompleteRequest = typeof HermesBridgeTurnCompleteRequest.Type;

const InteractiveCallbackFields = {
  ...CallbackFields,
  ...DestinationFields,
  sessionKey: HermesBridgeSessionKey,
  providerRequestId: HermesBridgeProviderRequestId,
} as const;

export const HermesBridgeApprovalRequest = openStruct({
  ...InteractiveCallbackFields,
  type: Schema.Literal("approval.request"),
  approvalId: HermesBridgeApprovalId,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
  choices: Schema.NonEmptyArray(HermesBridgeChoice),
});
export type HermesBridgeApprovalRequest = typeof HermesBridgeApprovalRequest.Type;

export const HermesBridgeClarificationRequest = openStruct({
  ...InteractiveCallbackFields,
  type: Schema.Literal("clarification.request"),
  clarifyId: HermesBridgeClarifyId,
  question: TrimmedNonEmptyString,
  choices: Schema.Array(HermesBridgeChoice),
});
export type HermesBridgeClarificationRequest = typeof HermesBridgeClarificationRequest.Type;

export const HermesBridgeSlashConfirmationRequest = openStruct({
  ...CallbackFields,
  ...DestinationFields,
  type: Schema.Literal("slash-confirmation.request"),
  sessionKey: HermesBridgeSessionKey,
  confirmId: HermesBridgeConfirmationId,
  title: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type HermesBridgeSlashConfirmationRequest = typeof HermesBridgeSlashConfirmationRequest.Type;

export const HermesBridgeThreadCreateRequest = openStruct({
  ...CallbackFields,
  type: Schema.Literal("thread.create"),
  parentChatId: HermesBridgeChatId,
  name: TrimmedNonEmptyString,
  occurrenceId: TrimmedNonEmptyString,
  sessionKey: Schema.optionalKey(HermesBridgeSessionKey),
});
export type HermesBridgeThreadCreateRequest = typeof HermesBridgeThreadCreateRequest.Type;

export const HermesBridgeHermesToT3Request = Schema.Union([
  HermesBridgeSendMessageRequest,
  HermesBridgeEditMessageRequest,
  HermesBridgeDeleteMessageRequest,
  HermesBridgeTypingRequest,
  HermesBridgeTurnCompleteRequest,
  HermesBridgeApprovalRequest,
  HermesBridgeClarificationRequest,
  HermesBridgeSlashConfirmationRequest,
  HermesBridgeThreadCreateRequest,
]);
export type HermesBridgeHermesToT3Request = typeof HermesBridgeHermesToT3Request.Type;

// Health, discovery, and response payloads

export const HermesBridgeHealthRequest = openStruct(RequestFields);
export type HermesBridgeHealthRequest = typeof HermesBridgeHealthRequest.Type;

export const HermesBridgeHealthResponse = openStruct({
  ...RequestFields,
  status: Schema.Literals(["healthy", "degraded"]),
  instanceId: Schema.optionalKey(TrimmedNonEmptyString),
  hermesVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HermesBridgeHealthResponse = typeof HermesBridgeHealthResponse.Type;

export const HermesBridgeCapabilitiesRequest = openStruct(RequestFields);
export type HermesBridgeCapabilitiesRequest = typeof HermesBridgeCapabilitiesRequest.Type;

export const HermesBridgeCapabilities = openStruct({
  asynchronousDelivery: Schema.Boolean,
  imageAttachments: Schema.Boolean,
  interrupts: Schema.Boolean,
  approvals: Schema.Boolean,
  clarifications: Schema.Boolean,
  slashConfirmations: Schema.Boolean,
  threadCreation: Schema.Boolean,
  commandCatalog: Schema.Boolean,
});
export type HermesBridgeCapabilities = typeof HermesBridgeCapabilities.Type;

export const HermesBridgeCommand = openStruct({
  name: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
  inputHint: Schema.optionalKey(TrimmedNonEmptyString),
  aliases: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type HermesBridgeCommand = typeof HermesBridgeCommand.Type;

export const HermesBridgeCommandCatalogRequest = openStruct(RequestFields);
export type HermesBridgeCommandCatalogRequest = typeof HermesBridgeCommandCatalogRequest.Type;

export const HermesBridgeCommandCatalogResponse = openStruct({
  ...RequestFields,
  commands: Schema.Array(HermesBridgeCommand),
});
export type HermesBridgeCommandCatalogResponse = typeof HermesBridgeCommandCatalogResponse.Type;

export const HermesBridgeModel = openStruct({
  provider: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  isDefault: Schema.optionalKey(Schema.Boolean),
  reasoningEfforts: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  defaultReasoningEffort: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HermesBridgeModel = typeof HermesBridgeModel.Type;

export const HermesBridgeCapabilitiesResponse = openStruct({
  ...RequestFields,
  capabilities: HermesBridgeCapabilities,
  commands: Schema.Array(HermesBridgeCommand),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  models: Schema.optionalKey(Schema.Array(HermesBridgeModel)),
  reasoningEffort: Schema.optionalKey(TrimmedNonEmptyString),
  profile: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HermesBridgeCapabilitiesResponse = typeof HermesBridgeCapabilitiesResponse.Type;

export const HermesBridgeAcknowledgement = openStruct({
  ...RequestFields,
  deliveryId: Schema.optionalKey(HermesBridgeDeliveryId),
  status: Schema.Literals(["accepted", "duplicate", "rejected"]),
  message: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HermesBridgeAcknowledgement = typeof HermesBridgeAcknowledgement.Type;

export const HermesBridgeThreadCreateResponse = openStruct({
  ...RequestFields,
  deliveryId: HermesBridgeDeliveryId,
  chatId: HermesBridgeChatId,
  threadId: HermesBridgeThreadId,
});
export type HermesBridgeThreadCreateResponse = typeof HermesBridgeThreadCreateResponse.Type;

export const HermesBridgeSessionSummary = openStruct({
  sessionId: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  threadId: Schema.optionalKey(ThreadId),
  parentSessionId: Schema.optionalKey(TrimmedNonEmptyString),
  startedAt: IsoDateTime,
  endedAt: Schema.optionalKey(IsoDateTime),
  messageCount: NonNegativeInt,
  importedThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
});
export type HermesBridgeSessionSummary = typeof HermesBridgeSessionSummary.Type;

export const HermesBridgeSessionListResponse = openStruct({
  ...RequestFields,
  sessions: Schema.Array(HermesBridgeSessionSummary),
});
export type HermesBridgeSessionListResponse = typeof HermesBridgeSessionListResponse.Type;

export const HermesBridgeSessionForkRequest = openStruct({
  ...RequestFields,
  type: Schema.Literal("session.fork"),
  sourceSessionId: TrimmedNonEmptyString,
  targetThreadId: ThreadId,
  userTurnCount: Schema.optionalKey(NonNegativeInt),
});
export type HermesBridgeSessionForkRequest = typeof HermesBridgeSessionForkRequest.Type;

export const HermesBridgeHistoryMessage = openStruct({
  role: Schema.Literals(["user", "assistant", "system"]),
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type HermesBridgeHistoryMessage = typeof HermesBridgeHistoryMessage.Type;

export const HermesBridgeSessionForkResponse = openStruct({
  ...RequestFields,
  sourceSessionId: TrimmedNonEmptyString,
  childSessionId: TrimmedNonEmptyString,
  targetThreadId: ThreadId,
  source: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  messages: Schema.Array(HermesBridgeHistoryMessage),
});
export type HermesBridgeSessionForkResponse = typeof HermesBridgeSessionForkResponse.Type;

export const HermesConversationForkInput = Schema.Struct({
  sourceThreadId: Schema.optional(ThreadId),
  sourceSessionId: Schema.optional(TrimmedNonEmptyString),
  userTurnCount: Schema.optional(NonNegativeInt),
  forceNew: Schema.optional(Schema.Boolean),
});
export type HermesConversationForkInput = typeof HermesConversationForkInput.Type;

export const HermesConversationForkResult = Schema.Struct({
  threadId: ThreadId,
  existing: Schema.Boolean,
});
export type HermesConversationForkResult = typeof HermesConversationForkResult.Type;

export const HermesLineageMetadata = Schema.Struct({
  kind: Schema.Literals(["fork", "import"]),
  label: TrimmedNonEmptyString,
  sourceProvider: TrimmedNonEmptyString,
  sourceSessionId: TrimmedNonEmptyString,
  sourceThreadId: Schema.optional(ThreadId),
});
export type HermesLineageMetadata = typeof HermesLineageMetadata.Type;

export class HermesLifecycleError extends Schema.TaggedErrorClass<HermesLifecycleError>()(
  "HermesLifecycleError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
