/**
 * The raw-query surface `sendWithAddressLock()` needs from a fake Prisma.
 *
 * Contract: docs/policy/email-notifications.md section 9.8.
 *
 * Every customer-facing send takes the address lock before it submits, and that
 * is an advisory lock -- `$executeRaw`, not a model call. A fake client that
 * answers `suppressionCause.findMany` but has no raw surface makes the send
 * throw, and the suite reports "the email did not go" for a reason that has
 * nothing to do with what it is testing.
 *
 * It was two locks until deploy D: the suppression fence went with the setting
 * it fenced. Nothing here changed, because a fake contends with nobody.
 *
 * Shared rather than copied into each fixture: there are four of these, and the
 * next suite to gain a customer-facing send should not have to discover this
 * from a failure.
 */
export const sendLockPrismaStubs = () => ({
  /**
   * Answers `current_setting('lock_timeout')` with a row, because the helper
   * reads the connection's own value to restore it after the locks. Everything
   * else it runs -- `set_config` -- ignores the result.
   */
  $queryRaw: async (strings: TemplateStringsArray | string) => {
    const sql = Array.isArray(strings) ? strings.join("") : String(strings);
    if (sql.includes("current_setting")) return [{ lock_timeout: "0" }];
    return [];
  },
  /** The advisory locks. Nothing contends in a fake, so they always succeed. */
  $executeRaw: async () => 0,
});
