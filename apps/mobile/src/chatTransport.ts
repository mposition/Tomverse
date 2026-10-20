export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelId?: string;
  status?: string;
  attachments?: import("../../../components/chat/types").ChatAttachment[];
};
export type Conversation = {
  id: string;
  title: string;
  selectedModels: string[];
  messages: ChatMessage[];
  selectionMode?: string;
  autoSelection?: { offered?: boolean };
  activeAttempt?: boolean;
};
export type ChatSummary = Pick<Conversation, "id" | "title">;
export type MobileAttachment = { uploadId: string; name: string; key: string; mediaType: string; size: number };
export type MobileModel = { id: string; name: string; provider: string; minimumPlan: string };
export interface ChatTransport {
  onSessionLost?(listener: () => void): () => void;
  session(): Promise<boolean>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  list(): Promise<ChatSummary[]>;
  load(id: string): Promise<Conversation>;
  create(): Promise<Conversation>;
  models(): Promise<MobileModel[]>;
  capabilities(): Promise<{ offered: boolean }>;
  configure(id: string, modelId: string, auto: boolean): Promise<Conversation>;
  send(conversation: Conversation, text: string, files: MobileAttachment[], signal: AbortSignal,
    progress: (text: string) => void): Promise<void>;
  upload(file: File): Promise<MobileAttachment>;
  transcribe(clip: Blob, signal?: AbortSignal): Promise<string>;
}
