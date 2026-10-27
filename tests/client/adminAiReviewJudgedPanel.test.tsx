import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminAiReviewJudgedPanel } from "@/components/admin/AdminAiReviewJudgedPanel";
import { readAiReviewJudgedRunReport } from "@/lib/aiReviewJudgedRunReport";
import { buildCase, layOutRun } from "../fixtures/aiReviewJudgedRun.mjs";

const withReport = (
  body: (report: ReturnType<typeof readAiReviewJudgedRunReport>) => void,
  incomplete = false,
) => {
  const root = mkdtempSync(join(tmpdir(), "ai-review-admin-render-"));
  try {
    layOutRun(
      root,
      [
        buildCase({ id: "shown", invents: true }),
        buildCase({ id: "missed", reports: false }),
      ],
      incomplete ? { bundles: [] } : {},
    );
    body(
      readAiReviewJudgedRunReport({
        run: join(root, "run.json"),
        journal: join(root, "run.journal.jsonl"),
        dataset: join(root, "dataset.json"),
        judgements: join(root, "judgements"),
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("Admin renders verified numbers, denominators and case evidence with release approval separate", () => {
  withReport((report) => {
    const html = renderToStaticMarkup(
      <AdminAiReviewJudgedPanel
        catalog={{ state: "available", reports: [report], problems: [] }}
        locale="en"
      />,
    );
    assert.match(html, /50\.0%/);
    assert.match(html, /1 \/ 2 cases/);
    assert.match(html, /Inspect evidence: shown/);
    assert.match(html, /Measurement is not release approval/);
    assert.match(html, /Insufficient evidence/);
    assert.match(html, /0\/0/);
  });
});

test("Admin renders refusal reasons without partial metrics or case evidence", () => {
  withReport((report) => {
    const html = renderToStaticMarkup(
      <AdminAiReviewJudgedPanel
        catalog={{ state: "available", reports: [report], problems: [] }}
        locale="en"
      />,
    );
    assert.match(html, /judged-run-refused/);
    assert.doesNotMatch(
      html,
      /data-testid="judged-metric"|Inspect evidence:|50\.0%/,
    );
  }, true);
});

test("an unconfigured Admin report has Korean empty guidance and no sample data", () => {
  const html = renderToStaticMarkup(
    <AdminAiReviewJudgedPanel
      catalog={{ state: "unconfigured", reports: [], problems: [] }}
      locale="ko"
    />,
  );
  assert.match(html, /아직 판정 실행 보고서가 없습니다/);
  assert.match(html, /AI_REVIEW_JUDGED_RUNS_DIR/);
  assert.doesNotMatch(html, /data-testid="judged-metric"|50\.0%/);
});
