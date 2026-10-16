import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxIdeaBusyDialogView, busyDialogKeyAction, type AmuxBusyTone } from "@/components/admin/AmuxIdeaBusyDialog";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";

// The blocking dialog of the long AMUX Ideas writes (plan approval, execution approval, build preview): a real
// modal while the request is in flight, never dismissible then, and the answer (success, refusal or unknown)
// once it has settled. The operator pressed other controls while an approval was still being recorded.

const read = (path: string) => readFileSync(path, "utf8");
const text = (markup: string) => markup.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

for (const locale of ["ko", "en"] as const) {
  const m = adminAmuxIdeaInputMessages[locale];
  const render = (tone: AmuxBusyTone, elapsedSeconds = 0, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(AmuxIdeaBusyDialogView, {
      m, tone, title: "TITLE", message: "WHAT-IS-RECORDED", elapsedSeconds, ...extra,
    }, createElement("p", { "data-testid": "child" }, "CHILD")));

  test(`${locale}: while the request is in flight the dialog is a real modal with what, how long and a counter, and no way out`, () => {
    const html = render("working", 75);
    assert.ok(html.includes('role="dialog"') && html.includes('aria-modal="true"'));
    assert.ok(html.includes('aria-labelledby="amux-busy-dialog-title"') && html.includes('id="amux-busy-dialog-title"'));
    assert.ok(html.includes('aria-describedby="amux-busy-dialog-body"') && html.includes('id="amux-busy-dialog-body"'));
    assert.ok(html.includes('tabindex="-1"'), "the dialog itself can take focus");
    assert.ok(html.includes("fixed inset-0") && html.includes("z-50"), "a backdrop covers the page");
    const body = text(html);
    assert.ok(body.includes("WHAT-IS-RECORDED"), "says what is being recorded");
    assert.ok(body.includes(m.busyWarn), "says how long it can take and not to close or refresh");
    assert.ok(locale === "ko" ? m.busyWarn.includes("2분") && m.busyWarn.includes("새로고침")
      : m.busyWarn.includes("2 minutes") && m.busyWarn.includes("refresh"));
    assert.ok(body.includes(m.busyElapsed(75)), "an elapsed-seconds counter");
    assert.ok(html.includes('data-testid="amux-busy-dialog-elapsed"') && html.includes('aria-live="polite"'));
    assert.equal(html.includes('data-testid="amux-busy-dialog-close"'), false, "no close button while in flight");
    assert.equal(html.includes("CHILD"), true, "children (nothing is added for the working view by the callers)");
    assert.ok(html.includes('data-tone="working"'));
    assert.equal(text(render("working", 0, { onClose: () => {} })).includes(m.busyClose), false,
      "even if a caller hands an onClose, the working view offers no close");
  });

  for (const tone of ["success", "refused", "unknown"] as const) {
    test(`${locale}: a settled request (${tone}) turns the dialog into its answer, with a 44px close`, () => {
      const html = render(tone, 12, { onClose: () => {} });
      assert.ok(html.includes('role="dialog"') && html.includes('aria-modal="true"') && html.includes(`data-tone="${tone}"`));
      assert.ok(html.includes("CHILD"), "the answer is the caller's content");
      assert.equal(html.includes("WHAT-IS-RECORDED"), false, "the in-flight text is gone");
      assert.equal(html.includes(m.busyWarn), false);
      assert.ok(html.includes('data-testid="amux-busy-dialog-close"') && text(html).includes(m.busyClose));
      assert.ok(/data-testid="amux-busy-dialog-close"[^>]*min-h-11|min-h-11[^>]*data-testid="amux-busy-dialog-close"/.test(html)
        || html.includes("min-h-11 w-full"), "a 44px touch target");
      assert.ok(html.includes("focus-visible:outline-2"), "a visible focus ring");
      assert.equal(html.includes("data-testid=\"amux-busy-dialog-close\"") && render(tone, 12).includes("amux-busy-dialog-close"), false,
        "no close while a check inside the dialog is reading (no onClose)");
    });
  }

  test(`${locale}: the result titles and texts are distinct and the unknown one forbids approving again`, () => {
    const keys = ["busyPlanTitle", "busyPlanDoneTitle", "busyExecutionTitle", "busyExecutionDoneTitle", "busyPreviewTitle",
      "busyPreviewDoneTitle", "busyRefusedTitle", "busyUnknownTitle"] as const;
    assert.equal(new Set(keys.map((key) => m[key])).size, keys.length);
    for (const key of ["busyPlanBody", "busyPlanDoneBody", "busyExecutionBody", "busyExecutionDoneBody", "busyPreviewBody",
      "busyPreviewDoneBody", "busyRefusedBody", "busyUnknownBody", "busyChecking", "busyClose"] as const) {
      assert.ok(typeof m[key] === "string" && m[key].length > 0, key);
    }
    assert.ok(locale === "ko" ? m.busyUnknownBody.includes("다시 승인하거나 저장하지") : m.busyUnknownBody.includes("Do not approve or save again"));
  });
}

