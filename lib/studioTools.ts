export const STUDIO_TOOLS = [
  { id: "stickers", mobileDescription: "stickersMobile", group: "play", artwork: "stickers", title: "stickersTitle", description: "stickersDescription" },
  { id: "meme", mobileDescription: "memeMobile", group: "play", artwork: "meme", title: "memeTitle", description: "memeDescription" },
  { id: "face-analysis", mobileDescription: "faceAnalysisDescription", group: "play", artwork: "selfie", title: "faceAnalysisTitle", description: "faceAnalysisDescription" },
  { id: "character-maker", mobileDescription: "characterMakerDescription", group: "play", artwork: "character-dream.webp", title: "characterMakerTitle", description: "characterMakerDescription" },
  { id: "color-analysis", mobileDescription: "colorAnalysisDescription", group: "play", artwork: "selfie", title: "colorAnalysisTitle", description: "colorAnalysisDescription" },
  { id: "illustration", mobileDescription: "illustrationMobile", group: "design", artwork: "illustration", title: "illustrationTitle", description: "illustrationDescription" },
  { id: "caricature", mobileDescription: "caricatureMobile", group: "design", artwork: "caricature", title: "caricatureTitle", description: "caricatureDescription" },
  { id: "transparent-png", mobileDescription: "pngMobile", group: "design", artwork: "cat", title: "pngTitle", description: "pngDescription" },
  { id: "poster", mobileDescription: "posterMobile", shortTitle: "posterShort", group: "publishing", artwork: "poster-jazz.webp", title: "posterTitle", description: "posterDescription" },
] as const;

export type StudioTool = (typeof STUDIO_TOOLS)[number];
export type StudioCreativeTool = Extract<StudioTool, { id: "character-maker" | "face-analysis" | "color-analysis" }>;
export const findStudioTool = (id: string) => STUDIO_TOOLS.find(tool => tool.id === id);
export const studioArtworkPath = (name: string) => "/studio/" + (name.includes(".") ? name : name + ".png");

export const STUDIO_PHOTO_PRESETS = [
  { id: "film", tool: "illustration", label: "filmPortrait", artwork: "preset-film.webp", style: "warm analog film photography, with fine grain and natural light" },
  { id: "anime", tool: "illustration", label: "anime", artwork: "preset-anime.webp", style: "hand-drawn cel animation with a hand-painted background" },
  { id: "3d", tool: "illustration", label: "threeDCharacter", artwork: "preset-3d.webp", style: "tactile stylized 3D character render with soft lighting" },
  { id: "watercolor", tool: "illustration", label: "watercolor", artwork: "illustration.png", style: "watercolor illustration" },
  { id: "caricature", tool: "caricature", label: "caricatureTitle", artwork: "caricature.png" },
  { id: "transparent", tool: "transparent-png", label: "pngTitle", artwork: "cat.png" },
] as const;

export type StudioPhotoPreset = (typeof STUDIO_PHOTO_PRESETS)[number];

export const STUDIO_STICKER_KEYS = [
  "stickerDefault01", "stickerDefault02", "stickerDefault03", "stickerDefault04", "stickerDefault05",
  "stickerDefault06", "stickerDefault07", "stickerDefault08", "stickerDefault09", "stickerDefault10",
  "stickerDefault11", "stickerDefault12", "stickerDefault13", "stickerDefault14", "stickerDefault15",
  "stickerDefault16", "stickerDefault17", "stickerDefault18", "stickerDefault19", "stickerDefault20",
] as const;

export const STUDIO_EXPORT_FORMATS = [
  { id: "poster", mobileDescription: "posterMobile", shortTitle: "posterShort", width: 1080, height: 1350 },
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
