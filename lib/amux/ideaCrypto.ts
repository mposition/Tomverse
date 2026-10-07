import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** AMUX v4 content categories use separate random data keys per sealed row. */
export type AmuxContentPurpose = "idea_raw" | "source_scope" | "collection_result" | "transfer_payload" | "analysis_result" | "analysis_draft" | "analysis_freeform" | "derivation_confirmation" | "derivation_reason" | "portfolio_assessment" | "portfolio_score" | "node_content" | "card_title" | "card_body" | "card_brief" | "task_result" | "task_patch";

export type AmuxMasterKey = {
  masterKeyId: string;
  masterKeyVersion: number;
  masterKey: Buffer;
  /** Preloaded before a DB transaction. When present, missing coordinates
   * never fall back to the app-wide master. */
  contentMasters?: ReadonlyMap<string, AmuxMasterKey>;
};

export type AmuxDigestKey = {
  digestKeyId: string;
  digestKey: Buffer;
};

export type AmuxContentKeys = AmuxMasterKey & AmuxDigestKey;

export type SealedAmuxContent = {
  ciphertext: Buffer;
  keyId: string;
  keyVersion: number;
  digest: string;
  digestKeyId: string;
};

const MAGIC = Buffer.from("AMX4", "ascii");
const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES + TAG_BYTES + KEY_BYTES + IV_BYTES + TAG_BYTES;
const MAX_CONTENT_BYTES = 1024 * 1024;
const SUBJECT_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PURPOSES: ReadonlySet<string> = new Set<AmuxContentPurpose>([
  "idea_raw", "source_scope", "collection_result", "transfer_payload", "analysis_result", "analysis_draft", "analysis_freeform", "derivation_confirmation", "derivation_reason", "portfolio_assessment", "portfolio_score",
  "node_content", "card_title", "card_body", "card_brief", "task_result", "task_patch",
]);

const assertMaster = (keys: AmuxMasterKey) => {
  if (!KEY_ID.test(keys.masterKeyId) || !Number.isSafeInteger(keys.masterKeyVersion) ||
      keys.masterKeyVersion <= 0 || keys.masterKeyVersion > 0xffffffff ||
      !Buffer.isBuffer(keys.masterKey) || keys.masterKey.length !== KEY_BYTES) {
    throw new Error("AMUX master key configuration is incomplete");
  }
};

const assertDigestKey = (keys: AmuxDigestKey) => {
  if (!KEY_ID.test(keys.digestKeyId) || !Buffer.isBuffer(keys.digestKey) || keys.digestKey.length !== KEY_BYTES) {
    throw new Error("AMUX digest key configuration is incomplete");
  }
};

const aadFor = (purpose: AmuxContentPurpose, subjectId: string): Buffer => {
  if (!PURPOSES.has(purpose)) throw new Error("Invalid AMUX content purpose");
  if (!SUBJECT_ID.test(subjectId)) throw new Error("Invalid AMUX content subject id");
  return Buffer.from(`amux-v4\0${purpose}\0${subjectId}`, "utf8");
};

export const amuxContentKeyCoordinate = (purpose: AmuxContentPurpose,
  subjectId: string): string => {
  aadFor(purpose, subjectId);
  return `${purpose}\0${subjectId}`;
};

const masterFor = (keys: AmuxMasterKey, purpose: AmuxContentPurpose,
  subjectId: string): AmuxMasterKey => {
  const selected = keys.contentMasters?.get(amuxContentKeyCoordinate(purpose, subjectId)) ??
    (keys.contentMasters ? null : keys);
  if (!selected) throw new Error("AMUX content unit key is unavailable");
  assertMaster(selected);
  return selected;
};

const envelopeAadFor = (context: Buffer, keys: AmuxMasterKey): Buffer => {
  const version = Buffer.alloc(4);
  version.writeUInt32BE(keys.masterKeyVersion);
  return Buffer.concat([
    MAGIC, Buffer.from([FORMAT_VERSION]), context, Buffer.from([0]),
    Buffer.from(keys.masterKeyId, "ascii"), Buffer.from([0]), version,
  ]);
};

const digestFor = (plain: Buffer, aad: Buffer, digestKey: Buffer) =>
  createHmac("sha256", digestKey).update(aad).update(Buffer.from([0])).update(plain).digest("hex");

export function amuxContentDigest(
  plain: Buffer,
  purpose: AmuxContentPurpose,
  subjectId: string,
  key: AmuxDigestKey,
): { digest: string; digestKeyId: string } {
  assertDigestKey(key);
  if (!Buffer.isBuffer(plain) || plain.length > MAX_CONTENT_BYTES) {
    throw new Error("AMUX digest content size is invalid");
  }
  return { digest: digestFor(plain, aadFor(purpose, subjectId), key.digestKey),
    digestKeyId: key.digestKeyId };
}

