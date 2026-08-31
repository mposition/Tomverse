// The key envelope, as JSON, for whatever is recording it.
//
// Both the recovery probe and the draw write these parameters beside their
// ciphertext, so they are read from `lib/routerHumanReviewSource.ts` rather
// than retyped into two workflows that could drift apart. A recipient months
// from now needs the parameters and OpenSSL will not supply them: decrypting
// an RSA-OAEP ciphertext under the PKCS#1 v1.5 default returns garbage instead
// of an error, and the failure then surfaces as a bad AES decrypt one step
// later.
//
// Usage:
//   node --import tsx scripts/print-router-key-envelope.mjs [--k=v ...]
//
// Any --k=v pairs are merged in, so a caller can add the fingerprint and the
// run it belongs to without a second file format.

import { KEY_ENVELOPE } from "../lib/routerHumanReviewSource.ts";

const extra = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const at = argument.indexOf("=");
      if (at < 0) {
        console.error(`"${argument}" is not --key=value.`);
        process.exit(1);
      }
      return [argument.slice(2, at), argument.slice(at + 1)];
    })
);

process.stdout.write(`${JSON.stringify({ ...KEY_ENVELOPE, ...extra }, null, 2)}\n`);
