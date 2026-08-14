import { expect, test } from "@playwright/test";

/**
 * A request to `/api/*` completes when its body is consumed -- on a 200 and on
 * a 500, whether the page parses the body or throws it away.
 *
 * ## What this is guarding, and what it deliberately is not
 *
 * `/api/*` answers `private, no-store` (lib/apiCacheControlPolicy.ts). What was
 * measured alongside that, on Chromium against a `next start` build at Next
 * 16.3.0: a response whose body is never consumed did not reach
 * `requestfinished`, while the same unconsumed body did under a directive that
 * permits storage. That is a browser observation, not a `Cache-Control`
 * contract and not an explained mechanism -- and note it is never the `fetch()`
 * promise that hangs. That resolves as soon as status and headers arrive; what
 * stays outstanding is the body transfer and the request's own completion,
 * which is exactly what `networkidle` counts and what the desktop UI regression
 * shard ran out its twenty-minute step timeout waiting for.
 *
 * So the four cases below assert the *positive* contract: a consumed body
 * always completes. They deliberately do not assert the negative -- that an
 * unconsumed body never completes -- because that is upstream behaviour this
 * repository does not own, and a Chromium release that drained the body would
 * turn an improvement into a red merge gate. If that happens, the hazard is
 * gone and these four still pass, which is the right outcome for a test whose
 * job is the product's obligation rather than the browser's behaviour.
 *
 * The obligation itself is covered without a browser in
 * tests/discardResponseBody.test.mjs.
 *
 * The 500 is real, not mocked: the E2E server runs against a deliberately
 * unreachable database, so `/api/user/guest-usage` genuinely fails there. A
 * `page.route` fulfilment would be served by Playwright rather than by the
 * network stack and would prove nothing about either.
 */

const CASES = [
  { label: "200", path: "/api/build-info", expectOk: true },
  { label: "500", path: "/api/user/guest-usage", expectOk: false },
] as const;

const CONSUMERS = [
  { label: "parsed", script: "text" },
  { label: "discarded", script: "discard" },
] as const;

for (const responseCase of CASES) {
  for (const consumer of CONSUMERS) {
    test(`a ${responseCase.label} whose body is ${consumer.label} finishes its request`, async ({
      page,
    }) => {
      await page.goto("/");

      const finished = page.waitForEvent("requestfinished", {
        predicate: (request) => request.url().includes(responseCase.path),
        timeout: 20_000,
      });

      const observed = await page.evaluate(
        async ([path, mode]) => {
          const response = await fetch(path, { cache: "no-store" });
          // `discard` is lib/discardResponseBody.ts inlined: the page context
          // cannot import a module, and what matters is that the same body is
          // read and thrown away.
          if (mode === "discard") {
            await response.text().then(
              () => undefined,
              () => undefined
            );
          } else {
            await response.text();
          }
          return {
            status: response.status,
            cacheControl: response.headers.get("cache-control"),
          };
        },
        [responseCase.path, consumer.script] as const
      );

      // The preconditions, asserted rather than assumed. Without `no-store`
      // there is no hazard here and the test would pass for the wrong reason;
      // with the wrong status it would not be covering the case it names.
      expect(observed.cacheControl).toBe("private, no-store");
      expect(observed.status === 200).toBe(responseCase.expectOk);

      const request = await finished;
      expect(request.url()).toContain(responseCase.path);
    });
  }
}
