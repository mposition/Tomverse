import assert from "node:assert/strict";
import test from "node:test";

import {
  amuxCapacityWeight,
  amuxResourceRefs,
} from "../lib/amux/resourcePolicyCore.ts";

test("resource locks have a deterministic project/team order", () => {
  assert.deepEqual(
    amuxResourceRefs({ projectKey: "project-b", teamKey: "team-a" }),
    [
      { scope: "project", key: "project-b" },
      { scope: "team", key: "team-a" },
    ],
  );
});

test("capacity score follows the bottleneck and stays bounded", () => {
  assert.equal(amuxCapacityWeight([]), 0);
  assert.equal(amuxCapacityWeight([{ capacity: 10, used: 0 }]), 20);
  assert.equal(amuxCapacityWeight([{ capacity: 10, used: 5 }]), 10);
  assert.equal(
    amuxCapacityWeight([
      { capacity: 10, used: 1 },
      { capacity: 4, used: 4 },
    ]),
    0,
  );
});
