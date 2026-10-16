import assert from "node:assert/strict";
import test from "node:test";

import { reportMarketingGeneratorIncident } from "@/lib/marketingGeneratorAuth";

const capture = (error) => {
  const lines = [];
  reportMarketingGeneratorIncident("marketing-intel-reports", error, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
};

test("an incident line names the route, the error class and its database code", () => {
  const error = Object.assign(new Error("canceling statement due to lock timeout on \"MarketingReport\""), {
    name: "PrismaClientKnownRequestError",
    code: "P2034",
  });
  assert.deepEqual(capture(error), {
    event: "marketing_generator_route_failed",
    route: "marketing-intel-reports",
    errorName: "PrismaClientKnownRequestError",
    errorCode: "P2034",
  });
});

test("an incident line carries no message, so no internal text reaches the logs from here", () => {
  const line = JSON.stringify(capture(new Error("secret draft words and a table name")));
  assert.equal(line.includes("secret draft words"), false);
  assert.deepEqual(capture("a thrown string"), {
    event: "marketing_generator_route_failed",
    route: "marketing-intel-reports",
    errorName: "string",
    errorCode: null,
  });
});
