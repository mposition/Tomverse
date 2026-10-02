/**
 * What the baseline guard does with a migration `schema.prisma` cannot see.
 *
 * `scripts/baseline-existing-database.mjs` refuses a deploy when migrations are
 * pending *and* the database already matches `schema.prisma` -- the signature of
 * a restore that paired a current schema with an older `_prisma_migrations`.
 * That inference holds only for migrations whose effect `prisma migrate diff`
 * can see. A migration that adds a partial or expression index, a CHECK
 * constraint, a trigger or a function changes nothing the diff compares, so the
 * database "matches" both before and after it is applied, and the guard refused
 * the first such migration to ship on its own (2026-10-02,
 * `20261002120000_marketing_webhook_shadow_event_unique`): an ordinary pending
 * migration read as an already-applied one.
 *
 * The fix is not to stop asking. A migration the diff cannot see may say how to
 * tell whether it is already in place, with one header line:
 *
 *     -- baseline-check: present-if SELECT <one boolean>
 *
 * The guard runs each probe in a read-only transaction. If every pending
 * migration carries one and every probe answers `false`, nothing is in place
 * yet and `migrate deploy` proceeds. Anything else -- a migration without a
 * probe, a probe that answers `true`, `null`, a non-boolean or an error --
 * keeps the old refusal. The probe only ever lets a deploy through when it can
 * prove absence; it never marks anything applied.
 *
 * Pure: no database, no filesystem.
 */

/** One line, a single SELECT, no statement terminator inside it. */
export const PRESENCE_PROBE_PATTERN =
  /^--[ \t]*baseline-check:[ \t]*present-if[ \t]+(SELECT[ \t][^;\r\n]*);?[ \t]*\r?$/im;

/** The probe a migration declares, or null when it declares none. */
export const presenceProbeIn = (sql) => {
  if (typeof sql !== "string") return null;
  const match = PRESENCE_PROBE_PATTERN.exec(sql);
  return match ? match[1].trim() : null;
};

/**
 * Which pending migrations can be probed, and whether that is all of them.
 *
 * `probes` is in the order given; `undeclared` names every migration that
 * carries no probe. Any undeclared migration means the guard cannot prove
 * absence for the set and must refuse as before.
 */
export const pendingProbes = (pending, sqlOf) => {
  const probes = [];
  const undeclared = [];
  for (const name of pending) {
    const probe = presenceProbeIn(sqlOf(name));
    if (probe === null) undeclared.push(name);
    else probes.push({ name, probe });
  }
  return { probes, undeclared };
};

/**
 * The guard's answer once every probe has run.
 *
 * `answers` maps a migration to what its probe returned: `false` means its
 * objects are absent. Only an all-`false` set lets the deploy proceed; `true`,
 * `null`, any non-boolean or a missing answer is treated as "may be present".
 */
export const presenceVerdict = (pending, answers) => {
  const notProvenAbsent = pending.filter((name) => answers.get(name) !== false);
  return notProvenAbsent.length === 0
    ? { proceed: true, notProvenAbsent }
    : { proceed: false, notProvenAbsent };
};
