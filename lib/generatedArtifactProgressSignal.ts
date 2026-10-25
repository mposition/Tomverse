import { splitArtifactProgressSignal as splitProgress } from "@tomverse/chat-core";
import { isSupportedArtifactFormat } from "@/lib/generatedArtifactCore";
export { ARTIFACT_PROGRESS_MARKER, buildArtifactProgressChunk, type ArtifactProgressSignal, type SplitArtifactProgress } from "@tomverse/chat-core";
export const splitArtifactProgressSignal = (raw: string) => splitProgress(raw, isSupportedArtifactFormat);
