// Is this API key allowed to see these models?
//
//   npm run check:openai-model-access
//   npm run check:openai-model-access -- --json
//   npm run check:openai-model-access -- --invoke --i-accept-the-cost
//
// That is the entire question. `GET /v1/models` answers visibility per
// project/key and returns **no pricing at all**, so nothing here confirms,
// contradicts or verifies a price. Prices come from the provider's published
// pricing pages and live in lib/modelPricing.ts with a `priceSource` naming
// which one. A run of this script is not evidence about cost, and a report
// that cites it as such is citing the wrong thing.
//
// Default mode is a single read: one GET, no completion, no tokens, no
// charge. `--invoke` additionally sends the smallest Responses request that
// can prove the model answers, and refuses to do it without an explicit
// second flag because it is the only part of this script that spends money.
//
// Nothing is written anywhere. No database, no registry, no artefacts.

import { MODEL_PRICING } from "../lib/modelPricing.ts";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const json = has("--json");
const invoke = has("--invoke");
const accepted = has("--i-accept-the-cost");

// The two models under observation while Luna is the default and 5.4 mini is
// the baseline it is compared against. Read from the pricing registry rather
// than hardcoded, so a slug rename cannot leave this checking a model nobody
// calls any more.
const TARGET_MODEL_IDS = ["gpt-5-6-luna", "gpt-5-4-mini"];
const targets = TARGET_MODEL_IDS.map((modelId) => {
  const profile = MODEL_PRICING.find((entry) => entry.modelId === modelId);
  if (!profile) {
    console.error(
      `${modelId} has no pricing profile, so its provider slug is unknown. Add it to lib/modelPricing.ts first.`
    );
    process.exit(1);
  }
  return { modelId, apiModelId: profile.apiModelId, profile };
});

const apiKey = process.env.OPENAI_API_KEY?.trim();
const baseUrl = (
  process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1"
).replace(/\/+$/, "");

/**
 * Everything that leaves this process goes through here.
 *
 * An OpenAI key is `sk-`-prefixed and turns up in echoed request headers, in
 * proxy error bodies and in some SDK error messages. The response body is
 * redacted wholesale rather than selectively: this output is meant to be
 * pasted into an operational ticket, and a project or organisation id is not
 * something to publish on the way to answering "can the key see the model".
 */
const redact = (text) =>
  String(text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted-api-key]")
    .replace(/\b(org|proj)-[A-Za-z0-9_-]{6,}/g, "[redacted-$1-id]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");

const summariseBody = (text) => {
  const redacted = redact(text).replace(/\s+/g, " ").trim();
  return redacted.length > 200 ? `${redacted.slice(0, 200)}...` : redacted;
};

/**
 * Failure modes kept apart, because they mean different things to whoever is
 * reading the report and only one of them is about the model.
 */
const classify = (status) => {
  if (status === 401) {
    return {
      code: "unauthenticated",
      detail: "The key was rejected. This says nothing about the models.",
    };
  }
  if (status === 403) {
    return {
      code: "forbidden",
      detail:
        "The key authenticated but is not permitted here -- project scope, org policy, or an egress proxy in front of the API.",
    };
  }
  if (status === 404) {
    return {
      code: "not_found",
      detail:
        "The endpoint or model is not visible to this key. For a model, that is the answer; for /v1/models, the base URL is wrong.",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      detail: "Rate limited or out of quota. Visibility is undetermined -- retry later.",
    };
  }
  if (status >= 500) {
    return { code: "provider_error", detail: `Provider returned ${status}.` };
  }
  return { code: `http_${status}`, detail: `Unexpected status ${status}.` };
};

const request = async (path, init) => {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    // A DNS failure, a TLS rejection and a timeout are all "we never got an
    // answer", which is a different report line from "the provider said no".
    return {
      ok: false,
      status: 0,
      text: "",
      networkError: redact(error?.message || String(error)).slice(0, 200),
    };
  }
};

const result = {
  checkedAt: new Date().toISOString(),
  baseUrl,
  mode: invoke ? "list+invoke" : "list",
  isPriceEvidence: false,
  note: "GET /v1/models reports per-key model visibility and returns no pricing. It is not a price source.",
  listing: null,
  models: [],
};

