// Says a voice price re-reading is due before the deadline locks the gate.
//
//   npm run notify:voice-price-reverification
//   npm run notify:voice-price-reverification -- --dry-run
//
// ## What this exists for
//
// `check:voice-price-register` fails on the deadline itself, and it runs on
// pull requests. Those two facts together meant the first signal anybody got
// was every pull request turning red on the morning of 2026-12-01 -- a
// correct gate arriving as an outage. Nothing was wrong with the register the
// day before; nobody had been told to act.
//
// So this runs daily and says so early. It is a notifier, not a gate: it
// cannot fail a build, and it is deliberately unable to fix what it reports.
//
// ## What it will not do
//
//   - It does not touch the register. Moving a deadline without re-reading
//     the price is the one repair that repairs nothing, and a script that
//     could do it would eventually be the thing that did.
//   - It does not open issues. The register entry already names a ticket, and
//     that ticket is where the work is tracked; a second place to look is a
//     place to miss.
//   - It does not decide anything. Whether the price is still right is a
//     reading somebody makes against the provider's own page.
//
// ## Why it de-duplicates by reading the thread
//
// A daily cron that missed a day would skip a mark it fired on exactly. So
// the mark is "the largest one this deadline has reached", which every later
// day also resolves to -- and the notice is skipped when the thread already
// carries its marker. Missing a run therefore delays a notice by a day
// instead of losing it, and no state file has to stay in step with GitHub.

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has("--dry-run");

// `--now=YYYY-MM-DD` answers "what goes out on that day", which is the only
// way to see a notice before the deadline is actually near -- and the only way
// a test can drive this script rather than the function underneath it.
// Read-only: it changes what is reported, never what is stored.
const nowArg = argv.find((arg) => arg.startsWith("--now="));
const now = nowArg ? new Date(`${nowArg.slice("--now=".length)}T09:00:00Z`) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error("--now must be a YYYY-MM-DD date.");
  process.exit(1);
}

const { voicePriceReverificationNotices, VOICE_MODEL_PRICE_REGISTER } =
  await import("../lib/voiceInputPricing.ts");

const portSource = readFileSync("lib/voiceTranscriptionPortCore.ts", "utf8");
const defaultMatch = /DEFAULT_VOICE_TRANSCRIPTION_MODEL = "([^"]+)"/.exec(
  portSource
);
if (!defaultMatch) {
  console.error(
    "Could not read DEFAULT_VOICE_TRANSCRIPTION_MODEL from the port."
  );
  process.exit(1);
}
const reachable = new Set([
  defaultMatch[1],
  ...VOICE_MODEL_PRICE_REGISTER.map((entry) => entry.modelId),
]);

const notices = voicePriceReverificationNotices({
  modelIds: [...reachable],
  now,
});

if (notices.length === 0) {
  console.log(
    "No voice price deadline is inside its warning window. Nothing to send."
  );
  process.exit(0);
}

/**
 * One notice per ticket and mark, not per model.
 *
 * Both register entries share a ticket and a deadline today, and two comments
 * saying the same thing on the same thread is how a thread stops being read.
 */
const groups = new Map();
for (const notice of notices) {
  const key = `${notice.ticket}|${notice.reverifyBy}|${notice.thresholdDays}`;
  const group = groups.get(key) ?? {
    ticket: notice.ticket,
    reverifyBy: notice.reverifyBy,
    thresholdDays: notice.thresholdDays,
    daysRemaining: notice.daysRemaining,
    models: [],
  };
  group.models.push(notice);
  groups.set(key, group);
}

const markerFor = (group) =>
  `<!-- voice-price-reverification-notice:${group.reverifyBy}:${group.thresholdDays}d -->`;

const bodyFor = (group) =>
  [
    markerFor(group),
    `**Voice price re-reading due in ${group.daysRemaining} day(s)** — deadline \`${group.reverifyBy}\`.`,
    "",
    "| model | owner | days left |",
    "|---|---|---|",
    ...group.models.map(
      (model) =>
        `| \`${model.modelId}\` | ${model.owner} | ${model.daysRemaining} |`
    ),
    "",
    "On the deadline `check:voice-price-register` starts failing, which is a",
    "PR Fast Gate check — so from that morning every pull request is blocked",
    "until somebody re-reads the price. This notice is the warning window, and",
    "it does not block anything.",
    "",
    "What closes it: re-read the provider's own pricing page, then update the",
    "entry in `lib/voiceInputPricing.ts` with the date it was read and a new",
    "deadline. **Moving the deadline without re-reading the price is the one",
    "repair that repairs nothing**, so nothing automated does it — including",
    "this notice, which can only say that the date is approaching.",
  ].join("\n");

const ticketNumber = (ticket) => {
  const match = /^#(\d+)$/.exec(ticket.trim());
  return match ? match[1] : null;
};

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;

if (dryRun) {
  for (const group of groups.values()) {
    console.log(
      `--- would post to ${group.ticket} (${group.thresholdDays}-day mark) ---`
    );
    console.log(bodyFor(group));
  }
  process.exit(0);
}

if (!token || !repository) {
  console.error(
    "GITHUB_TOKEN and GITHUB_REPOSITORY are required to send a notice.\n" +
      "Run with --dry-run to see what would be sent."
  );
  process.exit(1);
}

const api = async (path, init) => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${init?.method ?? "GET"} ${path} responded ${response.status}`
    );
  }
  return response.json();
};

let sent = 0;
let alreadySent = 0;
let unaddressable = 0;

for (const group of groups.values()) {
  const issue = ticketNumber(group.ticket);
  if (!issue) {
    // The register's own check requires a `#<number>` or a URL, and a URL is
    // not something this can comment on. Reported rather than guessed at.
    console.warn(
      `No issue number in ticket "${group.ticket}" — cannot post a notice there.`
    );
    unaddressable += 1;
    continue;
  }

  const marker = markerFor(group);
  let page = 1;
  let posted = false;
  for (;;) {
    const comments = await api(
      `/repos/${repository}/issues/${issue}/comments?per_page=100&page=${page}`
    );
    if (comments.some((comment) => comment.body?.includes(marker))) {
      posted = true;
      break;
    }
    if (comments.length < 100) break;
    page += 1;
  }
  if (posted) {
    console.log(
      `${group.ticket}: the ${group.thresholdDays}-day notice is already on the thread.`
    );
    alreadySent += 1;
    continue;
  }

  await api(`/repos/${repository}/issues/${issue}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: bodyFor(group) }),
  });
  console.log(
    `${group.ticket}: posted the ${group.thresholdDays}-day notice (${group.daysRemaining} day(s) left).`
  );
  sent += 1;
}

console.log(
  `Voice price re-verification notices: ${sent} sent, ${alreadySent} already on the thread, ${unaddressable} with no issue to post to.`
);
