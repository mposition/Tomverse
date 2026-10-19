import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminScoutRunsPanel } from "@/components/admin/AdminScoutRunsPanel";
import { AdminScoutSuggestionsPanel } from "@/components/admin/AdminScoutSuggestionsPanel";
import { adminProductResearchScoutMessages } from "@/lib/adminMessages/productResearchScout";
import { SCOUT_PAGES } from "@/lib/productResearchScoutBrowserPolicy.mjs";
import type { ScoutConsoleSuggestion, ScoutConsoleView } from "@/lib/productResearchScoutConsoleRead";
import { scoutSubjectInfo } from "@/lib/productResearchScoutSubjects";

/**
 * Admin › Product research (docs/policy/product-research-agent.md §10, §13),
 * rendered: what an operator sees first, how suggestions are grouped, and
 * which controls a role is offered.
 */
const m = adminProductResearchScoutMessages.en;

const suggestion = (id: string, subject: string, severity: string, area: string, title: string): ScoutConsoleSuggestion => ({
  id,
  createdAt: "2026-10-19T11:46:00.000Z",
  kind: subject === "catalogue" ? "catalogue" : subject.includes(".") && !subject.startsWith("pdf") ? "page" : "file",
  subject,
  title,
  area,
  severity,
  evidence: `evidence for ${title}`,
  suggestion: `change for ${title}`,
});

const view = (overrides: Partial<ScoutConsoleView> = {}): ScoutConsoleView => ({
  enabled: true,
  settings: { modelId: "claude-sonnet-5", dailyCallCap: 50 },
  modelOptions: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "Anthropic" }],
  usageToday: { calls: 30, inputTokens: 412_330, outputTokens: 38_120 },
  lastRun: {
    startedAt: "2026-10-19T11:44:44.000Z",
    endedAt: "2026-10-19T11:50:50.000Z",
    calls: 25,
    failed: 0,
    unsettled: 0,
    kept: 38,
  },
  nextRunAt: "2026-10-19T18:00:00.000Z",
  counts: { open: 4, dismissed: 1, sent: 0 },
  open: [
    suggestion("s1", "pricing.ko", "high", "mobile", "Pricing table is cut at 320px"),
    suggestion("s2", "pricing.ko", "low", "accessibility", "Check icons have no name"),
    suggestion("s3", "catalogue", "medium", "catalogue", "Three models fall back to Brave"),
    suggestion("s4", "pdf.document", "low", "generated_file", "PDF title is body-sized"),
  ],
  days: [],
  canDismiss: true,
  canSend: true,
  canConfigure: true,
  ...overrides,
});

test("the top row says what is waiting and whether the Scout ran, before any list", () => {
  const html = renderToStaticMarkup(<AdminScoutSuggestionsPanel initial={view()} />);
  assert.match(html, new RegExp(m.stateOn));
  assert.match(html, new RegExp(`${m.tileOpen}</p><p[^>]*>4</p>`));
  assert.match(html, /High 1 · Medium 1 · Low 2 · 3 places/);
  assert.match(html, /25 judged · 0 failed · 38 new suggestions/);
  assert.match(html, /30 \/ 50/);
  assert.match(html, /412.3K input · 38.1K output tokens/);
  assert.ok(html.indexOf(m.tileOpen) < html.indexOf('data-testid="admin-product-research-scout-group"'));
});

test("suggestions are grouped by place; a group with a high one opens and the rest stay folded", () => {
  const html = renderToStaticMarkup(<AdminScoutSuggestionsPanel initial={view()} />);
  const groups = html.split('data-testid="admin-product-research-scout-group"').slice(1);
  assert.equal(groups.length, 3);
  // Highest severity first: the Korean pricing page, then the catalogue, then the PDF.
  assert.match(groups[0], /Pricing · Korean/);
  assert.match(groups[0], /href="https:\/\/tomverse.app\/pricing"/);
  assert.match(groups[0], /aria-expanded="true"/);
  assert.match(groups[0], /Pricing table is cut at 320px/);
  assert.match(groups[0], /Check icons have no name/);
  assert.match(groups[1], /Model catalogue/);
  assert.match(groups[1], /aria-expanded="false"/);
  assert.doesNotMatch(groups[1], /Three models fall back to Brave/);
  assert.match(groups[2], /Generated file · PDF document/);
  // Evidence is one click away, not on the page.
  assert.match(groups[0], new RegExp(`<summary[^>]*>${m.evidenceShow}</summary>`));
  assert.match(html, /Showing all 4 open suggestions\. Dismissed 1 · sent to AMUX 0\./);
});

