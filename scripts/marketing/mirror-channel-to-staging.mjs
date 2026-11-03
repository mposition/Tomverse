#!/usr/bin/env node
// Give the Test database a channel row that carries a production channel's id
// (docs/ops/marketing-webhook-production-activation.md, section 4).
//
//   railway run -e staging -s Tomverse -- node --conditions=react-server --import tsx \
//     scripts/marketing/mirror-channel-to-staging.mjs \
//     --channel-id <production channel id> --channel instagram \
//     --account-ref <Zernio account id> --slug instagram-91 [--execute]
//
// A verification record names channels by id and ids differ between
// databases, so an event observed on a Test-only channel can never authorise
// the production channel. The mirror binds the production channel's id and
// Zernio account in staging; staging then records that account's events under
// the id production's apply scope will name.
//
// Dry run by default. Staging only (both signals). It inserts one row in
// `connect_pending`, the only state the insert trigger allows, writes no audit
// entry, and the channel table never lets a row be deleted: decide before
// --execute. Read the production values from Admin > Marketing > Accounts.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { planChannelMirror } from "./webhook-activation-core.mjs";

export async function main(argv, env = process.env) {
  const flag = (name) => argv.flatMap((arg, index) => (arg === `--${name}` && argv[index + 1] ? [argv[index + 1]] : []))[0];
  const { marketingWebhookIsStaging } = await import("../../lib/marketingWebhookCore.ts");
  const { prisma } = await import("../../lib/prisma.ts");
  try {
    const existingChannels = await prisma.marketingChannel.findMany({
      select: { id: true, accountSlug: true, provider: true, externalAccountRef: true },
    });
    const input = {
      channelId: flag("channel-id"),
      channel: flag("channel"),
      accountRef: flag("account-ref"),
      slug: flag("slug"),
    };
    const plan = planChannelMirror({
      ...input,
      existingChannels,
      stagingLabelled: marketingWebhookIsStaging(env),
    });
    console.log(JSON.stringify({ wouldInsert: plan.row, problems: plan.problems }, null, 2));
    if (plan.problems.length > 0) {
      console.error("Refused: nothing was written.");
      return 2;
    }
    if (!argv.includes("--execute")) {
      console.log("Dry run. Add --execute to insert this row (it can never be deleted).");
      return 0;
    }
    await prisma.marketingChannel.create({
      data: {
        ...plan.row,
        scopesDigest: createHash("sha256").update(`mirror:${plan.row.id}`).digest("hex"),
        status: "connect_pending",
      },
    });
    console.log("Inserted.");
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
