import "server-only";

/**
 * Which search backends *this* deployment can actually reach, and what a turn
 * is allowed to spend at them.
 *
 * The capability register (`lib/webSearchCapability.ts`) is compiled in and
 * identical everywhere. Whether a Brave request can leave this process is a
 * property of one environment: it needs a credential, and it needs an
 * operational budget that is not broken. Those two facts are answered here,
 * once, and every surface that has to agree about them reads this answer --
 * the composer through a server-resolved prop, the model picker through the
 * same prop, preflight and availability and the chat dispatch directly.
 *
 * One function rather than each surface reading `process.env` itself, for the
 * reason `nativeSearchIsDispatchable` exists: when the composer, the estimate,
 * the preflight and the dispatch each decide separately, the first three say
 * yes and only the fourth says no, and the user meets the no after the
 * request has already cost them a turn.
 *
 * ## The key
 *
 * `BRAVE_SEARCH_API_KEY` is read here and nowhere else. It never reaches a
 * client bundle (this module is `server-only`), is never stored in the
 * database, is never written to a log or an error body, and is never checked
 * into a fixture. What crosses to the client is a boolean per backend.
 */

import {
  NO_WEB_SEARCH_BACKENDS,
  WEB_SEARCH_BACKENDS,
  type WebSearchBackend,
  type WebSearchBackendReadiness,
} from "@/lib/webSearchBackends";
import {
  resolveSearchProviderBudget,
  type ResolvedSearchProviderBudget,
} from "@/lib/searchProviderBudget";

/** The secret each backend authenticates with. Read on the server only. */
export const WEB_SEARCH_BACKEND_KEY_ENV: Readonly<
  Record<WebSearchBackend, string>
> = {
  brave: "BRAVE_SEARCH_API_KEY",
};

/**
 * The opt-in that replaces the real backend with a deterministic fake.
 *
 * Explicit, never implied. A fake that could be reached by a *missing* key
 * would make "the key is not set" indistinguishable from "the key works",
 * which is the one thing readiness exists to tell apart -- and a deployment
 * would then answer questions from a fixture while reporting healthy.
 *
 * See `webSearchFakeBackendEnabled` for where it may take effect, and
 * `getSearchProviderBudgetReadiness` for the health gate that refuses a
 * production build carrying it at all.
 */
export const WEB_SEARCH_FAKE_BACKEND_ENV = "WEB_SEARCH_FAKE_BACKEND";

const isProduction = (env: NodeJS.ProcessEnv) => env.NODE_ENV === "production";

const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

/**
 * Whether this process is serving from a loopback address.
 *
 * The same test `lib/e2eTestMode.ts` makes, re-derived here from an injected
 * environment rather than imported, because every function in this module takes
 * its environment as a parameter so the budget and readiness rules can be
 * exercised against a fixed one. An unparseable `NEXTAUTH_URL` is not proof of
 * a local server: fail closed.
 */
