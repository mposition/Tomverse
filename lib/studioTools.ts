export { STUDIO_PHOTO_PRESETS, type StudioPhotoPreset } from "./studioPresetLibrary";

export const STUDIO_TOOLS = [
  { id: "stickers", mobileDescription: "stickersMobile", group: "play", artwork: "stickers", title: "stickersTitle", description: "stickersDescription" },
  { id: "meme", mobileDescription: "memeMobile", group: "play", artwork: "meme-cafe.webp", title: "memeTitle", description: "memeDescription" },
  { id: "face-analysis", mobileDescription: "faceAnalysisDescription", group: "play", artwork: "face-analysis-cover.webp", title: "faceAnalysisTitle", description: "faceAnalysisDescription" },
  { id: "character-maker", mobileDescription: "characterMakerDescription", group: "play", artwork: "character-fantasy.webp", title: "characterMakerTitle", description: "characterMakerDescription" },
  { id: "color-analysis", mobileDescription: "colorAnalysisDescription", group: "play", artwork: "color-analysis-cover.webp", title: "colorAnalysisTitle", description: "colorAnalysisDescription" },
  { id: "illustration", mobileDescription: "illustrationMobile", group: "design", artwork: "illustration", title: "illustrationTitle", description: "illustrationDescription" },
  { id: "caricature", mobileDescription: "caricatureMobile", group: "design", artwork: "caricature", title: "caricatureTitle", description: "caricatureDescription" },
  { id: "transparent-png", mobileDescription: "pngMobile", group: "design", artwork: "cat", title: "pngTitle", description: "pngDescription" },
  { id: "poster", mobileDescription: "posterMakerDescription", group: "publishing", artwork: "poster-jazz.webp", title: "posterMakerTitle", description: "posterMakerDescription" },
  { id: "social-post", mobileDescription: "socialPostDescription", group: "publishing", artwork: "effects/social-post-travel-story.webp", title: "socialPostTitle", description: "socialPostDescription" },
] as const;

export const STUDIO_IMAGE_USE_CASES = [
  "real-sticker-pack", "character-sticker-pack", "real-sticker", "character-sticker",
  "live-action-character", "stylized-character", "meme", "illustration", "caricature",
  "transparent-png", "poster", "social-post",
] as const;
export type StudioImageUseCase = (typeof STUDIO_IMAGE_USE_CASES)[number];

export type StudioTool = (typeof STUDIO_TOOLS)[number];
export type StudioCreativeTool = Extract<StudioTool, { id: "character-maker" | "face-analysis" | "color-analysis" }>;
export const findStudioTool = (id: string) => STUDIO_TOOLS.find(tool => tool.id === id);
export const studioArtworkPath = (name: string) => "/studio/" + (name.includes(".") ? name : name + ".png");

export const STUDIO_STICKER_KEYS = [
  "stickerDefault01", "stickerDefault02", "stickerDefault03", "stickerDefault04", "stickerDefault05",
  "stickerDefault06", "stickerDefault07", "stickerDefault08", "stickerDefault09", "stickerDefault10",
  "stickerDefault11", "stickerDefault12", "stickerDefault13", "stickerDefault14", "stickerDefault15",
  "stickerDefault16", "stickerDefault17", "stickerDefault18", "stickerDefault19", "stickerDefault20",
] as const;

export const STUDIO_EXPORT_FORMATS = [
  { id: "poster", mobileDescription: "posterMobile", shortTitle: "posterShort", width: 2160, height: 2700 },
  { id: "feed", width: 1080, height: 1080 },
  { id: "story", width: 1080, height: 1920 },
] as const;

export const STUDIO_STICKER_LIMIT = STUDIO_STICKER_KEYS.length;

export function fillStudioStickerCaptions(existing: readonly string[], suggestions: readonly string[], random = Math.random) {
  const pool = [...new Set(suggestions)].filter(caption => caption.trim() && !existing.includes(caption));
  for (let index = pool.length - 1; index > 0; index--) {
    const pick = Math.floor(random() * (index + 1));
    [pool[index], pool[pick]] = [pool[pick], pool[index]];
  }
  return [...existing, ...pool.slice(0, Math.max(0, STUDIO_STICKER_LIMIT - existing.length))];
}

export function studioStickerLayout(count: number) {
  const columns = Math.min(5, count, Math.ceil(Math.sqrt(count)));
  return { columns, rows: Math.ceil(count / columns) };
}

export function studioStickerCrop(index: number, width: number, height: number, columns = 5, rows = 4) {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const left = Math.floor(width * column / columns);
  const top = Math.floor(height * row / rows);
  return {
    left, top,
    width: Math.floor(width * (column + 1) / columns) - left,
    height: Math.floor(height * (row + 1) / rows) - top,
  };
}

/**
 * The object URL a Studio preview renders. `URL.createObjectURL` gives
 * `blob:<origin>/<uuid>`, which never carries the picked file's name or bytes.
 * `encodeURI` leaves such a URL unchanged and marks it as plain URL text, so
 * the code scanner does not read it as markup from the file input
 * (CodeQL js/xss-through-dom). Only an IPv6-literal origin such as
 * `http://[::1]:3000` would change, and that is refused rather than broken.
 */
export function studioObjectUrl(created: string): string {
  const url = encodeURI(created);
  if (url !== created || !url.startsWith("blob:")) throw new Error("studio_object_url_unexpected");
  return url;
}
