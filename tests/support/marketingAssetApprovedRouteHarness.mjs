// Runs the media CLI's approved-asset list route against a stand-in store and
// prints what each scenario answered. Needs --experimental-test-module-mocks
// (tests/marketingAssetApprovedRoute.test.mjs).

import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(path)).href;
const SECRET = "s".repeat(40);

const world = { throws: false, reads: 0 };

mock.module(mod("lib/marketingAssetStore.ts"), {
  namedExports: {
    readApprovedMarketingAssetsForMediaCli: async () => {
      world.reads += 1;
      if (world.throws) throw new Error("database unavailable");
      return [
        {
          id: "media-20261103-review-compare-ko-card",
          kind: "image",
          allowedChannels: ["facebook", "instagram"],
          altLocales: ["ko"],
          validUntil: "2027-02-01",
        },
      ];
    },
  },
});
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });

process.env.MARKETING_MEDIA_SUBMIT_SECRET = SECRET;

const { GET } = await import(mod("app/api/internal/marketing-assets/approved/route.ts"));

const call = async (scenario, setup, { secret = SECRET, killSwitch = "" } = {}) => {
  world.throws = false;
  world.reads = 0;
  setup?.();
  if (killSwitch) process.env.MARKETING_AUTOMATION_KILL_SWITCH = killSwitch;
  else delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;
  const headers = secret === null ? {} : { authorization: `Bearer ${secret}` };
  const response = await GET(new Request("https://tomverse.app/api/internal/marketing-assets/approved", { headers }));
  return {
    scenario,
    status: response.status,
    cache: response.headers.get("cache-control"),
    body: await response.json(),
    reads: world.reads,
  };
};

const results = [
  await call("listed"),
  await call("wrong secret", undefined, { secret: "x".repeat(40) }),
  await call("no secret", undefined, { secret: null }),
  await call("kill switch", undefined, { killSwitch: "on" }),
  await call("store fails", () => {
    world.throws = true;
  }),
];

console.log(`MARKETING_ASSET_APPROVED_RESULTS=${JSON.stringify(results)}`);
