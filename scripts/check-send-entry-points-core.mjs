/**
 * Who may put a message on the wire.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.4 (C41),
 * docs/policy/email-notifications.md section 9.8.
 *
 * Every customer-facing send goes through `sendWithAddressLock()`, which takes
 * the address lock, asks suppression again inside it and submits in the same
 * scope. A send made anywhere else skips all three -- and the failure is silent:
 * the message goes out, the recipient is somebody who had withdrawn, and the
 * record says the check was made.
 *
 * So the rule is a file allowlist over the three ways to reach the provider,
 * and the reason each of the five entries is on it is written down beside it.
 *
 * ## Why this is per file, and why that shaped the code
 *
 * A file-level check cannot tell a submission made inside the lock from one
 * made beside it. That is not a weakness to work around -- it is what forced
 * two decisions:
 *
 *  - the lanes hand `sendWithAddressLock()` a *message* rather than a callback,
 *    so they never import an entry point at all;
 *  - the notification queue's operator alerts live in their own module, because
 *    a queue file carrying both kinds could not be allowlisted without also
 *    allowing a customer send in the same file to skip the lock.
 *
 * Pure so tests/checkSendEntryPoints.test.mjs can drive it on strings.
 */

/** The three ways a message reaches the provider. */
export const SEND_ENTRY_POINTS = [
  "deliverEmailOnce",
  "sendTransactionalEmail",
  "emailProvider().send",
];

/**
 * The files allowed to use one, and why each is allowed.
 *
 * Adding an entry is a decision about who may bypass the address lock, so the
 * reason is required and is read by a person, not by this script.
 */
export const SEND_ALLOWLIST = {
  "lib/email.ts":
    "Defines the two entry points. The only place that calls emailProvider().send for them.",
  "lib/emailSendLock.ts":
    "The helper itself: the lock, the suppression re-check and the submission in one scope.",
  "lib/operationalMonitoring.ts":
    "Operator alerts about this system, to our own mailboxes. No customer address is involved.",
  "lib/providerMonitoring.ts":
    "The provider probe. It exists to find out whether sending works at all.",
  "lib/operatorNotificationSend.ts":
    "The notification queue's operator alerts, split out of the queue so the queue itself is not allowlisted.",
  "app/api/admin/test-email/route.ts":
    "The administrator's own diagnostic, to their own address. Suppression here would report a blocked mailbox as a broken configuration (section 7.4, C35).",
};

/** A source file's use of an entry point, if it has one. */
export const sendEntryPointUses = (source) => {
  const used = [];
  for (const name of SEND_ENTRY_POINTS) {
    if (name === "emailProvider().send") {
      // The call, not the import: `emailProvider()` also answers
      // `verifyWebhook`, which every webhook route is entitled to use.
      if (/emailProvider\(\)\s*\.\s*send\b/.test(source)) used.push(name);
      continue;
    }
    // An import of the name, in any of the shapes this repository uses.
    const imported = new RegExp(
      `import\\s*{[^}]*\\b${name}\\b[^}]*}\\s*from\\s*["'][^"']*\\blib/email["']`
    );
    if (imported.test(source)) used.push(name);
  }
  return used;
};

/**
 * Files that reach the provider without being allowed to.
 *
 * `path` is repository-relative with forward slashes, so the answer does not
 * depend on which operating system ran the check.
 */
export const sendEntryPointViolations = (files) =>
  files
    .map((file) => ({ path: file.path, uses: sendEntryPointUses(file.source) }))
    .filter((file) => file.uses.length > 0)
    .filter((file) => !Object.hasOwn(SEND_ALLOWLIST, file.path));

/**
 * Allowlist entries that no longer use an entry point.
 *
 * Reported, not failed: a file may lose its send while the decision that put it
 * on the list still stands. But a list nobody prunes stops describing anything,
 * and the next reader cannot tell which entries are load-bearing.
 */
export const staleAllowlistEntries = (files) => {
  const using = new Set(
    files.filter((file) => sendEntryPointUses(file.source).length > 0).map((f) => f.path)
  );
  return Object.keys(SEND_ALLOWLIST).filter((path) => !using.has(path));
};
