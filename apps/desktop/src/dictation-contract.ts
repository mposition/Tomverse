import { z } from "zod";
import { VOICE_CLIP_MAX_BYTES, VOICE_CLIP_MIN_BYTES, voiceClipFormatFor } from "../../../lib/voiceInputFormats";

export const dictationClip = z.object({
  id: z.uuid(),
  mediaType: z.string().max(40).refine((value) => voiceClipFormatFor(value)?.mediaType === value),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength >= VOICE_CLIP_MIN_BYTES && value.byteLength <= VOICE_CLIP_MAX_BYTES),
}).strict();
export type DictationClip = z.infer<typeof dictationClip>;
export type DictationReply = { status: number; transcript?: string; code?: string };
