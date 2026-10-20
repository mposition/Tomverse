import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { normalizeCiAdmissionPrivateKey } from "../lib/ciAdmissionGithub.ts";

// GitHub App keys are PKCS#1 ("BEGIN RSA PRIVATE KEY"); a throwaway one per run.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const readable = (text) => createPrivateKey(normalizeCiAdmissionPrivateKey(text)).asymmetricKeyType === "rsa";

test("every way a variable may store the key comes back readable", () => {
  assert.ok(readable(pem), "as downloaded");
  const escaped = pem.replaceAll("\n", "\\n");
  assert.ok(!escaped.includes("\n"), "the escaped form has no real newline left");
  assert.ok(readable(escaped), "literal \\n");
  assert.ok(readable(pem.replaceAll("\n", " ")), "newlines turned into spaces");
  assert.ok(readable(`"${pem}"`), "quoted");
  assert.ok(readable(Buffer.from(pem).toString("base64")), "base64 of the PEM");
  assert.ok(readable(pem.replaceAll("\n", "\r\n")), "CRLF");
});

test("nothing PEM-shaped is no key", () => {
  assert.equal(normalizeCiAdmissionPrivateKey(""), "");
  assert.equal(normalizeCiAdmissionPrivateKey("not a key"), "");
  // The SHA256 fingerprint GitHub lists next to the key is not the key.
  assert.equal(normalizeCiAdmissionPrivateKey("SHA256:Yk3mQ0n8m9vL2c3Jx1kP4rT7wZ5uA6bC8dE0fG2hI4="), "");
});
