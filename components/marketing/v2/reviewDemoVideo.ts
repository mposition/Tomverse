import type { Language } from "@/lib/language";

/**
 * The answer comparison screen recording, one per site language so the app
 * chrome and the demo answers match the page around them. Korean keeps the
 * original unsuffixed file. Re-recorded with the concept repo's review-capture
 * tool (`node run.mjs --worktree <built checkout> --lang <lang>`).
 */
export function reviewDemoVideo(lang: Language): { src: string; poster: string } {
  const base = `/marketing/v2/review-demo${lang === "ko" ? "" : `-${lang}`}`;
  return { src: `${base}.mp4`, poster: `${base}.jpg` };
}
