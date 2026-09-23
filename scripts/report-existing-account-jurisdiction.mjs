// Would jurisdiction stop marketing to existing accounts, and why?
//
//   npm run report:existing-account-jurisdiction
//   npm run report:existing-account-jurisdiction -- --json
//   npm run report:existing-account-jurisdiction -- --created-before 2026-09-16
//
// Contract: docs/policy/email-notifications.md section 6.3, and
// docs/policy/email-product-news-redesign-draft.md sections 5.3 and 5.6.
//
// ## What this counts, and what it does not
//
// It counts **one gate**: the jurisdiction verdict a send asks of each
// recipient. Each account goes through `jurisdictionForUser()` and
// `marketingJurisdictionVerdict()` -- the same two calls the standard lane's
// drain makes -- and nothing here decides anything of its own.
//
// It is **not** a count of who would be mailed, and reading it as one is the
// mistake it is most likely to be used for. The drain checks suppression and
// consent before it ever reaches jurisdiction, and today it has no
// `risk_accepted` branch at all (`lib/standardEmailLane.ts`) -- so an existing
// account with no consent is skipped as `no_consent` and the jurisdiction
// question is never asked. Section 5.6's override is what S9 adds. Until then
// this answers the narrower question the approved contract's section 6.3 turns
// on: *once* an override exists, how many existing accounts would jurisdiction
// still hold, and what would release each of them.
//
// ## Why it exists before anything is built
//
// Section 5.3's IP-estimated country is the core of S8b, and section 6.3 of the
// approved contract says it is not yet a permitted basis -- it is the unfinished
// part of S0, and it would amend sections 6.1, 6.2 and AGENTS.md together.
// Whether that amendment is worth making depends on how many accounts it would
// release. This says so, per reason, before anybody amends a contract to find
// out.
//
// ## Output
//
// Counts only -- no address, no id, no country. A population below
// `--min-population` (default 10) is refused rather than printed, because at
// that size a row of the table describes a person.
//
// Writes nothing. Exits 0 whatever it finds, 2 on a bad argument.

const json = process.argv.includes("--json");

const argValue = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

// A bare date means the whole of that UTC day. `new Date("2026-09-16")` is
// midnight at the start of it, so an inclusive comparison against that instant
// silently dropped everybody who signed up later the same day while the
// output claimed the day was included.
const createdBeforeArg = argValue("--created-before");
let createdBeforeExclusive = null;
if (createdBeforeArg !== undefined) {
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(createdBeforeArg);
  const parsed = new Date(dayOnly ? `${createdBeforeArg}T00:00:00.000Z` : createdBeforeArg);
  if (Number.isNaN(parsed.getTime())) {
    console.error("--created-before needs a date such as 2026-09-16 or an ISO instant.");
    process.exit(2);
  }
  createdBeforeExclusive = dayOnly
    ? new Date(parsed.getTime() + 86_400_000)
    : new Date(parsed.getTime() + 1);
}

const minPopulationArg = argValue("--min-population");
const minPopulation = minPopulationArg === undefined ? 10 : Number(minPopulationArg);
if (!Number.isInteger(minPopulation) || minPopulation < 1) {
  console.error("--min-population needs a positive whole number.");
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

// The three rows of section 6.3's table that share one skip reason are split
// here, because they are released by different things -- and for one of them
// neither the country confirmation nor an IP amendment does anything.
const bucketFor = (resolved) => {
  const verdict = marketingJurisdictionVerdict(resolved);
  if (verdict.allowed) return "jurisdiction_allows";
  if (verdict.skipReason !== "jurisdiction_unconfirmed") return verdict.skipReason;
  if (resolved.confidence === "high") return "unconfirmed_no_reviewed_profile";
  if (resolved.confidence === "low") return "unconfirmed_low_confidence";
  return "unconfirmed_unknown";
};

const REMEDY = {
  jurisdiction_allows:
    "Jurisdiction would not stop the send. Consent, suppression and the risk_accepted override are decided before this and are not counted here.",
  unconfirmed_unknown:
    "No country signal at all. Released by the person confirming a country in the preference centre (section 11.2). An IP estimate would also do it, once the outstanding S0 amendment is approved.",
  unconfirmed_low_confidence:
    "Only a language and timezone guess. Released the same ways as above: a confirmed country, or an IP estimate once S0 allows it.",
  unconfirmed_no_reviewed_profile:
    "A settled, high-confidence country with no reviewed profile. Neither a country confirmation nor the S0 amendment releases it -- confirming the same country leaves the profile empty. It needs that country's profile reviewed and added.",
  jurisdiction_conflict:
    "Billing country and declaration disagree. The person confirms which is current.",
  marketing_country_not_allowed:
    "Settled, with a profile, but outside MARKETING_ALLOWED_COUNTRY_CODES. Adding a country needs its own country-level record first.",
};

let result;
try {
  const accounts = await prisma.user.findMany({
    where: {
      email: { not: null },
      ...(createdBeforeExclusive ? { createdAt: { lt: createdBeforeExclusive } } : {}),
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const scope = createdBeforeArg
    ? `accounts with an address created before ${createdBeforeExclusive.toISOString()} (UTC)`
    : "all accounts with an address";

  if (accounts.length < minPopulation) {
    result = {
      scope,
      refused: `Only ${accounts.length} account(s) in scope, below --min-population ${minPopulation}. At this size a row of the table describes a person, so nothing is printed.`,
    };
  } else {
    const counts = new Map();
    for (const { id } of accounts) {
      const bucket = bucketFor(await jurisdictionForUser({ userId: id }));
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    const unexpected = [...counts.keys()].filter((key) => !(key in REMEDY));
    result = {
      scope,
      total: accounts.length,
      buckets: Object.keys(REMEDY).map((bucket) => ({
        bucket,
        accounts: counts.get(bucket) ?? 0,
        remedy: REMEDY[bucket],
      })),
      ...(unexpected.length > 0 ? { unexpectedReasons: unexpected } : {}),
    };
  }
} finally {
  await prisma.$disconnect().catch(() => undefined);
}

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.refused) {
  console.log(`Existing-account jurisdiction -- ${result.scope}\n\n  ${result.refused}`);
} else {
  console.log(`Existing-account jurisdiction -- ${result.scope}: ${result.total}`);
  console.log("One gate only. This is not a count of who would be mailed.\n");
  for (const row of result.buckets) {
    console.log(`  ${String(row.accounts).padStart(5)}  ${row.bucket}`);
    console.log(`         ${row.remedy}`);
  }
  if (result.unexpectedReasons) {
    console.log(
      `\n  Reasons this report does not know about: ${result.unexpectedReasons.join(", ")}. ` +
        "marketingJurisdictionVerdict() has grown a case; read it before trusting the table."
    );
  }
}

// The Prisma client here is built on an external pg pool that `$disconnect()`
// does not end, so an idle connection would otherwise hold the process open
// for the pool's idle timeout after the answer is already printed.
process.exit(0);
