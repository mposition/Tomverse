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
// `--min-population` (N) is refused without saying how far below, and no
// bucket holding between 1 and N-1 accounts prints its count, because a row of
// one is a person. The floor cannot be set below 5.
//
// Hiding the small cells is not enough, and three versions showed why. The
// population is not a secret -- the draft names 78, and anyone with the
// database can count addresses -- so everything printed is an equation. The
// first version printed the other cells exactly, and a single hidden cell was
// the total minus the rest. The second hid one complementary cell too, and
// 76 visible plus two hidden out of a known 78 made both hidden cells 1. The
// third printed large cells as lower bounds rounded down to a multiple of N,
// and a bound that had *not* been lowered was also a ceiling (bound + N - 1):
// two large cells of 19 printed "at least 10", which with a total of 47 left
// the small cell exactly 9.
//
// The lesson of the third is that any printed value that depends on a large
// cell's count leaks something about it, and through the total, about the
// small ones. So when any cell is small, what is printed depends on each
// cell's **category** only -- zero, "1 to N-1", or "N or more" -- and on the
// total. The table is printed only if every small cell could be N-1 at once
// while every large cell is still N or more:
//
//     total - (small cells) x (N-1) >= (large cells) x N
//
// Then every combination of small counts is consistent with the output and
// the total, because the large cells can absorb any remainder, and nothing
// printed can tell the combinations apart. Otherwise the table is refused like
// a population below the floor. With one large cell its size is still
// readable from the total, to within the small cells' range.
//
// Zero stays zero: "nobody is in this state" identifies nobody.
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
// neither an IP amendment nor confirming the same country does anything; only
// a different, allowed country does (see its remedy).
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
    "No country signal at all. Released if the person confirms one of the ten allowed countries in the preference centre (section 11.2), or by a billing country later recorded in one of the ten. What an IP estimate would do cannot be counted: no IP is recorded, and it would release the account only if that country were one of the ten.",
  unconfirmed_low_guess_allowed_if_settled:
    "A language-and-timezone guess naming one of the ten. The S0 IP amendment could release it, provided the IP country -- where it differs from the guess -- is one of the ten as well (draft section 5.3 requires both candidates to pass, not to agree). IP is not recorded, so that cannot be checked here. A confirmed allowed country releases it outright, and so does a billing country later recorded in one of the ten, which outranks any guess.",
  unconfirmed_low_guess_not_allowed_if_settled:
    "A guess naming a country outside the ten or without a reviewed profile (JP, CN, ES, PT among them). The S0 amendment does not release it. A settled signal naming one of the ten does: the person declaring that country in the preference centre, or a billing country recorded later, which outranks any guess.",
  unconfirmed_no_reviewed_profile:
    "A settled, high-confidence country with no reviewed profile. The S0 amendment does not release it (an IP estimate ranks below billing and declaration), and confirming the same country does not either. Declaring one of the ten allowed countries in the preference centre does, if that is where the person lives -- the later declaration outranks the billing country. Otherwise the country needs a reviewed profile, its country-level record and a place in MARKETING_ALLOWED_COUNTRY_CODES; a profile alone only moves it to marketing_country_not_allowed.",
  jurisdiction_conflict:
    "Billing country and declaration disagree. A confirmation settles which is current, and releases the account only if that country is one of the ten. Confirming any other country moves it to one of two buckets: unconfirmed_no_reviewed_profile if the country has no reviewed profile (JP, for one), marketing_country_not_allowed if it has a profile but is not in the list (IT, NL).",
  marketing_country_not_allowed:
    "Settled, with a profile, but outside MARKETING_ALLOWED_COUNTRY_CODES. Adding a country needs its own country-level record first, and the verdict changes only when the code is added to that list; the record alone changes nothing here.",
};

const UNKNOWN_REMEDY =
  "Not a reason this report knows. marketingJurisdictionVerdict() has grown a case; read it before trusting the table.";

/**
 * The rows as they may be printed beside the exact total, or `null` if no
 * printing leaves the small cells ambiguous.
 *
 * With no small cell, every count is exact. Otherwise each non-zero cell
 * prints only its category -- "1 to N-1" or "N or more" -- so the output is a
 * function of the categories and the total and of nothing else about the
 * counts. It is printed only when
 *
 *     total - (small cells) x (N-1) >= (large cells) x N
 *
 * i.e. every small cell could be N-1 at once and every large cell still N or
 * more. Any smaller small counts leave more for the large cells, which have no
 * ceiling, so every combination of small counts fits the output and the total
 * equally. With no large cell the small cells sum to the total exactly, which
 * is the equation this exists to prevent, so that is refused too.
 */
const coarsenCells = (rows, floor, total) => {
  const small = rows.filter((row) => row.accounts > 0 && row.accounts < floor).length;
  if (small === 0) return rows;
  const large = rows.filter((row) => row.accounts >= floor).length;
  if (large === 0 || total - small * (floor - 1) < large * floor) return null;
  return rows.map((row) => {
    if (row.accounts === 0) return row;
    return {
      ...row,
      accounts: row.accounts >= floor ? `${floor} or more` : `1 to ${floor - 1}`,
    };
  });
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
    // An unknown reason is a row like any other. Left out, its accounts would
    // sit in the total and nowhere else, and the difference would be their
    // exact count.
    const buckets = coarsenCells(
      [...Object.keys(REMEDY), ...unexpected].map((bucket) => ({
        bucket,
        accounts: counts.get(bucket) ?? 0,
        remedy: REMEDY[bucket] ?? UNKNOWN_REMEDY,
      })),
      minPopulation,
      accounts.length
    );
    result = buckets
      ? {
          scope,
          total: accounts.length,
          buckets,
          ...(unexpected.length > 0 ? { unexpectedReasons: unexpected } : {}),
        }
      : {
          scope,
          refused: `Some buckets hold fewer than ${minPopulation} accounts, and the rest are too few to leave those counts ambiguous against the total. At this size a row of the table describes a person, so nothing is printed.`,
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
    console.log(`  ${String(row.accounts).padStart(12)}  ${row.bucket}`);
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
