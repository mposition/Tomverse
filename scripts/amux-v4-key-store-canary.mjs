// Explicit staging-only verification of one newly-created synthetic unit key.
// No app DB access, model calls, real bodies, production keys or switch writes.
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAmuxContentUnitKeys, loadAmuxContentUnitKeys,
  deleteAmuxContentUnitKey, amuxContentKeyRing } from "../lib/amux/ideaKeyStore.ts";
import { sealAmuxContent, openAmuxContent } from "../lib/amux/ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "../lib/amux/ideaKeyConfig.ts";

const STAGING_ENVIRONMENT_ID = "9347d760-66f6-430b-8f2f-36fd5dbef333";

export async function verifyStagingKeyCanary({ env = process.env,
  create = createAmuxContentUnitKeys, load = loadAmuxContentUnitKeys,
  remove = deleteAmuxContentUnitKey, onProgress = () => {} } = {}) {
  if (env.RAILWAY_ENVIRONMENT_ID !== STAGING_ENVIRONMENT_ID ||
      env.AMUX_V4_STAGING_KEY_CANARY !== "approved") {
    return { kind: "refused", runtimeActivated: false };
  }
  const ideaId = randomUUID();
  const identity = { ideaId, purpose: "idea_raw", subjectId: ideaId };
  const master = randomBytes(32);
  const digest = randomBytes(32);
  // Ephemeral wrapping keys are not installed in the app. The real key-store
  // connection is used, but the generated object never belongs to an app row.
  const isolatedEnv = { ...env,
    AMUX_V4_CONTENT_MASTER_KEY_ID: "staging-canary-master",
    AMUX_V4_CONTENT_MASTER_KEY_VERSION: "1",
    AMUX_V4_CONTENT_MASTER_KEY_B64: master.toString("base64"),
    AMUX_V4_CONTENT_DIGEST_KEY_ID: "staging-canary-digest",
    AMUX_V4_CONTENT_DIGEST_KEY_B64: digest.toString("base64"),
  };
  let createdKeys;
  let loadedKeys;
  let wrappingKeys;
  let beforeDelete;
  const plain = Buffer.from("AMUX_V4_SYNTHETIC_KEY_DELETION_CANARY", "utf8");
  let result = { kind: "outcome_unknown", canaryId: ideaId,
    mayHaveOrphanKey: true, runtimeActivated: false };
  try {
    // An uncertain PUT may have persisted. Record only the synthetic identity;
    // never blindly retry deletion or conceal the possible orphan from recovery.
    onProgress(result);
    createdKeys = await create(identity, isolatedEnv);
    const backupEnvelope = sealAmuxContent(plain, identity.purpose, ideaId, createdKeys);
    loadedKeys = await load(identity, isolatedEnv);
    beforeDelete = openAmuxContent(backupEnvelope, identity.purpose, ideaId, loadedKeys);
    if (!beforeDelete.equals(plain)) return result;
    // Remove all loaded copies. The retained envelope represents an old DB
    // backup; the wrapping master alone must not reconstruct the deleted key.
    createdKeys.masterKey.fill(0);
    loadedKeys.masterKey.fill(0);
    await remove(identity, isolatedEnv); // Includes HEAD + complete version listing.
    result = { ...result, mayHaveOrphanKey: false };
    onProgress(result);
    try {
      const unexpected = await load(identity, isolatedEnv);
      unexpected.masterKey.fill(0);
      return result;
    } catch (error) {
      if (error?.code !== "missing") return result;
    }
    // Actually attempt to open the retained backup after deletion. A key ring
    // containing only the wrapping master must refuse the now-missing unit;
    // a missing storage read alone is not evidence of envelope-open refusal.
    wrappingKeys = loadCurrentAmuxContentKeys(isolatedEnv);
    try {
      const unexpected = openAmuxContent(backupEnvelope, identity.purpose,
        ideaId, amuxContentKeyRing(wrappingKeys, []));
      unexpected.fill(0);
      return result;
    } catch (error) {
      if (error?.message !== "AMUX content unit key is unavailable") return result;
    }
    // Also test the cryptographic boundary without the missing-coordinate
    // guard: even adopting the envelope's key identity does not let the
    // wrapping master authenticate the unit-key-encrypted backup.
    try {
      const unexpected = openAmuxContent(backupEnvelope, identity.purpose,
        ideaId, { ...wrappingKeys, masterKeyId: backupEnvelope.keyId,
          masterKeyVersion: backupEnvelope.keyVersion, contentMasters: undefined });
      unexpected.fill(0);
      return result;
    } catch (error) {
      if (!/unable to authenticate data/.test(error?.message ?? "")) return result;
    }
    result = { kind: "verified", canaryId: ideaId,
      mayHaveOrphanKey: false,
      readableBeforeDeletion: true, unitKeyMissingAfterDeletion: true,
      oldEnvelopeKeyReloadRefused: true, oldEnvelopeOpenRefused: true,
      oldEnvelopeWrappingMasterOpenRefused: true,
      runtimeActivated: false };
    return result;
  } catch { return result; /* Never retry uncertain PUT/DELETE. */ }
  finally {
    createdKeys?.masterKey.fill(0);
    loadedKeys?.masterKey.fill(0);
    wrappingKeys?.masterKey.fill(0);
    wrappingKeys?.digestKey.fill(0);
    beforeDelete?.fill(0);
    plain.fill(0); master.fill(0); digest.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A hung transport cannot turn this probe into an unbounded local process.
  let progress = { kind: "outcome_unknown", runtimeActivated: false };
  const deadline = setTimeout(() => {
    process.stdout.write(`${JSON.stringify(progress)}\n`);
    process.exit(2);
  }, 30000);
  const result = await verifyStagingKeyCanary({ onProgress: value => { progress = value; } });
  clearTimeout(deadline);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.kind !== "verified") process.exitCode = 2;
}
