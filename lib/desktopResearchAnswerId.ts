import { createHash } from "node:crypto";

export function desktopResearchAnswerId(conversationId: string, sourceId: string) {
  const digest = createHash("sha256").update(JSON.stringify(["desktop-deep-research", conversationId, sourceId]))
    .digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20)}`;
}
