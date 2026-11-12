import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "@/app/api/internal/product-research/scout/memory/[target]/route";
test("memory probes require both switches, the Scout secret and a known synthetic target", async (t) => {
  const key = "fixture-only-scout-secret-value-for-testing";
  const original = process.env;
  process.env = {
    ...original,
    PRODUCT_RESEARCH_SCOUT_ENABLED: "1",
    PRODUCT_RESEARCH_SCOUT_INGEST_SECRET: key,
  };
  t.after(() => {
    process.env = original;
  });
  const call = (target: string, token = key) =>
    POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
      }),
      { params: Promise.resolve({ target }) },
    );
  for (const flag of ["", "0", "false"]) {
    process.env.PRODUCT_RESEARCH_SCOUT_MEMORY_ENABLED = flag;
    assert.equal((await call("en")).status, 404);
  }
  process.env.PRODUCT_RESEARCH_SCOUT_MEMORY_ENABLED = "1";
  assert.equal((await call("en", "wrong")).status, 401);
  assert.equal((await call("user-supplied-subject")).status, 404);
  delete process.env.PRODUCT_RESEARCH_SCOUT_ENABLED;
  assert.equal((await call("ideas")).status, 404);
});
