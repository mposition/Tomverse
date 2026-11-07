import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DefaultModelsView } from "@/components/admin/models/DefaultModelsView";
import { ModelRegistryList, type ModelRegistryRow } from "@/components/admin/models/ModelRegistryList";
import { MODEL_LIFECYCLE_LABELS } from "@/lib/adminModelRegistryFilters";

const model = (overrides: Partial<ModelRegistryRow> & { id: string }): ModelRegistryRow => ({
  name: overrides.id,
  apiModel: overrides.id,
  provider: "openai",
  icon: "",
  bestFor: "",
  minimumPlan: "Guest",
  usageClass: "standard",
  creditWeight: 1,
  enabled: true,
  publiclyListed: true,
  status: "enabled",
  environment: { apiKeyConfigured: true, apiKeyEnvName: "OPENAI_API_KEY" },
  ...overrides,
});

const noop = () => {};

const list = (rows: ModelRegistryRow[], extra: Partial<Parameters<typeof ModelRegistryList>[0]> = {}) =>
  renderToStaticMarkup(
    <ModelRegistryList
      rows={rows}
      providerCounts={[
        { provider: "openai", count: 2 },
        { provider: "anthropic", count: 1 },
      ]}
      provider="all"
      query=""
      lifecycle="operational"
      lifecycleLabels={MODEL_LIFECYCLE_LABELS}
      summary="Showing 3 of 4 models"
      hiddenNote="1 model is outside the Operational view."
      loading={false}
      roleLabels={(row) => (row.id === "gpt-a" ? ["Fallback"] : [])}
      onQuery={noop}
      onProvider={noop}
      onLifecycle={noop}
      onClear={noop}
      onReload={noop}
      onAdd={noop}
      onEdit={noop}
      onDuplicate={noop}
      labels={{
        searchLabel: "Search models",
        searchPlaceholder: "Search",
        clear: "Clear filters",
        reload: "Reload",
        addModel: "Add model",
        editLabel: (name) => `Edit ${name}`,
        duplicateLabel: (name) => `Duplicate ${name}`,
        duplicateTitle: "Duplicate",
        internalPrefix: "Internal: ",
      }}
      {...extra}
    />
  );

test("the registry table shows plans, credits per answer and a visibility switch for each model", () => {
  const html = list([
    model({ id: "gpt-a", name: "GPT A", minimumPlan: "Guest" }),
    model({ id: "claude-pro", name: "Claude Pro", provider: "anthropic", minimumPlan: "Free", usageClass: "advanced", creditWeight: 4 }),
  ]);
  assert.match(html, /GPT A/);
  assert.match(html, />Fallback</);
  // A Guest model is open to every plan; a Free one is not open to Guests.
  assert.match(html, />Guests</);
  assert.match(html, />4 credits</);
  assert.match(html, />1 credit</);
  assert.match(html, /role="switch"[^>]*aria-checked="true"[^>]*aria-label="Change whether GPT A is shown"/);
  assert.match(html, /aria-label="Edit GPT A"/);
  assert.match(html, /aria-label="Duplicate Claude Pro"/);
  assert.match(html, /data-testid="model-registry-lifecycle-badge-gpt-a"/);
  // The result counter and the held-back note stay on screen.
  assert.match(html, /data-testid="model-registry-result-summary"/);
  assert.match(html, /1 model is outside the Operational view\./);
});

test("a hidden or removed model's switch reads off, and a missing API key is said so", () => {
  const html = list([
    model({ id: "gpt-off", name: "Off one", enabled: false, status: "disabled" }),
    model({
      id: "claude-nokey",
      name: "No key",
      provider: "anthropic",
      environment: { apiKeyConfigured: false, apiKeyEnvName: "ANTHROPIC_API_KEY" },
    }),
  ]);
  assert.match(html, /aria-checked="false"[^>]*aria-label="Change whether Off one is shown"/);
  assert.match(html, /API key missing/);
  assert.match(html, /ANTHROPIC_API_KEY/);
});

