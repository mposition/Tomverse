/** The pictures of picked elements, kept in memory only and bounded; the message names an id and the agent asks for the picture. */
const picks = new Map<string, { mediaType: "image/png" | "image/jpeg"; base64: string; url: string }>();
const MAX_STORED_PICKS = 16;
export function rememberPick(id: string, picture: { mediaType: "image/png" | "image/jpeg"; base64: string; url: string }) {
  picks.set(id, picture);
  while (picks.size > MAX_STORED_PICKS) picks.delete(picks.keys().next().value as string);
}
export const readPick = (id: string) => picks.get(id);
export const forgetPicks = () => picks.clear();
