import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxAnalysisTextSafe } from "./ideaAnalysisChunkCore.ts";
import { amuxContentDigest, openAmuxContent, sealAmuxContent,
  verifyAmuxContentDigest, type AmuxContentKeys } from "./ideaCrypto.ts";

const NODE_ID = /^[A-Za-z0-9_-]{8,80}$/;

export type AmuxNodeText = { title: string; description: string };

function validNodeText(id: string, value: AmuxNodeText): boolean {
  const valid = (text: unknown, max: number, oneLine: boolean): text is string =>
    typeof text === "string" && text.length > 0 && text.trim() === text &&
    text === text.normalize("NFC") && Buffer.byteLength(text, "utf8") <= max &&
    (!oneLine || !/[\t\n]/u.test(text)) && amuxAnalysisTextSafe(text);
  return NODE_ID.test(id) && value !== null && typeof value === "object" &&
    valid(value.title, 200, true) && valid(value.description, 2_000, false);
}

/** The two ciphertexts have distinct AAD, while one keyed digest binds their
 * canonical pair. Neither plaintext is copied to an audit or revision row. */
export function sealAmuxNodeText(id: string, value: AmuxNodeText,
  keys: AmuxContentKeys) {
  if (!validNodeText(id, value)) throw new Error("invalid_node_text");
  const canonical = Buffer.from(amuxCanonicalJson(value), "utf8");
  const title = Buffer.from(value.title, "utf8");
  const description = Buffer.from(value.description, "utf8");
  try {
    const sealedTitle = sealAmuxContent(title, "node_content", `${id}:title`, keys);
    const sealedDescription = sealAmuxContent(description, "node_content",
      `${id}:description`, keys);
    const content = amuxContentDigest(canonical, "node_content", id, keys);
    return { titleCiphertext: sealedTitle.ciphertext,
      descriptionCiphertext: sealedDescription.ciphertext,
      contentKeyId: sealedTitle.keyId, contentKeyVersion: sealedTitle.keyVersion,
      contentDigest: content.digest, contentDigestKeyId: content.digestKeyId };
  } finally { canonical.fill(0); title.fill(0); description.fill(0); }
}

export function openAmuxNodeText(id: string, row: {
  titleCiphertext: Uint8Array | null;
  descriptionCiphertext: Uint8Array | null;
  contentKeyId: string | null;
  contentKeyVersion: number | null;
  contentDigest: string;
  contentDigestKeyId: string;
}, keys: AmuxContentKeys): AmuxNodeText {
  if (!NODE_ID.test(id) || !row.titleCiphertext || !row.descriptionCiphertext ||
      !row.contentKeyId || !row.contentKeyVersion) throw new Error("node_text_unavailable");
  const title = openAmuxContent({ ciphertext: Buffer.from(row.titleCiphertext),
    keyId: row.contentKeyId, keyVersion: row.contentKeyVersion },
  "node_content", `${id}:title`, keys);
  let description: Buffer | null = null;
  try {
    description = openAmuxContent({ ciphertext: Buffer.from(row.descriptionCiphertext),
      keyId: row.contentKeyId, keyVersion: row.contentKeyVersion },
    "node_content", `${id}:description`, keys);
    const value = { title: title.toString("utf8"),
      description: description.toString("utf8") };
    if (!validNodeText(id, value)) throw new Error("node_text_invalid");
    const canonical = Buffer.from(amuxCanonicalJson(value), "utf8");
    try {
      if (!verifyAmuxContentDigest(canonical, "node_content", id,
        row.contentDigest, row.contentDigestKeyId, keys)) {
        throw new Error("node_text_digest_mismatch");
      }
    } finally { canonical.fill(0); }
    return value;
  } finally { title.fill(0); description?.fill(0); }
}