test("company chips mark the chosen one and keep every company reachable", () => {
  const html = list([model({ id: "gpt-a" })], { provider: "anthropic" });
  assert.match(html, /data-testid="model-registry-provider-chip-all"[^>]*>All 3</);
  assert.match(html, /aria-pressed="true"[^>]*data-testid="model-registry-provider-chip-anthropic"/);
  assert.match(html, /aria-pressed="false"[^>]*data-testid="model-registry-provider-chip-openai"/);
  assert.match(html, /data-testid="model-registry-lifecycle-filter"/);
});

test("an empty result shows the caller's empty state, not a table of nothing", () => {
  const html = list([], { emptyState: <p data-testid="model-registry-empty-state">No models match.</p> });
  assert.match(html, /data-testid="model-registry-empty-state"/);
  assert.doesNotMatch(html, /<table/);
});

const view = (overrides: { lineupError?: string | null; missing?: string | null } = {}) =>
  renderToStaticMarkup(
    <DefaultModelsView
      syncedLabel={null}
      reload={{ busy: false, onReload: noop }}
      fallback={{ name: "GPT 6 Luna", id: "gpt-6-luna", provider: "openai", credits: 1 }}
      transition={{
        loaded: true,
        candidates: [{ id: "gemini-x", name: "Gemini X", provider: "google" }],
        candidateId: "",
        onCandidate: noop,
        checks: [],
        hasCandidate: false,
        onCopy: noop,
      }}
      lineup={{
        draft: ["gpt-6-luna", "claude-sonnet", "gemini-x"],
        slotProviders: ["openai", "anthropic", "google"],
        options: [
          { id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", credits: 1 },
          { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic", credits: 1 },
          { id: "claude-haiku", name: "Claude Haiku", provider: "anthropic", credits: 1 },
          { id: "gemini-x", name: "Gemini X", provider: "google", credits: 1 },
        ],
        labelFor: (id) => id,
        changed: false,
        complete: true,
        saving: false,
        error: overrides.lineupError ?? null,
        leadMovesTo: null,
        onSlot: noop,
        onSave: noop,
      }}
      lead={{
        value: "gpt-6-luna",
        options: [{ id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai" }],
        inList: true,
        saving: false,
        error: null,
        onChange: noop,
        onSave: noop,
      }}
      notices={{
        visibleOrder: "gpt-6-luna, claude-sonnet, gemini-x",
        missingProviders: overrides.missing ?? null,
        storedNotApplied: null,
        substitutions: [],
        outsideTrio: [],
      }}
    />
  );

test("the default models tab keeps one slot per company and the save controls the e2e relies on", () => {
  const html = view();
  for (const index of [0, 1, 2]) assert.match(html, new RegExp(`data-testid="admin-guest-lineup-slot-${index}"`));
  // The second slot offers only Anthropic models.
  const second = html.slice(html.indexOf('data-testid="admin-guest-lineup-slot-1"'), html.indexOf('data-testid="admin-guest-lineup-slot-2"'));
  assert.match(second, /Claude Haiku - anthropic/);
  assert.doesNotMatch(second, /Gemini X - google/);
  // Nothing changed yet, so the lineup cannot be saved; the save asks for a recent sign-in.
  assert.match(html, /<button[^>]*data-step-up="true"[^>]*disabled=""[^>]*data-testid="admin-guest-lineup-save"|data-testid="admin-guest-lineup-save"[^>]*disabled=""/);
  assert.match(html, /Save leading model/);
  assert.match(html, /data-testid="admin-fallback-card"/);
  assert.match(html, /data-testid="admin-fallback-candidate"/);
  assert.match(html, /data-testid="admin-account-default-card"/);
  // No before-and-after figures exist, so none are drawn.
  assert.doesNotMatch(html, /After the default changed/);
});

test("a refused lineup and a missing company are shown as warnings, not hidden", () => {
  const html = view({ lineupError: "Lineup refused", missing: "Google" });
  assert.match(html, /data-testid="admin-guest-lineup-error"[^>]*>Lineup refused</);
  assert.match(html, /data-testid="admin-guest-lineup-provider-missing"/);
});
