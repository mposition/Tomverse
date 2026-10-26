import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AmuxAnalysisMonthlyBudgetPanel, AmuxAnalysisBudgetReauthenticationNotice } from "@/components/admin/AmuxAnalysisMonthlyBudgetPanel";

test("initial owner budget form labels the proposed USD 1000 and blocks save until server accounting is loaded", () => {
  const html = renderToStaticMarkup(<AmuxAnalysisMonthlyBudgetPanel available={true} operatorId="synthetic-owner" />);
  assert.match(html, /value="1000"/);
  assert.match(html, /not active until saved/);
  assert.match(html, /Save monthly threshold<\/button>/);
  assert.match(html, /disabled=""[^>]*>Save monthly threshold/);
  assert.match(html, /aria-describedby="amux-analysis-monthly-hint amux-analysis-monthly-error"/);
  assert.doesNotMatch(html, /1000\.00/);
});
test("disabled setting shows no enabled save or implied model execution", () => {
  const html = renderToStaticMarkup(<AmuxAnalysisMonthlyBudgetPanel available={false} operatorId="synthetic-owner" />);
  assert.match(html, /unavailable or disabled/);
  assert.match(html, /never starts a model or clears a halt/);
  assert.match(html, /disabled=""[^>]*>Save monthly threshold/);
});

test("a stale sign-in offers an actionable return link to Analysis settings", () => {
  const html = renderToStaticMarkup(<AmuxAnalysisBudgetReauthenticationNotice />);
  assert.match(html, /role="alert"/);
  assert.match(html, /Sign in again to continue/);
  assert.match(html, /href="\/auth\/admin-reauthenticate\?callbackUrl=%2Fadmin%2Famux-settings%3Ftab%3Danalysis&amp;mode=recent"/);
});
