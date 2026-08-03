import type { WebSearchExecution } from "@/lib/webSearchExecutionNormalizer";
import type { MessageErrorReportContext } from "@/lib/errorReportContract";

export type ChatAttachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  data?: string;
  objectKey?: string;
  kind: "file" | "text";
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "normal" | "error" | "cancelled" | "pending";
  attachments?: ChatAttachment[];
  modelId?: string;
  errorCode?: string;
  errorHadAttachments?: boolean;
  /**
   * Live-memory error report context for this message's own error: its trace,
   * where that trace came from, and (when the server issued one) the signed
   * error report token. Runtime only -- every serializer in
   * lib/chatMessageSerialization.ts excludes it, so it never reaches
   * localStorage, /api/chat transcripts, imports or sync payloads.
   */
  errorReport?: MessageErrorReportContext;
  createdAt?: string;
  pendingJobId?: string | null;
  searchMetadata?: WebSearchExecution | null;
};

export type Conversation = {
  id: string;
    title: string;
    /**
     * "chat" (default) or "image". Server-decided at creation. An image
     * conversation renders the image workspace instead of the chat panels;
     * chat send, comparison, AI Review, web search, deep research, share and
     * export are all unavailable for it (docs/policy/image-generation.md §1).
     */
    kind?: "chat" | "image";
    projectId?: string | null;
    selectedModels?: string[];
    disabledPanels?: string[];
    webSearchMode?: "off" | "auto" | "always";
    isLocked?: boolean;
    shareEnabled?: boolean;
    shareExpiresAt?: string | null;
    messageCount?: number;
    createdAt?: string;
};

export const MAX_SELECTED_MODELS = 3;

export {
    AVAILABLE_MODELS,
    ENABLED_MODELS,
    PUBLIC_MODELS,
    getEnabledModel,
    getModel,
    getModelUsageProfile,
    isEnabledModelId,
} from "@/lib/models";
export type {
    AiModel,
    AiProvider,
    ModelId,
    ModelStatus,
    ModelTier,
    ModelUsageCategory,
} from "@/lib/models";