test("Escape is ignored while the request is in flight and closes only a settled dialog; Tab never leaves it", () => {
  const act = (over: Partial<Parameters<typeof busyDialogKeyAction>[0]>) => busyDialogKeyAction({
    key: "Tab", shiftKey: false, tone: "working", focusableCount: 0, activeIndex: -1, ...over,
  });
  assert.deepEqual(act({ key: "Escape", tone: "working" }), { preventDefault: true, close: false, focusIndex: null },
    "Escape does nothing while in flight");
  for (const tone of ["success", "refused", "unknown"] as const) {
    assert.deepEqual(act({ key: "Escape", tone }), { preventDefault: true, close: true, focusIndex: null }, tone);
  }
  assert.deepEqual(act({}), { preventDefault: true, close: false, focusIndex: -1 }, "nothing to focus: Tab stays on the dialog");
  assert.deepEqual(act({ shiftKey: true }), { preventDefault: true, close: false, focusIndex: -1 });
  assert.equal(act({ tone: "success", focusableCount: 3, activeIndex: 2 }).focusIndex, 0, "Tab wraps from the last control to the first");
  assert.equal(act({ tone: "success", focusableCount: 3, activeIndex: 0, shiftKey: true }).focusIndex, 2, "Shift+Tab wraps back");
  assert.equal(act({ tone: "success", focusableCount: 3, activeIndex: -1 }).focusIndex, 0, "from the dialog itself Tab goes to the first control");
  assert.equal(act({ tone: "success", focusableCount: 3, activeIndex: -1, shiftKey: true }).focusIndex, 2);
  assert.equal(act({ key: "a" }).preventDefault, false, "other keys are left alone");
});

test("the wrapper makes the page behind inert, moves focus in, restores it and warns before a refresh", () => {
  const source = read("components/admin/AmuxIdeaBusyDialog.tsx");
  assert.ok(source.includes('setAttribute("inert", "")') && source.includes("document.body.children"), "the page behind is inert");
  assert.ok(source.includes('document.body.style.overflow = "hidden"'), "the page behind does not scroll");
  assert.ok(source.includes("dialog?.focus()") && source.includes("previous.focus()"), "focus moves in and comes back");
  assert.ok(source.includes('addEventListener("focusin"'), "focus that escapes is brought back");
  assert.ok(source.includes('addEventListener("keydown", swallowEscape, true)'), "Escape is swallowed at the document while in flight");
  assert.ok(source.includes('addEventListener("beforeunload"'), "a refresh or close asks first");
  assert.ok(source.includes("createPortal("), "rendered at the body, above the console");
  assert.equal(/adminFetch|fetch\(|method:/.test(source), false, "the dialog sends and retries nothing");
  assert.equal(/\bdark:/.test(source), false, "dark-only: the console is always dark");
});

test("the three long writes open it: plan approval, execution approval and build preview, each with its answer", () => {
  const plan = read("components/admin/AmuxIdeaPlanApprovalPanel.tsx");
  assert.ok(plan.includes('open={state === "pending" || resultTone !== null}'));
  for (const call of ['setResultTone("success")', 'setResultTone("refused")', 'setResultTone("unknown")']) assert.ok(plan.includes(call), call);
  assert.ok(plan.includes("m.busyPlanTitle") && plan.includes("m.busyPlanDoneTitle") && plan.includes("m.busyUnknownTitle"));
  assert.ok(plan.includes("<AmuxIdeaPlanReadBackButton m={m} view={readBackView}"), "unknown offers the read-back, which shows busy");
  assert.ok(plan.includes("{failure ? <AdminApiFailureNotice failure={failure} /> : null}"), "a refusal states the server's reason");
  assert.equal((plan.match(/\/api\/admin\/amux\/ideas\/plan/g) ?? []).length, 1, "one POST, never a retry");

  const frontier = read("components/admin/AmuxFrontierModelsPanel.tsx");
  assert.ok(frontier.includes("m.busyExecutionTitle") && frontier.includes("m.busyExecutionDoneTitle"));
  assert.ok(frontier.includes("settleExecutionDialog()"));
  assert.ok(frontier.includes("m.transferConfirmReadBack") && frontier.includes("aria-busy={executionDialog.checking}"));
  const check = frontier.slice(frontier.indexOf("const checkExecution"), frontier.indexOf("const confirmPreview"));
  assert.equal(/method:\s*"POST"|approveExecution\(/.test(check), false, "the check only reads");

  const input = read("components/admin/AmuxIdeaInputPanel.tsx");
  assert.ok(input.includes("m.busyPreviewTitle") === false && input.includes("messages.busyPreviewTitle"));
  for (const hook of ['tone: "success"', 'tone: "unknown"', 'tone: "refused"', 'tone: "working"']) assert.ok(input.includes(hook), hook);
  assert.ok(input.includes("aria-busy={readBackPending}"), "the check inside the dialog shows busy");
});
