import { consumeChatStreamCore, type ChatStreamLivenessSink, type ChatStreamProgress } from "@tomverse/chat-core";
import { isSupportedArtifactFormat } from "@/lib/generatedArtifactCore";
export type { ChatStreamLivenessSink, ChatStreamProgress, ChatStreamResult } from "@tomverse/chat-core";

/** Web adapter; the decoder and reader are supplied by the platform. */
export const consumeChatStream = (input: {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  liveness: ChatStreamLivenessSink;
  onProgress: (progress: ChatStreamProgress) => void;
}) => consumeChatStreamCore({ ...input, decoder: new TextDecoder(), isSupportedArtifactFormat });
