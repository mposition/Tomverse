// Where the console's "last recorded slot" comes from.
//
// It used to be the newest success among the rows the table shows, which are
// the newest thirty slots. So thirty failures would hide a success still well
// inside the ninety-day retention: the screen would say the agent had never
// worked and count the silence from the day it was switched on, while the
// maintenance incident -- which asks the whole table -- said something else.
// Two readings of one fact, disagreeing, is worse than either.
//
// Mocked at the module boundary rather than run against a database, because
// what is being pinned is which question is asked, not what Postgres answers.

import assert from "node:assert/strict";
import { mock, test } from "node:test";

const mod = (path: string) => new URL(`../../${path}`, import.meta.url).href;

/** Thirty consecutive failed slots, newest first, ending at the slot just passed. */
const failedRows = (endSlot: Date, count: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    slot: new Date(endSlot.getTime() - index * 24 * 60 * 60 * 1000),
    outcome: "failed",
    failureStage: "clone_failed",
    issueCount: null,
    developSha: null,
    mainSha: null,
    payloadDigest: null,
    submittedAt: new Date(endSlot.getTime() - index * 24 * 60 * 60 * 1000 + 60_000),
  }));

const OLD_SUCCESS = new Date("2026-08-20T21:30:00.000Z");

mock.module(mod("lib/productResearchObservationRouteAuth.ts"), {
  namedExports: { isProductResearchRouteEnabled: () => true },
});
mock.module(mod("lib/productResearchObservationStore.ts"), {
  namedExports: {
    // Unbounded, as the maintenance silence check asks it.
    latestProductResearchSuccess: async () => OLD_SUCCESS,
    readProductResearchEnabledSince: async () => new Date("2026-08-01T00:00:00.000Z"),
  },
});
mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      productResearchObservation: {
        findMany: async ({ take }: { take: number }) =>
          failedRows(new Date("2026-10-09T21:30:00.000Z"), take),
        findUnique: async () => null,
      },
    },
  },
});

test("a run of failures does not hide a success that is still stored", async () => {
  const { readProductResearchConsole } = await import("@/lib/productResearchConsoleRead");
  const view = await readProductResearchConsole(new Date("2026-10-09T23:00:00.000Z"));

  // Every row the table shows is a failure, and the success is older than all
  // of them -- which is exactly the arrangement that used to report nothing.
  assert.equal(view.slots.every((slot) => slot.state !== "ok"), true);
  assert.equal(view.lastSuccessAt, OLD_SUCCESS.toISOString());

  // And the silence verdict counts from that success rather than from the day
  // the switch was seen on, which is what the maintenance incident does.
  assert.equal(view.silence.measuredFrom, "last_success");
});
