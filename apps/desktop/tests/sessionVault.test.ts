import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodeKeyVault, createSessionVault, createZaiKeyVault, zaiCodingPlanKey } from "../src/host/session-vault";

// A made-up Z.ai key, put together at run time so no credential-shaped literal sits in the source.
const sampleZai = ["zai", "key", "0123456789"].join("-");

const cleartext = { accountId: "account", accessToken: "sensitive-test-token", expiresAt: Date.now() + 120_000 };
const fakeCipher = Buffer.from("v11-test-ciphertext");

test("the vault writes encrypted bytes and restores only an unexpired Desktop session", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "tomverse-session-vault-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "session.dat");
  let saved = "";
  const storage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(input: string) { saved = input; return fakeCipher; },
    async decryptStringAsync(cipher: Buffer) {
      assert.deepEqual(cipher, fakeCipher);
      return { result: saved, shouldReEncrypt: false };
    },
    getSelectedStorageBackend() { return "unknown" as const; },
    isEncryptionAvailable() { return false; },
    encryptString() { throw new Error("Unexpected legacy use"); },
    decryptString() { throw new Error("Unexpected legacy use"); },
  };
  const vault = createSessionVault(path, storage, "win32");
  assert.equal(await vault.save(cleartext), "device");
  assert.deepEqual(await readFile(path), fakeCipher);
  assert.deepEqual(await vault.read(), cleartext);
  assert.equal(await vault.save({ ...cleartext, expiresAt: Date.now() - 1 }), "device");
  assert.equal(await vault.read(), null);
  await vault.clear();
  await assert.rejects(readFile(path), { code: "ENOENT" });
  const firstAccount = createCodeKeyVault(path, storage, "win32", "first");
  const otherAccount = createCodeKeyVault(path, storage, "win32", "second");
  assert.equal(await firstAccount.save({ accountId: "first", key: "sensitive-fixture-key" }), "device");
  assert.equal(await otherAccount.read(), null);
  assert.deepEqual(await firstAccount.read(), { accountId: "first", key: "sensitive-fixture-key" });
});

test("a locked store, unavailable encryption and a Linux fallback keep credentials in the session", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "tomverse-session-fallback-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "session.dat");
  let attempted = 0;
  const storage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync() { attempted++; throw new Error("Keychain is locked"); },
    async decryptStringAsync() { throw new Error("Keychain is locked"); },
    getSelectedStorageBackend(): "basic_text" | "gnome_libsecret" { return "basic_text"; },
    isEncryptionAvailable() { return true; },
    encryptString() { attempted++; return Buffer.from("v10-unprotected-fallback"); },
    decryptString() { throw new Error("Unexpected legacy use"); },
  };
  assert.equal(await createSessionVault(path, storage, "darwin").save(cleartext), "session");
  assert.equal(await createSessionVault(path, storage, "linux").save(cleartext), "session");
  assert.equal(attempted, 1);
  const fallback = { ...storage, getSelectedStorageBackend: () => "gnome_libsecret" as const };
  assert.equal(await createSessionVault(path, fallback, "linux").save(cleartext), "session");
  assert.equal(attempted, 2);
  const unavailable = { ...storage, isAsyncEncryptionAvailable: async () => false };
  assert.equal(await createSessionVault(path, unavailable, "win32").save(cleartext), "session");
  assert.equal(attempted, 2);
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("the Z.ai key is kept encrypted and only a well-formed key is accepted", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "tomverse-zai-vault-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "zai.dat");
  const storage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0x5a)),
    decryptStringAsync: async (value: Buffer) => ({ result: Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString(), shouldReEncrypt: false }),
    getSelectedStorageBackend: () => "unknown", isEncryptionAvailable: () => true,
    encryptString: () => Buffer.alloc(0), decryptString: () => "",
  } as unknown as Parameters<typeof createZaiKeyVault>[1];
  const vault = createZaiKeyVault(path, storage, "win32");
  assert.equal(await vault.save({ key: sampleZai }), "device");
  assert.ok(!(await readFile(path)).toString("utf8").includes(sampleZai), "the file holds no plain key");
  assert.deepEqual(await vault.read(), { key: sampleZai });
  await vault.clear();
  assert.equal(await vault.read(), null);
  assert.equal(zaiCodingPlanKey.safeParse(["0123456789abcdef", "AbCdEf0123456789"].join(".")).success, true, "the <id>.<secret> shape Z.ai issues");
  // No quote or backslash either: a key must read the same in JSON as in the field it was typed into.
  for (const bad of ["", "short", "has space inside", "line\nbreak-0123456789", "x".repeat(513), 'quote"0123456789', "back\\slash0123456789"]) {
    assert.equal(zaiCodingPlanKey.safeParse(bad).success, false, JSON.stringify(bad));
  }
});
