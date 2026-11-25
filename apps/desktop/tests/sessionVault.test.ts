import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodeKeyVault, createSessionVault } from "../src/host/session-vault";

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