const isLoopbackDeployment = (env: NodeJS.ProcessEnv) => {
  const configuredUrl = env.NEXTAUTH_URL?.trim();
  if (!configuredUrl) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(configuredUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/**
 * The Playwright server's full fixture mode: both short-circuits requested, on
 * a loopback origin.
 *
 * `NODE_ENV` cannot be the guard on its own here, and that is not a compromise
 * -- it is the same fact `lib/e2eTestMode.ts` is built around. The E2E server
 * runs `next start`, which sets `NODE_ENV=production`, so a rule of "never in
 * production" would make the fake unreachable in exactly the suite it exists
 * for. A real deployment always has a public `NEXTAUTH_URL`, so this cannot
 * activate there however the variables are set.
 */
const isE2EFixtureEnv = (env: NodeJS.ProcessEnv) =>
  env.E2E_AUTH_BYPASS === "true" &&
  env.E2E_DISABLE_DATABASE === "true" &&
  isLoopbackDeployment(env);

export const webSearchFakeBackendRequested = (
  env: NodeJS.ProcessEnv = process.env
) => env[WEB_SEARCH_FAKE_BACKEND_ENV] === "1";

/**
 * Whether the deterministic fake may stand in for a real backend here.
 *
 * Requested, and either not a production build or the Playwright fixture
 * server. A deployment that set the variable by accident would otherwise serve
 * invented search results as though they were the web -- and
 * `getSearchProviderBudgetReadiness` additionally reports not-ready whenever the
 * variable is set with `NODE_ENV=production`, which is the same belt-and-braces
 * shape `e2eBypassDisabled` gives the auth and database short-circuits.
 */
export const webSearchFakeBackendEnabled = (
  env: NodeJS.ProcessEnv = process.env
) =>
  webSearchFakeBackendRequested(env) &&
  (!isProduction(env) || isE2EFixtureEnv(env));

export const webSearchBackendKeyConfigured = (
  backend: WebSearchBackend,
  env: NodeJS.ProcessEnv = process.env
) => {
  if (webSearchFakeBackendEnabled(env)) return true;
  return Boolean(env[WEB_SEARCH_BACKEND_KEY_ENV[backend]]?.trim());
};

/**
 * The backend key itself, for the adapter that is about to make the call.
 *
 * Returns `null` under the fake, so the adapter cannot accidentally send a
 * request with an empty header and report a 4xx as a backend failure.
 */
export const readWebSearchBackendKey = (
  backend: WebSearchBackend,
  env: NodeJS.ProcessEnv = process.env
): string | null => {
  if (webSearchFakeBackendEnabled(env)) return null;
  const value = env[WEB_SEARCH_BACKEND_KEY_ENV[backend]]?.trim();
  return value ? value : null;
};

/** Every backend this deployment holds a credential for. */
export const listConfiguredWebSearchBackends = (
  env: NodeJS.ProcessEnv = process.env
): WebSearchBackend[] =>
  WEB_SEARCH_BACKENDS.filter((backend) =>
    webSearchBackendKeyConfigured(backend, env)
  );

export type WebSearchBackendStatus = {
  backend: WebSearchBackend;
  keyConfigured: boolean;
  usingFake: boolean;
  budget: ResolvedSearchProviderBudget;
  /** Both halves. This is what every surface must agree on. */
  ready: boolean;
};

/**
 * One backend's full runtime status.
 *
 * A configured key with an unusable budget is *not* ready. That is deliberate
 * and is the direction the credit-and-cost policy asks for: dispatching against
 * a budget that could not be read means the operational cap that bounds this
 * vendor's invoice is not being enforced, and the honest thing to offer the
 * user is a model that does not search rather than a search nobody is counting.
 */
export const getWebSearchBackendStatus = (
  backend: WebSearchBackend,
  env: NodeJS.ProcessEnv = process.env
): WebSearchBackendStatus => {
  const keyConfigured = webSearchBackendKeyConfigured(backend, env);
  const usingFake = webSearchFakeBackendEnabled(env);
  const budget = resolveSearchProviderBudget(backend, env, {
    // Under the fake there is no vendor to bound and no invoice to protect, so
    // demanding a production-shaped budget would make the Playwright server --
    // which runs `next start`, hence `NODE_ENV=production` -- report every
    // model as unable to search. That is the state the search specs exist to
    // stop shipping, so asserting against it would be asserting the opposite of
    // the product.
    production: isProduction(env) && !usingFake,
  });
  return {
    backend,
    keyConfigured,
    usingFake,
    budget,
    ready: keyConfigured && budget.limits !== null,
  };
};

export const listWebSearchBackendStatuses = (
  env: NodeJS.ProcessEnv = process.env
): WebSearchBackendStatus[] =>
  WEB_SEARCH_BACKENDS.map((backend) => getWebSearchBackendStatus(backend, env));

/**
 * The readiness map every surface reads.
 *
 * Frozen and built from scratch each call rather than cached: the environment
 * is read once per process in practice, but a cached map would survive a test
 * changing the environment and would make the failure look like the readiness
 * rule rather than the cache.
 */
export const resolveWebSearchBackendReadiness = (
  env: NodeJS.ProcessEnv = process.env
): WebSearchBackendReadiness => {
  const entries = listWebSearchBackendStatuses(env).filter(
    (status) => status.ready
  );
  if (entries.length === 0) return NO_WEB_SEARCH_BACKENDS;
  return Object.freeze(
    Object.fromEntries(entries.map((status) => [status.backend, true]))
  ) as WebSearchBackendReadiness;
};

/** The enforced spend limits for one backend, or null when it is not ready. */
export const getSearchProviderBudgetLimits = (
  backend: WebSearchBackend,
  env: NodeJS.ProcessEnv = process.env
): { day: number; month: number } | null =>
  getWebSearchBackendStatus(backend, env).budget.limits;
