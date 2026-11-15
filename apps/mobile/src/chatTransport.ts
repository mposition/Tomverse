export type ChatMessage = {
  continuationReceipt?: import("../../../lib/continuationReceipt").ContinuationReceipt;
  researchRunId?: string | null;
  id: string;
  role: "user" | "assistant";
  content: string;
  modelId?: string;
  /** Set only on a turn Auto routed, from the response header; kept for this session. */
  routedModelId?: string;
  status?: string;
  pendingJobId?: string | null;
  artifacts?: import("../../../lib/generatedArtifactCore").ChatStreamArtifact[];
  searchMetadata?: { citations: Array<{ url: string; title?: string }> } | null;
  attachments?: import("../../../components/chat/types").ChatAttachment[];
  imageTurn?: { groupId: string; modelIds: string[] };
};
/** The imported original above a continuation's own turns. Read-only. */
export type ImportedTranscript = {
  reviewHandoff?: ReviewHandoffSummary;
  provider: string;
  importedAt: string;
  status: "available" | "deleted" | "locked";
  messages: Array<{ id: string; ordinal?: number; role: "user" | "assistant"; content: string; sourceModelLabel: string | null }>;
  messageTotal?: number;
  /** Index of the first loaded message; earlier ones load a page at a time. */
  offset: number;
  pageSize: number;
};
export type ReviewHandoffSummary = {
  sourceMode: "recorded" | "legacy";
  nativeTurnCount: number;
  nativeOmittedCount: number;
  sourceTurnCount: number;
  sourceOmittedCount: number;
  attachmentsSupported: false;
};
export type ReviewHandoffDraft = {
  scopeKey: string;
  text: string;
  revision: number;
  attachmentReferences: [];
};
export type ReviewHandoffDraftEnvelope = { scopeKey: string; draft: ReviewHandoffDraft | null };
export type ReviewHandoffResult = {
  conversationId: string;
  route: string;
  idempotentReplay: boolean;
  reviewHandoff: ReviewHandoffSummary;
};
export type Conversation = {
  id: string;
  title: string;
  selectedModels: string[];
  messages: ChatMessage[];
  selectionMode?: string;
  autoSelection?: { offered?: boolean };
  activeAttempt?: boolean;
  surface?: string;
  webSearchMode?: "off" | "always";
  memoryMode?: "inherit" | "on" | "off";
  assistantProfileId?: string | null;
  productKey?: string | null;
  imported?: ImportedTranscript;
  reviewHandoff?: true | ReviewHandoffSummary;
};
export type MobileImageGroup = {
  status: string;
  targets: Array<{ targetId: string; modelId: string; currentGenerationId: string | null }>;
  generations: Array<{ generationId: string; status: string; prompt: string; quality?: string; preset?: string; assets: Array<{ role: string; url: string; urlExpiresAt?: string }> }>;
};
export type MobileImageModel = { id: string; name: string; provider: string; pricingVersion: string; prices: Array<{ quality: "low" | "medium" | "high"; size: "1024x1024" | "1536x1024" | "1024x1536"; credits: number }> };
export type MobileCapabilities = { researchPreview?: { enabled: boolean; pageReading: boolean; durableRuns: boolean }; generatedFileRevisions?: boolean; workspace?: import("./iosWorkspaceContract").WorkspaceFeatures; historyFeatures?: { sharing: boolean; downloads: boolean }; historyActions?: boolean; conversationTitles?: boolean; accountUsage?: boolean; chatImageTurns?: boolean; chatImageEdits?: boolean; reviewEasy: boolean; maxModels: number; assistants: boolean; images?: { enabled: boolean; maxModels: number; models: MobileImageModel[] }; plan: import("../../../lib/models").ModelTier | "Guest" };
export type AccountUsage = { plan: string; usage: { creditsMonth: number }; limits: { creditsMonth: number } };
export type UserPreferences = { reviewEasyEffectiveProviders?: string[]; reviewEasyProviderOptions?: string[]; reviewEasyMaxProviders?: number; theme: "system" | "light" | "dark"; language: string; defaultModel: string; timeZone: string; timeZoneChangeAllowedAt?: string | null; imageHandoffAutoGenerate: boolean };
export type MemoryPreferences = { masterEnabled: boolean; styleEnabled: boolean; defaultConversationMode: "on" | "off" };
export type AssistantSummary = { id: string; name: string; description?: string | null };
export type ChatSummary = Pick<Conversation, "id" | "title"> & Partial<import("../../../lib/continuationTitleContext").ContinuationRowNaming> & { kind?: string; surface?: string; productKey?: string | null; updatedAt?: string; pinned?: boolean; pinSeq?: number; projectId?: string | null; selectedModels?: string[]; isLocked?: boolean; shareEnabled?: boolean };
export type HistoryProject = { id: string; name: string; conversationCount?: number };
export type HistorySearch = { results: Array<{ id: string; kind?: string; conversationId: string; conversationTitle: string; snippet: string; surface?: string }>; truncated?: boolean; sourceSearch?: string; validUntil?: string | null };
export interface HistoryTransport {
  projects(): Promise<HistoryProject[]>;
  saveProject(id: string | null, name: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  search(query: string, signal: AbortSignal): Promise<HistorySearch>;
  rename(id: string, title: string): Promise<void>;
  pin(chat: ChatSummary, pinned: boolean): Promise<void>;
  move(id: string, projectId: string | null): Promise<void>;
  share(id: string): Promise<{ url: string }>;
  revokeShare(id: string): Promise<void>;
  export(id: string, title: string, includeSource: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  password(id: string, password: string | null, currentPassword?: string): Promise<void>;
  unlock(id: string, password: string): Promise<void>;
  unlocked(id: string): boolean;
}
export type MobileAttachment = { uploadId: string; name: string; mediaType: string; size: number };
export type ContinuationTurnContext = {
  sourcePassages?: readonly import("../../../lib/continuationPassages").Passage[];
  onReceipt?: (receipt: import("../../../lib/continuationReceipt").ContinuationReceipt) => void;
};
export type PreparedArtifactRevision = MobileAttachment & { revisionMode?: "workbook" | "workbook-values" };
export type MobileModel = { id: string; name: string; provider: string; minimumPlan: import("../../../lib/models").AiModel["minimumPlan"] };
export interface ChatTransport {
  researchPreviewOffer?(input: import("../../../components/chat/useResearchPreview").ResearchPreviewOfferInput, signal?: AbortSignal, locale?: string): Promise<unknown>;
  researchRuns?: import("../../../lib/researchPreviewRunClient").ResearchPreviewRunTransport;
  sendResearchPreview?(conversation: Conversation, text: string, files: MobileAttachment[], signal: AbortSignal, progress: (text: string) => void, options: { durable: boolean; locale: string }): Promise<void>;

  workspace?: import("./iosWorkspaceContract").WorkspaceTransport;
  location?: ReturnType<typeof import("@tomverse/chat-core").createChatLocationSession>;
  history?: HistoryTransport;
  voiceConfiguration?(): Promise<{ enabled: boolean; maxSeconds: number | null }>;
  voiceRequest?(body: unknown, signal?: AbortSignal): Promise<Response>;
  sendVoice?(conversation: Conversation, text: string, signal: AbortSignal, progress: (text: string) => void): Promise<{ conversationId: string; sourceUserMessageId: string }>;
  resumeResearch?(conversation: Conversation, signal: AbortSignal, update: (conversation: Conversation) => void): Promise<void>;
  reviewPreview?(id: string, mode?: string, synthesis?: boolean): Promise<import("../../../packages/chat-core/src/review").ReviewSetup>;
  runComparison?(id: string, input: { promptMessageId: string; assistantMessageIds: string[]; reviewMode: import("../../../packages/chat-core/src/review").ReviewMode; includeSynthesis: boolean }): Promise<import("../../../packages/chat-core/src/review").ComparisonReview>;
  reviewFeedback?(id: string, reviewId: string): Promise<{ feedback: Array<{ reviewItemId: string; verdict: string }> }>;
  setReviewFeedback?(id: string, reviewId: string, reviewItemId: string, verdict: string | null): Promise<void>;
  verifyReviewItem?(id: string, item: string): Promise<{ status: string; summary: string; usageCredits: number; disclaimer: string; reviewerModelId: string }>;
  generateImages?(input: { prompt: string; size: string; quality: string; idempotencyKey: string; modelIds: string[]; expectedPricingVersions: Record<string, string>; conversationId?: string }): Promise<{ groupId: string; conversationId: string }>;
  imageHistory?(id: string): Promise<{ generations: Array<{ groupId: string; prompt: string }> }>;
  imageRequest?(key: string): Promise<{ groupId: string; conversationId: string }>;
  listReview?(): Promise<ChatSummary[]>;
  createReview?(models: string[], assistantProfileId?: string): Promise<Conversation>;
  prepareReviewHandoff?(id: string, input: { assistantMessageId: string; idempotencyKey: string }, signal?: AbortSignal): Promise<ReviewHandoffResult>;
  reviewHandoffDraft?: {
    get(id: string): Promise<ReviewHandoffDraftEnvelope>;
    put(id: string, input: { text: string; attachmentReferences: []; expectedRevision: number }): Promise<ReviewHandoffDraftEnvelope>;
    remove(id: string, expectedRevision: number): Promise<ReviewHandoffDraftEnvelope>;
  };
  configureReview?(id: string, models: string[]): Promise<Conversation>;
  routeReview?(input: { text: string; context: string; providers: string[]; hasImages: boolean }): Promise<import("../../../lib/reviewRoutingCore").ReviewRouteDecision>;
  sendReview?(conversation: Conversation, text: string, files: MobileAttachment[], signal: AbortSignal, progress: (modelId: string, text: string) => void, draft?: { revision: number }): Promise<{ failedModelIds: string[] }>;
  mobileCapabilities?(refresh?: boolean): Promise<MobileCapabilities>;
  usage?(): Promise<AccountUsage>;
  generateTitle?(conversation: Conversation): Promise<string | null>;
  preferences?(): Promise<UserPreferences>;
  /** Reports a problem with one answer; the server links it only to the caller's own message. */
  reportAnswer?(input: { messageId: string; modelId?: string; message: string; language: string }): Promise<{ reference?: string }>;
  savePreferences?(input: Partial<UserPreferences> & { timeZoneSource?: "user" }): Promise<void>;
  memoryPreferences?(): Promise<MemoryPreferences>;
  saveMemoryPreferences?(input: MemoryPreferences): Promise<void>;
  assistants?(): Promise<AssistantSummary[]>;
  configureTools?(id: string, input: { webSearchMode?: "off" | "always"; memoryMode?: "inherit" | "on" | "off"; assistantProfileId?: string | null }): Promise<Conversation>;
  deviceSecurity?(): Promise<import("./authBridgeContract").DeviceSecurity>;
  setDeviceLock?(enabled: boolean, reason: string): Promise<void>;
  unlockDevice?(reason: string): Promise<void>;
  imageGroup?(id: string): Promise<MobileImageGroup>;
  account(): Promise<{ id: string; name?: string | null; email?: string | null; actionsEnabled: boolean }>;
  exportAccount(): Promise<void>;
  deleteAccount(confirmationText: string): Promise<void>;
  downloadArtifact(artifact: import("../../../lib/generatedArtifactCore").ChatStreamArtifact): Promise<void>;
  prepareArtifactRevision?(input: { artifactId: string; conversationId: string; operationId: string }): Promise<PreparedArtifactRevision>;
  discardAttachment?(uploadId: string): Promise<void>;
  artifactVersions?(artifactId: string, cursor?: string | null): Promise<import("../../../lib/generatedArtifactVersions").GeneratedArtifactVersions>;
  onSessionLost?(listener: () => void): () => void;
  session(): Promise<boolean>;
  signIn(): Promise<void>;
  requestEmailCode?(email: string, language: string): Promise<void>;
  verifyEmailCode?(email: string, code: string, signup?: { intent: "signup"; termsAccepted: boolean }): Promise<void>;
  signOut(): Promise<void>;
  list(): Promise<ChatSummary[]>;
  load(id: string): Promise<Conversation>;
  continuationSource?(id: string, offset?: number): Promise<ImportedTranscript>;
  create(title?: string, assistantProfileId?: string): Promise<Conversation>;
  models(): Promise<MobileModel[]>;
  capabilities(): Promise<{ offered: boolean }>;
  configure(id: string, modelId: string, auto: boolean): Promise<Conversation>;
  send(conversation: Conversation, text: string, files: MobileAttachment[], signal: AbortSignal,
    progress: (text: string) => void, continuation?: ContinuationTurnContext): Promise<void>;
  upload(file: File): Promise<MobileAttachment>;
  transcribe(clip: Blob, signal?: AbortSignal): Promise<string>;
}
