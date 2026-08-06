import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  EXPORT_AUDIT_RETENTION_MS,
  EXPORT_TICKET_TOKEN_BYTES,
  EXPORT_TICKET_TTL_MS,
  classifyExportTicketRefusal,
  exportDownloadFilename,
  exportDownloadHeaders,
  exportTicketExpiryFrom,
  exportTicketHashMatches,
  generateExportTicketToken,
  hashExportTicketToken,
} from "../lib/accountDataExportTicketCore.ts";

const SECRET = "test-secret-not-a-real-one";
const at = (iso) => new Date(iso);

test("a token is 256 bits of randomness, url-safe, and never repeats", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const token = generateExportTicketToken();
    assert.match(token, /^[A-Za-z0-9_-]+$/, "the token must survive a URL path unescaped");
    assert.ok(
      Buffer.from(token, "base64url").length === EXPORT_TICKET_TOKEN_BYTES,
      `expected ${EXPORT_TICKET_TOKEN_BYTES} bytes`
    );
    assert.ok(!seen.has(token), "a token repeated");
    seen.add(token);
  }
});

// The stored value must not be usable as a download link, and a database copy
// must not be attackable with a precomputed table.
test("the stored hash is keyed, so it is not a plain digest of the token", () => {
  const token = generateExportTicketToken();
  const hash = hashExportTicketToken(token, SECRET);

  assert.notEqual(hash, token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(
    hash,
    hashExportTicketToken(token, "a-different-secret"),
    "the digest ignores the key"
  );
  assert.equal(hash, hashExportTicketToken(token, SECRET), "hashing is not stable");
});

test("different tokens hash differently under the same key", () => {
  assert.notEqual(
    hashExportTicketToken(generateExportTicketToken(), SECRET),
    hashExportTicketToken(generateExportTicketToken(), SECRET)
  );
});

test("hash comparison is length-safe and exact", () => {
  const hash = hashExportTicketToken("a", SECRET);
  assert.equal(exportTicketHashMatches(hash, hash), true);
  assert.equal(exportTicketHashMatches(hash, hashExportTicketToken("b", SECRET)), false);
  assert.equal(exportTicketHashMatches(hash, ""), false);
  assert.equal(exportTicketHashMatches(hash, `${hash}x`), false);
});

test("a ticket lives five minutes and the audit row ninety days", () => {
  assert.equal(EXPORT_TICKET_TTL_MS, 5 * 60 * 1_000);
  assert.equal(EXPORT_AUDIT_RETENTION_MS, 90 * 24 * 60 * 60 * 1_000);
  assert.equal(
    exportTicketExpiryFrom(at("2026-08-06T10:00:00.000Z")).toISOString(),
    "2026-08-06T10:05:00.000Z"
  );
});

test("a fresh ticket for its own owner is accepted", () => {
  assert.equal(
    classifyExportTicketRefusal({
      ticket: {
        userId: "user-1",
        expiresAt: at("2026-08-06T10:05:00.000Z"),
        consumedAt: null,
      },
      userId: "user-1",
      now: at("2026-08-06T10:00:00.000Z"),
    }),
    null
  );
});

test("an unknown token is refused without a row to blame", () => {
  assert.equal(
    classifyExportTicketRefusal({
      ticket: null,
      userId: "user-1",
      now: at("2026-08-06T10:00:00.000Z"),
    }),
    "unknown_token"
  );
});

// The case the ticket exists for: a link that reached somebody else, presented
// from their own signed-in session.
test("a ticket presented by a different account is refused as wrong_user", () => {
  assert.equal(
    classifyExportTicketRefusal({
      ticket: {
        userId: "user-1",
        expiresAt: at("2026-08-06T10:05:00.000Z"),
        consumedAt: null,
      },
      userId: "user-2",
      now: at("2026-08-06T10:00:00.000Z"),
    }),
    "wrong_user"
  );
});

test("a spent ticket is refused even while it is still inside its window", () => {
  assert.equal(
    classifyExportTicketRefusal({
      ticket: {
        userId: "user-1",
        expiresAt: at("2026-08-06T10:05:00.000Z"),
        consumedAt: at("2026-08-06T10:00:30.000Z"),
      },
      userId: "user-1",
      now: at("2026-08-06T10:01:00.000Z"),
    }),
    "already_used"
  );
});

test("expiry is exclusive at the boundary rather than granting an extra instant", () => {
  const ticket = {
    userId: "user-1",
    expiresAt: at("2026-08-06T10:05:00.000Z"),
    consumedAt: null,
  };
  assert.equal(
    classifyExportTicketRefusal({
      ticket,
      userId: "user-1",
      now: at("2026-08-06T10:04:59.999Z"),
    }),
    null
  );
  assert.equal(
    classifyExportTicketRefusal({ ticket, userId: "user-1", now: at("2026-08-06T10:05:00.000Z") }),
    "expired"
  );
});

// Ownership is checked before the clock: telling a stranger their link expired
// concedes that the link was real.
test("a foreign ticket is wrong_user, not expired, once it has lapsed", () => {
  assert.equal(
    classifyExportTicketRefusal({
      ticket: {
        userId: "user-1",
        expiresAt: at("2026-08-06T10:05:00.000Z"),
        consumedAt: null,
      },
      userId: "user-2",
      now: at("2026-08-06T11:00:00.000Z"),
    }),
    "wrong_user"
  );
});

// no-store rather than no-cache: a shared proxy or a back-forward cache holding
// this document re-serves an account's whole history to whoever is next at the
// machine.
test("the download headers forbid storage, sniffing and referrer leakage", () => {
  const headers = exportDownloadHeaders("tomverse-account-data-2026-08-06.json");

  assert.match(headers["Cache-Control"], /\bno-store\b/);
  assert.match(headers["Cache-Control"], /\bprivate\b/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  // The token sits in the path; any link followed from the rendered file would
  // otherwise carry it in the Referer.
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.match(headers["Content-Disposition"], /^attachment; filename="/);
  assert.match(headers["Content-Type"], /^application\/json/);
});

test("the filename carries a date and no account identifier", () => {
  assert.equal(
    exportDownloadFilename(at("2026-08-06T23:30:00.000Z")),
    "tomverse-account-data-2026-08-06.json"
  );
});

// Route-level guarantees. These are assertions about the two files rather than
// about a running server, but they fail in the pull request that removes one.
const issueRoute = readFileSync(
  new URL("../app/api/user/account/export/route.ts", import.meta.url),
  "utf8"
);
const downloadRoute = readFileSync(
  new URL("../app/api/user/account/export/[token]/route.ts", import.meta.url),
  "utf8"
);

test("issuing a link requires a session, a step-up and a rate limit", () => {
  assert.match(issueRoute, /getServerSession/);
  assert.match(issueRoute, /assertRecentAdminAuthentication/);
  assert.match(issueRoute, /consumeApiRateLimit/);
  assert.match(issueRoute, /status: 428/, "there is no re-authentication path");
});

test("redeeming a link still requires the session, so the token is not a bearer credential", () => {
  assert.match(downloadRoute, /getServerSession/);
  assert.match(downloadRoute, /Authentication required/);
  assert.match(downloadRoute, /redeemAccountDataExportTicket/);
});

test("both routes refuse to be cached, including on their error paths", () => {
  for (const [name, source] of [
    ["issue", issueRoute],
    ["download", downloadRoute],
  ]) {
    const responses = source.match(/status: \d{3}/g) ?? [];
    const noStores = source.match(/"Cache-Control": "no-store"/g) ?? [];
    assert.ok(
      noStores.length >= responses.length,
      `${name} route has ${responses.length} JSON responses but only ${noStores.length} no-store headers`
    );
  }
  // The success path takes its headers from the shared helper, which is pinned
  // by the header test above.
  assert.match(downloadRoute, /exportDownloadHeaders/);
});

test("every refusal returns the same message, whatever the audit recorded", () => {
  const refusals = downloadRoute.match(/code: "EXPORT_LINK_UNUSABLE"/g) ?? [];
  assert.equal(refusals.length, 1, "there is more than one refusal message to compare");
  for (const reason of ["unknown_token", "wrong_user", "already_used", "expired"]) {
    assert.equal(
      downloadRoute.includes(`"${reason}"`),
      false,
      `the ${reason} refusal reason reaches the caller`
    );
  }
});

test("the export is never written to disk", () => {
  for (const source of [issueRoute, downloadRoute]) {
    assert.equal(/writeFile|createWriteStream|node:fs|from "fs"/.test(source), false);
    assert.equal(/s3|S3Client|putObject|uploadTo/.test(source), false);
  }
});

test("the download is audited at both ends, and refusals separately", () => {
  assert.match(issueRoute, /account\.data_export\.request/);
  assert.match(downloadRoute, /account\.data_export\.download/);
  assert.match(downloadRoute, /account\.data_export\.refused/);
});

// BigInt is not JSON-serialisable, and the credit and payment rows carry them.
// Without a replacer the stringify throws after the ticket has already been
// spent, so the user loses both the file and the link.
test("the download serialises BigInt columns instead of throwing on them", () => {
  assert.match(downloadRoute, /typeof value === "bigint"/);
});
