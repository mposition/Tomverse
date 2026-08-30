import "server-only";

/**
 * Readiness contract for `/api/ready`: a deployment that can run an
 * application-managed web search must be able to bound what it spends doing so.
 *
 * ## What makes it fail
 *
 * Two things, and the pairing is the whole rule.
 *
 * 1. **A configured backend with an unusable budget.** The credential is
 *    present, so requests will go out, and the operational cap that bounds the
 *    vendor's invoice cannot be read. That is an unmetered vendor, which is the
 *    state the provider-budget contract exists to refuse -- same shape, same
 *    answer.
 *
 * 2. **Active search-capable models with no backend at all.** A deployment
 *    whose catalogue offers models that search through a backend, and which
 *    holds no credential for any backend, is one where the product's search
 *    switch is on the screen and cannot work. This is the specific requirement
 *    for the Google models: they are enabled, they are four of the models
 *    people pick, and the whole point of routing them through an
 *    application-managed tool was that they would search.
 *
 * ## Why there is no flag to be off
 *
 * Unlike the image budget, there is no opt-in here. The capability register is
 * compiled in: the moment a build ships with a Google model marked
 * `app-managed`, that is the product's answer, and there is no intermediate
 * state in which the feature is legitimately half-configured. The deploy order
 * is therefore the ordinary one this repository already uses for provider
 * budgets -- environment variables first, code second.
 *
 * The gate is production-only in effect, because
 * `resolveSearchProviderBudget` supplies a development default below the same
 * derived floor production is held to. A developer with no `BRAVE_SEARCH_API_KEY`
 * gets a deployment with no reachable backend and Google models offered as
 * unable to search, which is correct and is not a readiness failure.
 */

import {
  WEB_SEARCH_BACKENDS,
  type WebSearchBackend,
} from "@/lib/webSearchBackends";
import { getWebSearchCapability } from "@/lib/webSearchCapability";
import { AVAILABLE_MODELS } from "@/lib/models";
import {
  resolveSearchProviderBudget,
  type ResolvedSearchProviderBudget,
} from "@/lib/searchProviderBudget";
import {
  listConfiguredWebSearchBackends,
  webSearchFakeBackendRequested,
} from "@/lib/webSearchBackendRuntime";

export type SearchProviderReadinessProblem = {
  code:
    | "no_backend_configured"
    | "budget_unusable"
    | "fake_backend_in_production";
  backend?: WebSearchBackend;
  message: string;
};

export type SearchProviderBudgetReadiness = {
  ready: boolean;
  /** Backends this process holds a credential for. */
  configuredBackends: WebSearchBackend[];
  /** Backends the compiled catalogue's enabled models would search through. */
  requiredBackends: WebSearchBackend[];
  budgets: ResolvedSearchProviderBudget[];
  problems: SearchProviderReadinessProblem[];
};

/**
 * Which backends the *enabled* catalogue actually needs.
 *
 * Enabled models only, on the same rule the image budget applies to a provider
 * whose models are all on hold: a model nobody can select cannot spend, so
 * demanding its backend would block a deploy over spend that cannot happen.
 */
export const requiredWebSearchBackends = (
  models: readonly { id: string; enabled?: boolean; catalogDeleted?: boolean }[] = AVAILABLE_MODELS
): WebSearchBackend[] => {
  const required = new Set<WebSearchBackend>();
  for (const model of models) {
    if (model.enabled === false || model.catalogDeleted === true) continue;
    const capability = getWebSearchCapability(model.id);
    if (capability.support !== "app-managed") continue;
    if (capability.searchBackend) required.add(capability.searchBackend);
  }
  return WEB_SEARCH_BACKENDS.filter((backend) => required.has(backend));
};

export const getSearchProviderBudgetReadiness = (
  env: NodeJS.ProcessEnv = process.env
): SearchProviderBudgetReadiness => {
  const production = env.NODE_ENV === "production";
  const configuredBackends = listConfiguredWebSearchBackends(env);
  const requiredBackends = requiredWebSearchBackends();
  const problems: SearchProviderReadinessProblem[] = [];

  // The fake adapter answers from a local fixture. In production that is not a
  // degraded search, it is invented search results served as though they were
  // the web -- so the variable being set at all is the problem, whether or not
  // `webSearchFakeBackendEnabled` would have honoured it.
  if (production && webSearchFakeBackendRequested(env)) {
    problems.push({
      code: "fake_backend_in_production",
      message:
        "WEB_SEARCH_FAKE_BACKEND is set in production. The deterministic fake serves invented results and must never be reachable outside development and test.",
    });
  }

  const budgets = configuredBackends.map((backend) =>
    resolveSearchProviderBudget(backend, env, { production })
  );
  for (const budget of budgets) {
    if (budget.limits === null) {
      problems.push({
        code: "budget_unusable",
        backend: budget.backend,
        message:
          `${budget.backend} has a configured credential and no usable spend budget: ` +
          budget.problems.map((problem) => problem.message).join(" "),
      });
    }
  }

  // Production only, and the asymmetry is deliberate. In production a missing
  // credential means the product ships a search switch that can never work, and
  // that is worth refusing to start over. In development it means somebody is
  // working on something else: the composer offers no search, the Google models
  // are shown as unable to search, everything downstream is correct, and
  // failing here would make a search API key a precondition for running the
  // application at all. A developer who does want the path exercised sets
  // `WEB_SEARCH_FAKE_BACKEND=1`, which reports every backend as configured.
  if (production) {
    for (const backend of requiredBackends) {
      if (!configuredBackends.includes(backend)) {
        problems.push({
          code: "no_backend_configured",
          backend,
          message:
            `Enabled models search through ${backend}, and this deployment holds no credential for it. ` +
            "Web search would be offered nowhere and refused everywhere.",
        });
      }
    }
  }

  return {
    ready: problems.length === 0,
    configuredBackends,
    requiredBackends,
    budgets,
    problems,
  };
};
