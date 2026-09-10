import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * SEC-009. `.gitleaks.toml`'s allowlist is `regexTarget = "line"`, so every
 * pattern in it is a licence to ignore a whole source line. The rule that
 * covered non-secret `*_KEY` constants used to be
 *
 *   [A-Z_]*_KEY\s*=\s*"[A-Za-z0-9._-]+"
 *
 * whose value class is also an exact description of a credential: a line
 * reading `STRIPE_SECRET_KEY = "sk_live_51Hx..."` matched it, so a real key
 * committed in that shape would have been scanned and then silently dropped.
 *
 * This test reads the live config -- not a copy of it -- and pins both
 * directions: the false positives the allowlist exists for stay suppressed,
 * and credential-shaped canaries are not.
 */

const config = readFileSync(new URL("../.gitleaks.toml", import.meta.url), "utf8");

/**
 * Every multi-line-literal pattern in the allowlist, read from the `regexes`
 * marker to the end of the file rather than by matching a bracketed block:
 * the patterns themselves contain `]` (character classes), so a non-greedy
 * `\[...\]` match stops inside the first one and silently reads a single
 * pattern as if it were the whole allowlist.
 */
const allowlistPatterns = () => {
  const marker = config.indexOf("regexes");
  assert.ok(marker >= 0, ".gitleaks.toml must declare an allowlist regexes array");
  const patterns = [...config.slice(marker).matchAll(/'''([\s\S]*?)'''/g)].map(
    (match) => match[1]
  );
  assert.ok(patterns.length > 0, "expected at least one allowlist pattern");
  return patterns.map((pattern) => new RegExp(pattern));
};

const isAllowlisted = (line) =>
  allowlistPatterns().some((pattern) => pattern.test(line));

// The lines the allowlist exists for. Each is a real constant in this repo;
// if one of these starts failing, the allowlist was narrowed too far and the
// scanner will start reporting noise instead of secrets.
const NON_SECRETS = [
  'export const BILLING_PRICE_CATALOG_KEY = "billing.fixed-prices.v1";',
  'const THEME_STORAGE_KEY = "tomverse_theme_preference";',
  'const RECENT_MODEL_STORAGE_KEY = "recent_model_ids";',
  'const GUEST_QUICK_START_ACTIVE_KEY = "tomverse_guest_quick_start_active_v2";',
  'export const ANALYTICS_CONSENT_STORAGE_KEY = "tomverse_analytics_consent_v1";',
  'const GUEST_DEFAULT_MODEL_KEY = "guestDefaultModelId";',
  '  process.env.PERPLEXITY_API_KEY = "test-key";',
  '        apiModel: "claude-haiku-4-5-20251001",',
  '        apiModelId: "mistral-medium-3-5",',
  '  assert.equal(mistral.apiModel, "mistral-medium-3-5");',
  // The two lib/modelPricing.ts profiles that actually tripped gitleaks on
  // PR #356: `apiModelId` had no field rule, so these were scanned as bare
  // high-entropy strings. Pinned by line so the gap cannot reopen the next
  // time a profile is added.
  '        apiModelId: "claude-haiku-4-5-20251001",',
  '        apiModelId: "qwen3.7-plus",',
  // Digest citations in the voice pricing observation records. The first is
  // the line that has been in lib/voiceInputPricing.ts since the register was
  // written; the second is the one that failed PR #1309, identical in shape
  // and reported only because its twelve hex characters happen to be twelve
  // distinct ones. Both are pinned so the pair cannot drift apart again.
  '        "Key sha256:67ad26189fa0, project sha256:35539b590847 (originals in " +',
  '        "Key sha256:1c9f4b0e7a63 (original in the private operations record); " +',
];

// Credential-shaped canaries. None of these is a real secret, but each is
// written in the exact shape a leaked one would take, on a line the old rule
// covered. Assembled from fragments at runtime rather than written out: a
// literal in this file would be a genuine token as far as GitHub's push
// protection is concerned, and it would refuse the push. The assertions run
// against the assembled line, which is what a scanner would actually see in a
// source file.
const credentialLine = (constantName, ...valueParts) =>
  `const ${constantName} = "${valueParts.join("")}";`;

const CANARIES = [
  credentialLine("STRIPE_SECRET_KEY", "sk", "_", "live", "_", "51HxYzAbCdEfGhIjKlMnOpQrStUvWx"),
  credentialLine("OPENAI_API_KEY", "sk", "-", "proj", "-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
  credentialLine("AWS_SECRET_ACCESS_KEY", "wJalr", "XUtnFEMI", "-K7MDENG-bPxRfiCY", "EXAMPLEKEY"),
  credentialLine("ANTHROPIC_API_KEY", "sk", "-", "ant", "-", "api03", "-", "AbCdEf0123456789"),
  credentialLine("NEXTAUTH_SECRET_KEY", "8f14e45fceea167a", "5a36dedd4bea2543"),
  credentialLine("TURNSTILE_SECRET_KEY", "0x4AAAAAAA", "BkMYinukE8nzY", "-UnexpectedSecret"),
  // The digest rule's anchor is the `sha256:` label, and these prove the value
  // class alone never carries it. Both are lowercase hex of exactly the length
  // the rule admits after that label -- 32 and 64 characters -- so if the rule
  // were ever loosened to match bare hex, a real key in the commonest shape a
  // hex secret takes would be scanned and then silently dropped.
  credentialLine(
    "SESSION_SIGNING_KEY",
    "9f2b71c4",
    "e05a38d6",
    "b1e47a90",
    "c3d52f86"
  ),
  credentialLine(
    "WEBHOOK_SIGNING_KEY",
    "4d1a7e93b60c58f2",
    "0e9c3a76d425b8f1",
    "7b52ce80a94d613f",
    "c806af25e71b9d34"
  ),
];

test("the allowlist still suppresses the non-secret constants it exists for", () => {
  for (const line of NON_SECRETS) {
    assert.ok(
      isAllowlisted(line),
      `expected the allowlist to still cover this non-secret line: ${line}`
    );
  }
});

test("the allowlist does not suppress credential-shaped lines", () => {
  for (const line of CANARIES) {
    assert.ok(
      !isAllowlisted(line),
      `allowlist swallowed a credential-shaped canary, so a real leak in the same shape would be hidden: ${line}`
    );
  }
});

test("no allowlist pattern accepts an unconstrained value class", () => {
  // A guard against the specific mistake this test was written for: a value
  // class that admits uppercase *and* digits *and* separators with no other
  // constraint describes every API key format in use.
  const tooBroad = /"\[A-Za-z0-9\._\-\]\+"|"\[A-Za-z0-9\._\-\]\*"/;
  for (const pattern of allowlistPatterns()) {
    if (!/_KEY/.test(pattern.source)) continue;
    assert.ok(
      !tooBroad.test(pattern.source),
      `allowlist pattern is credential-shaped and must be narrowed: ${pattern.source}`
    );
  }
});
