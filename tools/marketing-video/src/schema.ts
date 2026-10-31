import { z } from "zod";

/**
 * One video, as the job's script writer produces it. The same scene list
 * renders as a short (9:16: Reels, Shorts, TikTok, X) and a long (16:9:
 * YouTube) video; only the frame changes.
 *
 * A scene shows either words on the brand background or a real recording of
 * the product (a Playwright capture: AI-made pictures of the product screen
 * are not allowed, docs/policy/marketing-automation.md §7.3). The caption is
 * what is said during the scene, burned in so the video works muted.
 */
export const sceneSchema = z.object({
  kind: z.enum(["title", "capture", "cta"]),
  /** Large on-screen words. */
  headline: z.string().max(80).optional(),
  /** Smaller line under the headline (title and CTA scenes). */
  subline: z.string().max(120).optional(),
  /** A capture scene's recording or still, as a file name in the props folder or a URL. */
  media: z.string().optional(),
  /** Burned-in caption: the narration for this scene. */
  caption: z.string().max(220).optional(),
  seconds: z.number().min(1).max(60),
});

export const videoSchema = z.object({
  locale: z.enum(["en", "ko", "zh-Hant"]),
  scenes: z.array(sceneSchema).min(1).max(40),
  /** Optional narration audio for the whole video. */
  audio: z.string().optional(),
});

export type Scene = z.infer<typeof sceneSchema>;
export type VideoProps = z.infer<typeof videoSchema>;

export const FPS = 30;
export const totalFrames = (props: VideoProps) =>
  props.scenes.reduce((sum, scene) => sum + Math.round(scene.seconds * FPS), 0);
