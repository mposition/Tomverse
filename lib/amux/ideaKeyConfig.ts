import "server-only";

import { timingSafeEqual } from "node:crypto";
import type { AmuxContentKeys } from "./ideaCrypto.ts";

/** App-only encryption keys. Never put these in the Ubuntu CLI supervisor or
 * in a response, audit metadata, log, or child-process environment. This
 * loader handles only the current write key; key rotation/readback is a
 * separate live gate. */
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^[1-9][0-9]{0,9}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/;

const requireKey = (encoded: string | undefined): Buffer => {
  if (!encoded || !BASE64.test(encoded)) {
    throw new Error("AMUX v4 content key configuration is incomplete");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("AMUX v4 content key configuration is incomplete");
  }
  return key;
};

export function loadCurrentAmuxContentKeys(env: Record<string, string | undefined>): AmuxContentKeys {
  const masterKeyId = env.AMUX_V4_CONTENT_MASTER_KEY_ID;
  const digestKeyId = env.AMUX_V4_CONTENT_DIGEST_KEY_ID;
  const versionText = env.AMUX_V4_CONTENT_MASTER_KEY_VERSION;
  if (!masterKeyId || !KEY_ID.test(masterKeyId) || !digestKeyId || !KEY_ID.test(digestKeyId) ||
      !versionText || !VERSION.test(versionText)) {
    throw new Error("AMUX v4 content key configuration is incomplete");
  }
  const masterKeyVersion = Number(versionText);
  if (!Number.isSafeInteger(masterKeyVersion) || masterKeyVersion > 0xffffffff) {
    throw new Error("AMUX v4 content key configuration is incomplete");
  }
  const masterKey = requireKey(env.AMUX_V4_CONTENT_MASTER_KEY_B64);
  const digestKey = requireKey(env.AMUX_V4_CONTENT_DIGEST_KEY_B64);
  if (timingSafeEqual(masterKey, digestKey)) {
    throw new Error("AMUX v4 content key configuration is incomplete");
  }
  return {
    masterKeyId,
    masterKeyVersion,
    masterKey,
    digestKeyId,
    digestKey,
    // Entry routes must preload exact unit keys before opening a product DB
    // transaction. An omitted route cannot fall back to a DB-backup key.
    contentMasters: new Map(),
  };
}
