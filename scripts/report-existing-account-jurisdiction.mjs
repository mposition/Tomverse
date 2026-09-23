// How many existing accounts could marketing reach today, and why not the rest?
//
//   npm run report:existing-account-jurisdiction
//   npm run report:existing-account-jurisdiction -- --json
//   npm run report:existing-account-jurisdiction -- --created-before 2026-09-16
//
// Contract: docs/policy/email-notifications.md section 6.3, and
// docs/policy/email-product-news-redesign-draft.md sections 5.3 and 5.6.
//
// The approved contract holds marketing for anybody without a settled,
// reviewed jurisdiction -- and it says in so many words that this includes the
// routes that do not pass through a consent screen, `risk_accepted` among
// them. An IP-estimated country is not yet a permitted basis: that is the part
// of S0 still outstanding, and it would amend sections 6.1 and 6.2 and
// AGENTS.md together.
//
// So the question the announcement actually turns on is not "who is in the
// cohort" but "how many of them have a country the send will accept". This
// answers it, in the send's own vocabulary: each account goes through
// `jurisdictionForUser()` and then `marketingJurisdictionVerdict()`, the two
// functions a send uses. Nothing here decides anything of its own.
//
// Writes nothing. Prints counts only -- no address, no id, no country per
// person -- so the output is safe to paste anywhere. Exits 0 whatever it finds.

const json = process.argv.includes("--json");
const createdBeforeFlag = process.argv.indexOf("--created-before");
const createdBefore =
  createdBeforeFlag >= 0 ? new Date(process.argv[createdBeforeFlag + 1]) : null;
if (createdBefore && Number.isNaN(createdBefore.getTime())) {
  console.error("--created-before needs a date such as 2026-09-16.");
  process.exit(2);
}

if (!process.env.DATABASE_URL?.trim()) {
  const message = "No DATABASE_URL: there are no accounts to count.";
  console.log(json ? JSON.stringify({ note: message }) : message);
  process.exit(0);
}

const { prisma } = await import("../lib/prisma.ts");
const { jurisdictionForUser } = await import("../lib/emailJurisdiction.ts");
const { marketingJurisdictionVerdict } = await import(
  "../lib/emailJurisdictionCore.ts"
);

const accounts = await prisma.user.findMany({
  where: {
    email: { not: null },
    ...(createdBefore ? { createdAt: { lte: createdBefore } } : {}),
  },
  select: { id: true },
  orderBy: { createdAt: "asc" },
});

// What the send would answer, and what would have to change for it to answer
// differently. The second column is the point of the report: each reason has
// a different remedy, and only one of them needs a contract amendment.
const REMEDY = {
  allowed: "Would be mailed.",
  jurisdiction_unconfirmed:
    "No settled country. The approved route is the country confirmation in the preference centre (section 11.2); an IP estimate would need the outstanding S0 amendment.",
  jurisdiction_conflict:
    "Billing country and declaration disagree. The person confirms which is current.",
  marketing_country_not_allowed:
    "Settled, but outside MARKETING_ALLOWED_COUNTRY_CODES. Adding a country needs its own country-level record first.",
};

const counts = new Map();
const byConfidence = new Map();
for (const { id } of accounts) {
  const resolved = await jurisdictionForUser({ userId: id });
  const verdict = marketingJurisdictionVerdict(resolved);
  const key = verdict.allowed ? "allowed" : verdict.skipReason;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  byConfidence.set(
    resolved.confidence,
    (byConfidence.get(resolved.confidence) ?? 0) + 1
  );
}

await prisma.$disconnect();

const rows = Object.keys(REMEDY).map((reason) => ({
  reason,
  accounts: counts.get(reason) ?? 0,
  remedy: REMEDY[reason],
}));
const unexpected = [...counts.keys()].filter((key) => !(key in REMEDY));

const result = {
  scope: createdBefore
    ? `accounts with an address created on or before ${createdBefore.toISOString().slice(0, 10)}`
    : "all accounts with an address",
  total: accounts.length,
  verdicts: rows,
  confidence: Object.fromEntries([...byConfidence.entries()].sort()),
  ...(unexpected.length > 0 ? { unexpectedReasons: unexpected } : {}),
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Existing-account jurisdiction -- ${result.scope}: ${result.total}\n`);
  for (const row of rows) {
    console.log(`  ${String(row.accounts).padStart(5)}  ${row.reason}`);
    console.log(`         ${row.remedy}`);
  }
  console.log("\n  Resolver confidence:");
  for (const [confidence, count] of Object.entries(result.confidence)) {
    console.log(`  ${String(count).padStart(5)}  ${confidence}`);
  }
  if (unexpected.length > 0) {
    console.log(
      `\n  Reasons this report does not know about: ${unexpected.join(", ")}. ` +
        "marketingJurisdictionVerdict() has grown a case; read it before trusting the table."
    );
  }
}