if (!apiKey) {
  result.listing = {
    ok: false,
    code: "no_api_key",
    detail:
      "OPENAI_API_KEY is not set, so visibility could not be checked at all. This is not evidence that the models are unavailable.",
  };
} else {
  const listing = await request("/models", { method: "GET" });
  if (listing.networkError !== undefined) {
    result.listing = {
      ok: false,
      code: "network_error",
      detail: `No response from ${baseUrl}: ${listing.networkError}`,
    };
  } else if (!listing.ok) {
    const classified = classify(listing.status);
    result.listing = {
      ok: false,
      status: listing.status,
      ...classified,
      body: summariseBody(listing.text),
    };
  } else {
    let ids = [];
    try {
      const parsed = JSON.parse(listing.text);
      ids = Array.isArray(parsed?.data)
        ? parsed.data.map((entry) => entry?.id).filter((id) => typeof id === "string")
        : [];
    } catch {
      result.listing = {
        ok: false,
        code: "unparseable_response",
        detail: "GET /v1/models returned a body that is not JSON.",
      };
    }
    if (result.listing === null) {
      result.listing = { ok: true, status: 200, modelCount: ids.length };
      for (const target of targets) {
        // Exact id first, then a dated snapshot prefix: OpenAI serves
        // `gpt-5.4-mini` and `gpt-5.4-mini-2026-03-17` alongside each other,
        // and a key that can see only the pinned snapshot can still be called
        // -- with a different slug, which is worth reporting rather than
        // flattening into "visible".
        const exact = ids.includes(target.apiModelId);
        const snapshots = ids.filter(
          (id) => id !== target.apiModelId && id.startsWith(`${target.apiModelId}-`)
        );
        result.models.push({
          modelId: target.modelId,
          apiModelId: target.apiModelId,
          visible: exact,
          snapshotIds: snapshots,
          pricingVersion: target.profile.pricingVersion,
          priceSource: target.profile.priceSource,
          priceSourceIsThisCheck: false,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Optional: prove the model answers, not just that it is listed.
// ---------------------------------------------------------------------------
if (invoke) {
  // Worst case for one request per model, from the registry's own rates:
  // the whole prompt uncached, and the full output allowance spent. Real cost
  // is far below this; the point of showing it is that nobody opts in to an
  // unbounded number.
  const MAX_OUTPUT_TOKENS = 16;
  const PROMPT_TOKENS = 8;
  const estimate = targets.reduce((sum, target) => {
    const tier = target.profile.tiers[0];
    return (
      sum +
      (PROMPT_TOKENS * tier.inputUsdPerMillionTokens +
        MAX_OUTPUT_TOKENS * tier.outputUsdPerMillionTokens) /
        1_000_000
    );
  }, 0);

  result.invocation = {
    estimatedMaxCostUsd: Number(estimate.toFixed(8)),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    requestCount: targets.length,
  };

  if (!accepted) {
    result.invocation.skipped = true;
    result.invocation.reason =
      `--invoke sends a real, billed request to each model (at most about US$${estimate.toFixed(8)} in total). ` +
      "Re-run with --i-accept-the-cost to allow it.";
  } else if (!apiKey) {
    result.invocation.skipped = true;
    result.invocation.reason = "OPENAI_API_KEY is not set.";
  } else {
    result.invocation.skipped = false;
    result.invocation.results = [];
    for (const target of targets) {
      const response = await request("/responses", {
        method: "POST",
        body: JSON.stringify({
          model: target.apiModelId,
          input: "Reply with the single word: ok",
          max_output_tokens: MAX_OUTPUT_TOKENS,
        }),
      });
      if (response.networkError !== undefined) {
        result.invocation.results.push({
          modelId: target.modelId,
          ok: false,
          code: "network_error",
          detail: response.networkError,
        });
        continue;
      }
      if (!response.ok) {
        result.invocation.results.push({
          modelId: target.modelId,
          ok: false,
          status: response.status,
          ...classify(response.status),
          body: summariseBody(response.text),
        });
        continue;
      }
      let serviceTier = null;
      let usage = null;
      try {
        const parsed = JSON.parse(response.text);
        // Worth capturing precisely because an omitted request-side
        // `service_tier` defaults to `auto`: the tier the response came back
        // on is the only way to know Standard pricing was the right table.
        serviceTier = parsed?.service_tier ?? null;
        usage = parsed?.usage
          ? {
              inputTokens: parsed.usage.input_tokens ?? null,
              outputTokens: parsed.usage.output_tokens ?? null,
            }
          : null;
      } catch {
        // A successful status with an unreadable body still proves the call
        // was accepted, which is what --invoke was asked to establish.
      }
      result.invocation.results.push({
        modelId: target.modelId,
        ok: true,
        respondedServiceTier: serviceTier,
        usage,
      });
    }
  }
}

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("OpenAI model access check\n");
  console.log(`  base URL:  ${result.baseUrl}`);
  console.log(`  checked:   ${result.checkedAt}`);
  console.log(`  ${result.note}\n`);

  if (result.listing?.ok) {
    console.log(`  GET /v1/models  200, ${result.listing.modelCount} model(s) visible\n`);
    for (const model of result.models) {
      console.log(
        `  ${model.modelId.padEnd(16)} ${model.apiModelId.padEnd(18)} ` +
          `visible=${model.visible}` +
          (model.snapshotIds.length > 0
            ? `  snapshots=${model.snapshotIds.join(", ")}`
            : "")
      );
      console.log(
        `  ${"".padEnd(16)} price comes from ${model.priceSource} (${model.pricingVersion}), not from this check.`
      );
    }
  } else {
    console.log(
      `  GET /v1/models  FAILED [${result.listing?.code}] ${result.listing?.detail ?? ""}`
    );
    if (result.listing?.body) console.log(`    body: ${result.listing.body}`);
  }

  if (result.invocation) {
    console.log("\n  --invoke");
    console.log(
      `    estimated maximum cost: US$${result.invocation.estimatedMaxCostUsd} for ${result.invocation.requestCount} request(s)`
    );
    if (result.invocation.skipped) {
      console.log(`    skipped: ${result.invocation.reason}`);
    } else {
      for (const entry of result.invocation.results) {
        console.log(
          `    ${entry.modelId.padEnd(16)} ${
            entry.ok
              ? `ok  service_tier=${entry.respondedServiceTier ?? "not reported"}`
              : `FAILED [${entry.code}] ${entry.detail ?? ""}`
          }`
        );
      }
    }
  }
}

// Visibility that could not be established is not the same as a model that is
// gone, so a failed *check* is an error the operator has to look at, while a
// model that is genuinely not visible is a reported finding.
const listingFailed = !result.listing?.ok;
const missing = result.models.filter((model) => !model.visible && model.snapshotIds.length === 0);
if (listingFailed) {
  console.error(
    "\nVisibility could not be established. Nothing above says a model is unavailable."
  );
  process.exit(1);
}
if (missing.length > 0) {
  console.error(
    `\n${missing.length} model(s) are not visible to this key: ${missing
      .map((model) => model.apiModelId)
      .join(", ")}.\n` +
      "Check the project's model permissions before concluding anything about the catalogue."
  );
  process.exit(1);
}
console.log("\nBoth observed models are visible to this key.");