test("a role that may not send sees the send buttons disabled and one line saying why", () => {
  const html = renderToStaticMarkup(<AdminScoutSuggestionsPanel initial={view({ canSend: false })} />);
  assert.match(html, new RegExp(m.sendNotAllowed));
  for (const button of html.match(/<button[^>]*>Send to AMUX<\/button>/g) ?? []) assert.match(button, /disabled=""/);
  assert.ok((html.match(/>Send to AMUX</g) ?? []).length > 0);
});

test("judging off and switched off are said above the list, with the way to the settings", () => {
  const off = renderToStaticMarkup(<AdminScoutSuggestionsPanel initial={view({ settings: { modelId: null, dailyCallCap: 50 } })} />);
  assert.match(off, new RegExp(m.stateJudgingOff));
  assert.match(off, new RegExp(m.modelOff));
  assert.match(off, /href="\/admin\/product-research\?tab=runs"/);
  const disabled = renderToStaticMarkup(<AdminScoutSuggestionsPanel initial={view({ enabled: false })} />);
  assert.match(disabled, new RegExp(m.stateOff));
  assert.match(disabled, new RegExp(m.disabled));
});

test("a list cut at its limit says so", () => {
  const html = renderToStaticMarkup(<AdminScoutSuggestionsPanel initial={view({ counts: { open: 412, dismissed: 3, sent: 9 } })} />);
  assert.match(html, /Showing the newest 4 of 412 open suggestions\./);
});

test("runs and cost: the model, the cap, today's use and seven days, the form an owner's alone", () => {
  const days = Array.from({ length: 7 }, (_, index) => ({
    day: `2026-10-${String(19 - index).padStart(2, "0")}`,
    calls: index === 1 ? 0 : 25,
    failed: index === 2 ? 1 : 0,
    kept: 20,
    inputTokens: 350_000,
    outputTokens: 30_000,
  }));
  const html = renderToStaticMarkup(<AdminScoutRunsPanel initial={view({ days, open: [] })} />);
  assert.match(html, /Claude Sonnet 5/);
  assert.match(html, /50 calls/);
  assert.match(html, /30 \/ 50 calls/);
  assert.match(html, /aria-valuenow="30"/);
  assert.equal((html.match(/data-testid="admin-product-research-scout-day"/g) ?? []).length, 7);
  assert.equal((html.match(new RegExp(`>${m.noRun}<`, "g")) ?? []).length, 1);
  assert.match(html, /<button[^>]*>Save<\/button>/);
  assert.doesNotMatch(html.match(/<button[^>]*>Save<\/button>/)![0], /disabled=""/);

  const ops = renderToStaticMarkup(<AdminScoutRunsPanel initial={view({ days, canConfigure: false })} />);
  assert.match(ops.match(/<button[^>]*>Save<\/button>/)![0], /disabled=""/);
  assert.match(ops, new RegExp(m.configureNotAllowed));
});

test("every page, file and the catalogue the walker sends has a name in both languages", () => {
  for (const locale of ["en", "ko"] as const) {
    const copy = adminProductResearchScoutMessages[locale];
    for (const page of SCOUT_PAGES as readonly { id: string }[]) {
      const info = scoutSubjectInfo(page.id);
      assert.equal(info.kind, "page", page.id);
      if (info.kind !== "page") continue;
      assert.ok(copy.pages[info.page as keyof typeof copy.pages], `${locale} ${page.id}`);
      assert.ok(copy.languages[info.lang as keyof typeof copy.languages], `${locale} ${page.id}`);
    }
    for (const id of ["pdf.document", "docx.document", "xlsx.workbook", "pptx.presentation"]) {
      const info = scoutSubjectInfo(id);
      assert.equal(info.kind, "file", id);
      if (info.kind === "file") assert.ok(copy.files[info.format as keyof typeof copy.files], `${locale} ${id}`);
    }
  }
  assert.deepEqual(scoutSubjectInfo("catalogue"), { kind: "catalogue" });
  assert.deepEqual(scoutSubjectInfo("something-else"), { kind: "other" });
});
