export const STUDIO_TOOLS = [
  { id: "stickers", mobileDescription: "stickersMobile", group: "play", artwork: "stickers", title: "stickersTitle", description: "stickersDescription" },
  { id: "roleplay", mobileDescription: "roleMobile", group: "play", artwork: "role", title: "roleplayTitle", description: "roleplayDescription" },
  { id: "character-quiz", mobileDescription: "quizMobile", shortTitle: "quizShort", group: "play", artwork: "quiz", title: "quizTitleCard", description: "quizDescription" },
  { id: "meme", mobileDescription: "memeMobile", group: "play", artwork: "meme", title: "memeTitle", description: "memeDescription" },
  { id: "illustration", mobileDescription: "illustrationMobile", group: "design", artwork: "illustration", title: "illustrationTitle", description: "illustrationDescription" },
  { id: "caricature", mobileDescription: "caricatureMobile", group: "design", artwork: "caricature", title: "caricatureTitle", description: "caricatureDescription" },
  { id: "transparent-png", mobileDescription: "pngMobile", group: "design", artwork: "cat", title: "pngTitle", description: "pngDescription" },
  { id: "poster", mobileDescription: "posterMobile", shortTitle: "posterShort", group: "design", artwork: "poster", title: "posterTitle", description: "posterDescription" },
] as const;

export type StudioTool = (typeof STUDIO_TOOLS)[number];
export const findStudioTool = (id: string) => STUDIO_TOOLS.find(tool => tool.id === id);

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

export function studioStickerCrop(index: number, width: number, height: number) {
  const column = index % 5;
  const row = Math.floor(index / 5);
  const left = Math.floor(width * column / 5);
  const top = Math.floor(height * row / 4);
  return {
    left, top,
    width: Math.floor(width * (column + 1) / 5) - left,
    height: Math.floor(height * (row + 1) / 4) - top,
  };
}
