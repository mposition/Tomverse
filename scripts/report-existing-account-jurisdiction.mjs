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
// ## Output, and what it can and cannot protect
//
// Counts only -- no address, no id, no country. A population below
// `--min-population` is refused without saying how far below, and any bucket
// holding fewer than that many accounts prints as "hidden" rather than its
// count, because a row of one is a person. The floor cannot be set below 5.
//
// Hiding one cell is not enough on its own, and the first version showed why:
// it printed the exact total beside the visible cells, so a single hidden cell
// was simply the total minus the rest -- 78 accounts, 77 in one bucket, and the
// one `jurisdiction_conflict` was recovered by subtraction. So when anything is
// hidden the total is hidden too, and if only one cell would be hidden, the
// next smallest non-empty cell is hidden with it. What can then be worked out
// from outside, even knowing the population, is the sum of the hidden cells
// and not any one of them.
//
// That protects a single run. It does not make two runs safe to compare: the
// people in scope here are the existing accounts, who largely know each other,
// and differencing two populations can still isolate one. So
// `--created-before` takes whole days only -- the granularity an approval
// date actually has -- and the output is for internal use, not for anywhere.
//
// Writes nothing. Exits 0 whatever it finds, 2 on a bad argument.

const json = process.argv.includes("--json");

const argValue = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