export function sealAmuxContent(
  plain: Buffer,
  purpose: AmuxContentPurpose,
  subjectId: string,
  keys: AmuxContentKeys,
): SealedAmuxContent {
  assertDigestKey(keys);
  if (!Buffer.isBuffer(plain) || plain.length > MAX_CONTENT_BYTES) {
    throw new Error("AMUX content size is invalid");
  }
  const context = aadFor(purpose, subjectId);
  const master = masterFor(keys, purpose, subjectId);
  const envelopeAad = envelopeAadFor(context, master);
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const wrapIv = randomBytes(IV_BYTES);
    const wrap = createCipheriv("aes-256-gcm", master.masterKey, wrapIv, { authTagLength: TAG_BYTES });
    wrap.setAAD(envelopeAad);
    const wrappedKey = Buffer.concat([wrap.update(dataKey), wrap.final()]);
    const wrapTag = wrap.getAuthTag();

    const dataIv = randomBytes(IV_BYTES);
    const data = createCipheriv("aes-256-gcm", dataKey, dataIv, { authTagLength: TAG_BYTES });
    data.setAAD(envelopeAad);
    const encrypted = Buffer.concat([data.update(plain), data.final()]);
    const dataTag = data.getAuthTag();

    return {
      ciphertext: Buffer.concat([
        MAGIC, Buffer.from([FORMAT_VERSION]), wrapIv, wrapTag, wrappedKey,
        dataIv, dataTag, encrypted,
      ]),
      keyId: master.masterKeyId,
      keyVersion: master.masterKeyVersion,
      digest: digestFor(plain, context, keys.digestKey),
      digestKeyId: keys.digestKeyId,
    };
  } finally {
    dataKey.fill(0);
  }
}

export function openAmuxContent(
  sealed: Pick<SealedAmuxContent, "ciphertext" | "keyId" | "keyVersion">,
  purpose: AmuxContentPurpose,
  subjectId: string,
  keys: AmuxMasterKey,
): Buffer {
  const master = masterFor(keys, purpose, subjectId);
  if (sealed.keyId !== master.masterKeyId || sealed.keyVersion !== master.masterKeyVersion ||
      !Buffer.isBuffer(sealed.ciphertext) || sealed.ciphertext.length < HEADER_BYTES ||
      sealed.ciphertext.length > HEADER_BYTES + MAX_CONTENT_BYTES) {
    throw new Error("AMUX content envelope is invalid");
  }
  const bytes = sealed.ciphertext;
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC) || bytes[MAGIC.length] !== FORMAT_VERSION) {
    throw new Error("AMUX content format is unsupported");
  }
  const context = aadFor(purpose, subjectId);
  const envelopeAad = envelopeAadFor(context, master);
  let offset = MAGIC.length + 1;
  const wrapIv = bytes.subarray(offset, offset += IV_BYTES);
  const wrapTag = bytes.subarray(offset, offset += TAG_BYTES);
  const wrappedKey = bytes.subarray(offset, offset += KEY_BYTES);
  const dataIv = bytes.subarray(offset, offset += IV_BYTES);
  const dataTag = bytes.subarray(offset, offset += TAG_BYTES);
  const encrypted = bytes.subarray(offset);

  const unwrap = createDecipheriv("aes-256-gcm", master.masterKey, wrapIv, { authTagLength: TAG_BYTES });
  unwrap.setAAD(envelopeAad);
  unwrap.setAuthTag(wrapTag);
  const dataKey = Buffer.concat([unwrap.update(wrappedKey), unwrap.final()]);
  try {
    const data = createDecipheriv("aes-256-gcm", dataKey, dataIv, { authTagLength: TAG_BYTES });
    data.setAAD(envelopeAad);
    data.setAuthTag(dataTag);
    return Buffer.concat([data.update(encrypted), data.final()]);
  } finally {
    dataKey.fill(0);
  }
}

/** Call this at an approval/digest boundary, not as a prerequisite for
 * decrypting a retained ciphertext under an independently rotated master. */
export function verifyAmuxContentDigest(
  plain: Buffer,
  purpose: AmuxContentPurpose,
  subjectId: string,
  expectedDigest: string,
  expectedDigestKeyId: string,
  key: AmuxDigestKey,
): boolean {
  assertDigestKey(key);
  if (!Buffer.isBuffer(plain) || plain.length > MAX_CONTENT_BYTES ||
      expectedDigestKeyId !== key.digestKeyId || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    return false;
  }
  const context = aadFor(purpose, subjectId);
  const actual = Buffer.from(digestFor(plain, context, key.digestKey), "hex");
  return timingSafeEqual(actual, Buffer.from(expectedDigest, "hex"));
}
