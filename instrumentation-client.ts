import { config } from "zod";

/**
 * Client-side setup that has to happen before anything parses.
 *
 * Zod decides once, lazily, whether it may JIT-compile its validators, and it
 * decides by *trying*:
 *
 *     try { return Function(""), true } catch { return false }
 *
 * This app's CSP does not include `unsafe-eval`, so the browser files a
 * `script-src` / `eval` report every time a page reaches that line — which is
 * every page that constructs a `z.object`, because Zod reads the flag while
 * building the schema, not while parsing. Those reports were the bulk of what
 * Sentry had been collecting (two issues, 56 events in a fortnight). An alarm
 * that fires on a working system is worse than no alarm, because it is the one
 * people learn to scroll past.
 *
 * What the call *did* depended on the deployment. Production runs
 * `CSP_MODE=enforce` — readiness requires it — so it threw and Zod fell back
 * to its interpreted path. Staging runs report-only, so it succeeded and Zod
 * used the JIT. Setting the flag silences both and, as a side effect, stops
 * staging from parsing by a different path than the environment it rehearses.
 *
 * `jitless` is Zod's own answer to exactly this, and it is checked *before*
 * the probe rather than after it, so the `Function("")` call never happens.
 * The CSP is not relaxed and no minified internal is touched: the fallback
 * path Zod was already using is simply chosen on purpose instead of by
 * exception.
 *
 * It must run here rather than beside a schema. The probe's result is memoised
 * on first read, so configuring after any parse configures nothing — Zod's own
 * regression test for this states the contract as "configure at app entry",
 * and instrumentation-client is that entry: Next.js runs it before the
 * application becomes interactive.
 *
 * Server-side parsing is untouched. There is no CSP there, the JIT path is
 * faster, and turning it off everywhere would pay for a browser problem with
 * server latency.
 */
config({ jitless: true });
