import type { MobileLanguage } from "./mobile";

const en = {
  revise: "Create a revision", preparing: "Preparing…", failed: "This file could not be prepared. Your draft is unchanged. Try again.",
  nameConflict: "A file with this name is already attached. Remove it before choosing another version.",
  countConflict: "You can attach up to 5 files per message.", textConflict: "Your draft is too long to add this request. Shorten it and try again.",
  officeNotice: "Creates a new file from extracted text. Original formatting, images and slide layouts may change.",
  prompt: "Create a new file from the attached {filename} with the changes below. Keep the original file.",
  officePrompt: "Create a new {filename} from its extracted text with the changes below. Original formatting and images do not need to be preserved. Keep the original file.",
  workbookPrompt: "Create a revised {filename} with the changes below. Preserve its sheets, columns, rows and unchanged cells. Keep the original file.",
  valuesPrompt: "Create a revised {filename} with the changes below. Preserve sheet names, row and column positions, and unchanged cell values. Original widths and layout may change. Keep the original file.",
  versions: "File versions", more: "Earlier versions", source: "Based on", noSource: "No recorded source", unavailable: "Source no longer available", notLoaded: "Source not shown on this page", current: "Current file", use: "Use this version",
};
const copies: Partial<Record<MobileLanguage, typeof en>> = { en };
export const mobileArtifactRevisionCopy = (language: string) => copies[language as MobileLanguage] ?? en;
