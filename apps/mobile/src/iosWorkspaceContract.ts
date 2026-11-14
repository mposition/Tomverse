import { Capacitor } from "@capacitor/core";
import type { MobileProduct } from "./WorkspaceNavigation";
import type { ParsedExternalConversation } from "../../../lib/externalImportAdapters/types";

export const isIosWorkspace = Capacitor.getPlatform() === "ios" ||
  (import.meta.env.DEV && import.meta.env.VITE_TOMVERSE_IOS_PREVIEW === "true");

export type IosPanel = "library" | "assistants" | "imports" | "starters";
export type WorkspaceFeatures = { assistantEditing: boolean; assistantKnowledge: boolean; externalImport: boolean };
export type AssistantVersion = { revision: number; instructions: string; models: string[]; toolPolicy: { webSearch: boolean; deepResearch: boolean }; memoryPolicy: { useAccountMemory: boolean }; starters: string[]; knowledgeManifest: Array<{ fileId: string }> };
export type AssistantDetail = { id: string; name: string; currentVersion: AssistantVersion | null; knowledgeFiles: KnowledgeFile[] };
export type KnowledgeFile = { id: string; name: string; processingStatus: string };
export type AssistantInput = { name: string; instructions: string; modelIds: string[]; toolPolicy: AssistantVersion["toolPolicy"]; memoryPolicy: AssistantVersion["memoryPolicy"]; starters: string[]; knowledgeFileIds: string[] };
export type ExternalSnapshot = { id: string; title: string; provider: string; locked: boolean; messageCount: number };
export type ExternalDetail = ExternalSnapshot & { messages: Array<{ id: string; role: string; content: string }> };
export type KnowledgeListing = { files: KnowledgeFile[]; capacity: { limits: { maxFileBytes: number }; remaining: { filesInProfile: number; filesInAccount: number; objectBytes: number }; acceptedMediaTypes: string[] } };
export interface WorkspaceTransport {
  features(): Promise<WorkspaceFeatures>;
  assistant(id: string): Promise<AssistantDetail>;
  createAssistant(input: Pick<AssistantInput, "name" | "instructions" | "modelIds">): Promise<AssistantDetail>;
  saveAssistant(profile: AssistantDetail, input: AssistantInput): Promise<AssistantDetail>;
  knowledge(id: string): Promise<KnowledgeListing>;
  importCapacity(): Promise<{ remaining: import("../../../lib/externalImportWizard").CapacityRemaining }>;
  uploadKnowledge(id: string, file: File): Promise<void>;
  imports(offset?: number): Promise<{ conversations: ExternalSnapshot[]; total: number; continuationEnabled: boolean }>;
  source(id: string): Promise<ExternalDetail>;
  importText(provider: string, selected: ParsedExternalConversation[]): Promise<void>;
  continue(id: string, key: string): Promise<{ conversationId: string }>;
}

/** Setup origin belongs to this navigation attempt, never to a profile or a global default. */
export type AssistantEntry = { product: MobileProduct; panel: IosPanel };
