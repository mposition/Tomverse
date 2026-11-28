import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { amuxV22ReviewAuthorVendor } from "../lib/amux/v22WorkerClaimCore.ts";
import {
  agentOfficeChannelQuotaRows,
  agentOfficeQuotaModelLabel,
  agentOfficeQuotaReading,
} from "../lib/agentOffice/inbox.ts";
import { AGENT_OFFICE_QUOTA_CHANNELS } from "../lib/agentOffice/floor.ts";
import { agentOfficeAmuxState } from "../lib/agentOfficeAmuxState.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Owner decision 2026-11-20: AMUX runs Antigravity workers on Gemini 4 Argon,
// Hydrogen and Claude Opus 5.5, each bounded by its own agy usage group.

test("an Antigravity change is reviewed away from its model's vendor, not its CLI's", () => {
  assert.equal(amuxV22ReviewAuthorVendor("antigravity", "gemini-4-argon-medium"), "google");
  assert.equal(amuxV22ReviewAuthorVendor("antigravity", "gemini-4-hydrogen-high"), "google");
  assert.equal(amuxV22ReviewAuthorVendor("antigravity", "gemini-3.8-flash-high"), "google");
  assert.equal(amuxV22ReviewAuthorVendor("antigravity", "claude-opus-5-5-high"), "anthropic");
  assert.equal(amuxV22ReviewAuthorVendor("antigravity", "gpt-oss-120b-medium"), "openai");
  // A model naming no vendor cannot be shown to differ from any reviewer.
  assert.equal(amuxV22ReviewAuthorVendor("antigravity", "orchestrator-x"), "unknown");
  // Other providers keep their provider name, as before.
  assert.equal(amuxV22ReviewAuthorVendor("anthropic", "claude-opus-5-5"), "anthropic");
  assert.equal(amuxV22ReviewAuthorVendor("openai", "gpt-5.6-sol"), "openai");
  assert.equal(amuxV22ReviewAuthorVendor("cursor", "auto"), "cursor");
  assert.equal(amuxV22ReviewAuthorVendor("github-copilot", "auto"), "github-copilot");
});

test("delivery sends and execution checks the same model vendor", () => {
  const delivery = read("lib/amux/delivery.ts");
  assert.match(delivery, /reviewAuthorVendor: amuxV22ReviewAuthorVendor\(assignment\.provider,\s*assignment\.modelId\)/);
  const execution = read("lib/amux/execution.ts");
  assert.match(execution, /amuxV22ReviewAuthorVendor\(assignment\.provider, assignment\.modelId\) !==\s*evidence\.authorVendor/);
  assert.match(execution, /amuxV22ReviewAuthorVendor\(settlementAssignment\.provider, settlementAssignment\.modelId\)/);
  assert.doesNotMatch(execution, /assignment\.provider !== evidence\.authorVendor/);
  assert.doesNotMatch(execution, /authorVendor !== settlementAssignment\?\.provider/);
});

test("model rows are named by their model", () => {
  assert.equal(agentOfficeQuotaModelLabel("gemini-4-argon-medium"), "Argon");
  assert.equal(agentOfficeQuotaModelLabel("gemini-4-hydrogen-high"), "Hydrogen");
  assert.equal(agentOfficeQuotaModelLabel("claude-opus-5-5-high"), "Opus");
  assert.equal(agentOfficeQuotaModelLabel("gemini-3.8-flash-low"), "Flash");
  assert.equal(agentOfficeQuotaModelLabel("gpt-oss-120b-medium"), "gpt-oss-120b-medium");
});

test("the quota card shows Antigravity per model, so a spent Argon week is not the whole channel", () => {
  const now = Date.parse("2026-11-20T04:20:00.000Z");
  const reading = (remainingPercent, exhausted = false) => agentOfficeQuotaReading(
    { remainingPercent, exhausted, resetAt: null, observedAt: new Date(now - 60_000).toISOString() }, now);
  const workers = [
    { quotaChannel: "claude", model: "claude-opus-5-5", quota: reading(10) },
    { quotaChannel: "claude", model: "claude-sonnet-5-5", quota: reading(30) },
    { quotaChannel: "antigravity", model: "gemini-4-argon-medium", quota: reading(0, true) },
    { quotaChannel: "antigravity", model: "gemini-4-hydrogen-high", quota: reading(99.6) },
    { quotaChannel: "antigravity", model: "claude-opus-5-5-high", quota: reading(98.6) },
  ];
  const rows = agentOfficeChannelQuotaRows(AGENT_OFFICE_QUOTA_CHANNELS, workers);
  assert.deepEqual(rows.map((row) => [row.channel, row.model, row.quota]), [
    // A channel on one sign-in stays one row, its workers' mean.
    ["claude", null, { kind: "fresh", percent: 20 }],
    ["codex", null, { kind: "none" }],
    ["copilot", null, { kind: "none" }],
    ["cursor", null, { kind: "none" }],
    ["antigravity", "Argon", { kind: "fresh", percent: 0 }],
    ["antigravity", "Hydrogen", { kind: "fresh", percent: 100 }],
    ["antigravity", "Opus", { kind: "fresh", percent: 99 }],
    // Kimi (owner request 2026-11-28) reports no quota yet: one empty row.
    ["kimi", null, { kind: "none" }],
  ]);
  // A worker with no model is a row of its own, not folded into a model.
  const unnamed = agentOfficeChannelQuotaRows(["antigravity"], [
    { quotaChannel: "antigravity", model: null, quota: reading(40) },
    { quotaChannel: "antigravity", model: "gemini-4-argon-low", quota: reading(0, true) },
  ]);
  assert.deepEqual(unnamed.map((row) => [row.model, row.quota.kind === "fresh" ? row.quota.percent : null]),
    [[null, 40], ["Argon", 0]]);
  // No Antigravity worker: one empty row, as every other channel.
  assert.deepEqual(agentOfficeChannelQuotaRows(["antigravity"], []),
    [{ channel: "antigravity", model: null, quota: { kind: "none" } }]);
});

test("the AMUX room carries each worker's v22 model to the card", () => {
  const now = new Date("2026-11-20T04:20:00.000Z");
  const base = { archived: false, paused: false, isolated: false, blocked: false };
  const state = agentOfficeAmuxState({
    catalog: [
      { ...base, worker_name: "antigravity-impl", provider: "antigravity", model: "gemini-4-argon-medium" },
      { ...base, worker_name: "claude-impl", provider: "anthropic", model: null },
    ],
    roster: [{ name: "antigravity-impl", provider: "antigravity" }, { name: "claude-impl", provider: "anthropic" }],
    runtimes: [],
    now,
  });
  assert.equal(state.kind, "observed");
  assert.equal(state.workers[0].model, "gemini-4-argon-medium");
  assert.equal("model" in state.workers[1], false);
  const live = read("lib/agentOfficeLiveRead.ts");
  assert.match(live, /model: v22Models\.get\(worker\.worker_name\) \?\? worker\.model/);
  const card = read("components/admin/AgentOfficeLive.tsx");
  assert.match(card, /agentOfficeChannelQuotaRows\(AGENT_OFFICE_QUOTA_CHANNELS, workers\)/);
  assert.match(card, /model: w\.model \?\? null/);
});
