import { attachedPickIds } from "../element-comment";
/** The pictures of picked elements, kept in memory only and bounded; the message names an id and the agent asks for the picture. */
export type StoredPick = { mediaType: "image/png" | "image/jpeg"; base64: string; url: string };
/** A stored picture that travels with the instruction naming it (to the worker that runs the task). */
export type PickedPicture = StoredPick & { id: string };
const picks = new Map<string, StoredPick>();
const MAX_STORED_PICKS = 16;
export function rememberPick(id: string, picture: StoredPick) {
  picks.set(id, picture);
  while (picks.size > MAX_STORED_PICKS) picks.delete(picks.keys().next().value as string);
}
export const readPick = (id: string) => picks.get(id);
export const forgetPicks = () => picks.clear();

/** The pictures the instruction says it carries (see attachedPickIds), for the ids that are still stored. */
export function pictureFor(text: string): PickedPicture[] {
  return attachedPickIds(text).flatMap((id) => { const stored = picks.get(id); return stored ? [{ id, ...stored }] : []; });
}