// A whole UTC day and nothing finer. `new Date("2026-09-16")` is midnight at
// the start of the day, so an inclusive comparison against it silently dropped
// everybody who signed up later that day while the output claimed the day was
// included. Finer instants are refused as well: they are what lets two runs be
// differenced down to one person, and an approval date has no time of day.
const createdBeforeFlag = process.argv.includes("--created-before");
const createdBeforeArg = argValue("--created-before");
let createdBeforeExclusive = null;
if (createdBeforeFlag) {
  if (!createdBeforeArg || !/^\d{4}-\d{2}-\d{2}$/.test(createdBeforeArg)) {
    console.error("--created-before needs a whole day in the form 2026-09-16.");
    process.exit(2);
  }
  const start = new Date(`${createdBeforeArg}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== createdBeforeArg) {
    console.error(`${createdBeforeArg} is not a real calendar day.`);
    process.exit(2);
  }
  createdBeforeExclusive = new Date(start.getTime() + 86_400_000);
}

const MIN_POPULATION_FLOOR = 5;
const minPopulationArg = argValue("--min-population");
const minPopulation = minPopulationArg === undefined ? 10 : Number(minPopulationArg);
if (!Number.isInteger(minPopulation) || minPopulation < MIN_POPULATION_FLOOR) {
  console.error(
    `--min-population needs a whole number of at least ${MIN_POPULATION_FLOOR}.`
  );
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
//
// The low-confidence bucket is split once more, by asking the same verdict a
// hypothetical: *if* the guessed country were settled, would it be allowed?
// The language-and-timezone guesses include JP and CN, which have no reviewed
// profile, and ES and PT, which are outside the ten, so the S0 IP amendment
// cannot release those. It is **not** a ceiling on what the amendment could
// release, though: an account with no signal at all is released by an IP
// estimate naming one of the ten, and no IP is recorded, so those cannot be
// counted from here.
const bucketFor = (resolved) => {
  const verdict = marketingJurisdictionVerdict(resolved);
  if (verdict.allowed) return "jurisdiction_allows";
  if (verdict.skipReason !== "jurisdiction_unconfirmed") return verdict.skipReason;
  if (resolved.confidence === "high") return "unconfirmed_no_reviewed_profile";
  if (resolved.confidence === "low") {
    return marketingJurisdictionVerdict({ ...resolved, confidence: "high" }).allowed
      ? "unconfirmed_low_guess_allowed_if_settled"
      : "unconfirmed_low_guess_not_allowed_if_settled";
  }
  return "unconfirmed_unknown";
};

const REMEDY = {
  jurisdiction_allows:
    "Jurisdiction would not stop the send. Consent, suppression and the risk_accepted override are decided before this and are not counted here.",
  unconfirmed_unknown:
    "No country signal at all. Released if the person confirms one of the ten allowed countries in the preference centre (section 11.2). What an IP estimate would do cannot be counted: no IP is recorded, and it would release the account only if that country were one of the ten.",
  unconfirmed_low_guess_allowed_if_settled:
    "A language-and-timezone guess naming one of the ten. The S0 IP amendment could release it, provided the IP country -- where it differs from the guess -- is one of the ten as well (draft section 5.3 requires both candidates to pass, not to agree). IP is not recorded, so that cannot be checked here. A confirmed allowed country releases it outright.",
  unconfirmed_low_guess_not_allowed_if_settled:
    "A guess naming a country outside the ten or without a reviewed profile (JP, CN, ES, PT among them). The S0 amendment does not release it; only a confirmed allowed country does.",
  unconfirmed_no_reviewed_profile:
    "A settled, high-confidence country with no reviewed profile. The S0 amendment does not release it (an IP estimate ranks below billing and declaration), and confirming the same country does not either. Declaring one of the ten allowed countries in the preference centre does, if that is where the person lives -- the later declaration outranks the billing country. Otherwise the country needs a reviewed profile, its country-level record and a place in MARKETING_ALLOWED_COUNTRY_CODES; a profile alone only moves it to marketing_country_not_allowed.",
  jurisdiction_conflict:
    "Billing country and declaration disagree. The person confirms which is current.",
  marketing_country_not_allowed:
    "Settled, with a profile, but outside MARKETING_ALLOWED_COUNTRY_CODES. Adding a country needs its own country-level record first.",
};

/**
 * Hide every non-empty cell below the floor, and one more if only one is.
 *
 * Zero stays zero: "nobody is in this state" identifies nobody. A single
 * hidden cell is recoverable from the total and the visible cells, so a second
 * -- the smallest remaining non-empty one -- is hidden with it, and the caller
 * hides the total whenever anything is hidden.
 */
const suppressCells = (rows, floor) => {
  const hide = new Set(
    rows
      .filter((row) => row.accounts > 0 && row.accounts < floor)
      .map((row) => row.bucket)
  );
  if (hide.size === 1) {
    const next = rows
      .filter((row) => row.accounts > 0 && !hide.has(row.bucket))
      .sort((a, b) => a.accounts - b.accounts)[0];
    if (next) hide.add(next.bucket);
  }
  return rows.map((row) =>
    // One neutral word for every hidden cell. "<N" would be false for the
    // complementary cell, which is often the largest one, and a different
    // label for it would say which hidden cell was the small one.
    hide.has(row.bucket) ? { ...row, accounts: "hidden", hidden: true } : row
  );
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
      // Not the exact count. Moving --created-before a day at a time would
      // otherwise difference these sentences into how many people signed up
      // on each day.
      refused: `Fewer than ${minPopulation} accounts in scope (--min-population). At this size a row of the table describes a person, so nothing is printed.`,
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
      // Replaced below when any cell is hidden.
      totalShown: true,
      buckets: suppressCells(
        Object.keys(REMEDY).map((bucket) => ({
          bucket,
          accounts: counts.get(bucket) ?? 0,
          remedy: REMEDY[bucket],
        })),
        minPopulation
      ),
      ...(unexpected.length > 0 ? { unexpectedReasons: unexpected } : {}),
    };
    if (result.buckets.some((row) => row.hidden)) {
      result.total = `at least ${minPopulation}`;
      result.totalShown = false;
    }
    for (const row of result.buckets) delete row.hidden;
  }
} finally {
  await prisma.$disconnect().catch(() => undefined);
}

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.refused) {
  console.log(`Existing-account jurisdiction -- ${result.scope}\n\n  ${result.refused}`);
} else {
  console.log(
    `Existing-account jurisdiction -- ${result.scope}: ${result.total}${
      result.totalShown ? "" : " (hidden, because a cell below is hidden)"
    }`
  );
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
