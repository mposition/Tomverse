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
  createdAt?: string;
  pendingJobId?: string | null;
};

export type Conversation = {
  id: string;
    title: string;
    projectId?: string | null;
    selectedModels?: string[];
    disabledPanels?: string[];
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
