import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const origin = process.env.CAPTURE_ORIGIN || "http://127.0.0.1:3100";
const outputDirectory = "public/marketing-proof";
const outputPath = `${outputDirectory}/tomverse-review-workflow.webm`;
const posterPath = `${outputDirectory}/tomverse-review-workflow-poster.png`;
const reviewModels = [
  "gpt-5-4-mini",
  "claude-haiku-4-5",
  "gemini-2-5-flash",
];

const json = (body, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: {
    dir: outputDirectory,
    size: { width: 1280, height: 720 },
  },
  colorScheme: "dark",
});
const page = await context.newPage();

page.on("pageerror", (error) => console.error("[capture pageerror]", error));
page.on("console", (message) => {
  if (message.type() === "error") {
    console.error("[capture console]", message.text());
  }
});
page.on("requestfailed", (request) =>
  console.error(
    "[capture requestfailed]",
    request.method(),
    request.url(),
    request.failure()?.errorText
  )
);

await context.addCookies([
  { name: "__tomverse_e2e_auth", value: "1", url: origin },
]);

await page.addInitScript(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("tomverse_language", "en");
  localStorage.setItem("tomverse_onboarding_seen_v1", "1");
  localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
  localStorage.setItem("tomverse_analytics_consent_v1", "declined");
  localStorage.setItem("tomverse_post_response_tips_seen_v1", "1");
});

await page.route("**/api/auth/session**", (route) =>
  route.fulfill(
    json({
      user: {
        id: "marketing-proof-user",
        name: "Tomverse Demo",
        email: "demo@tomverse.app",
        image: null,
      },
      expires: "2099-01-01T00:00:00.000Z",
    })
  )
);
await page.route("**/api/app-settings", (route) =>
  route.fulfill(json({ guestDefaultModelId: reviewModels[0] }))
);
await page.route("**/api/user/settings**", (route) =>
  route.fulfill(
    json({ theme: "dark", language: "en", defaultModel: reviewModels[0] })
  )
);
await page.route("**/api/user/model-finder**", (route) =>
  route.fulfill(
    json({
      variant: "control",
      shouldShow: false,
      settings: {
        preferredTasks: [],
        preferredPriority: null,
        usesFilesFrequently: null,
        defaultModelId: reviewModels[0],
        modelFinderCompletedAt: null,
        modelFinderDismissedAt: null,
      },
    })
  )
);
await page.route("**/api/models/status**", (route) =>
  route.fulfill(json({ generatedAt: "2099-01-01T00:00:00.000Z", models: [] }))
);
await page.route("**/api/user/usage**", (route) =>
  route.fulfill(
    json({
      plan: "Pro",
      subscription: {
        status: "active",
        billingInterval: "monthly",
        currentPeriodEnd: "2099-02-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
      },
      usage: {
        creditsDay: 18,
        creditsMonth: 412,
        proModelResponsesMonth: 4,
        tokensDay: 0,
        tokensMonth: 0,
        costDay: 0,
        costMonth: 0,
      },
      balances: {
        planRemainingCredits: 2588,
        planResetsAt: "2099-02-01T00:00:00.000Z",
        purchasedRemainingCredits: 0,
        purchasedFundedCostMicroUsd: 0,
        purchasedEarliestExpiry: null,
      },
      creditDebt: {
        credits: 0,
        fundedCostMicroUsd: 0,
        riskStatus: "clear",
        riskReason: null,
        riskAt: null,
      },
      recommendation: { primary: null, secondary: null },
      limits: {
        creditsDay: 300,
        creditsMonth: 3000,
        proModelResponsesMonth: 0,
        tokensDay: 0,
        tokensMonth: 0,
        costDay: 0,
        costMonth: 0,
        maxModels: 3,
        allowAttachments: true,
        allowSharing: true,
        allowDownloads: true,
      },
    })
  )
);
await page.route("**/api/projects**", (route) => route.fulfill(json({ projects: [] })));
await page.route("**/api/billing/refund-request**", (route) =>
  route.fulfill(json({ pendingRequest: null }))
);

const conversation = {
  id: "marketing-proof-conversation",
  title: "Launch readiness review",
  selectedModels: reviewModels,
  disabledPanels: [],
  isLocked: false,
  shareEnabled: false,
  shareExpiresAt: null,
};

await page.route("**/api/conversations", async (route) => {
  if (route.request().method() === "GET") {
    await route.fulfill(json([conversation]));
    return;
  }
  await route.fulfill(json(conversation, 201));
});
await page.route(
  "**/api/conversations/marketing-proof-conversation/messages**",
  (route) => route.fulfill(json({}, route.request().method() === "POST" ? 201 : 200))
);
await page.route(
  /.*\/api\/conversations\/marketing-proof-conversation(\?.*)?$/,
  (route) =>
    route.fulfill(
      json({ ...conversation, messages: [], nextCursor: null })
    )
);

await page.route("**/api/chat", async (route) => {
  if (route.request().method() !== "POST") {
    await route.fallback();
    return;
  }
  const body = route.request().postDataJSON();
  const responseByModel = {
    "gpt-5-4-mini":
      "**Launch gates**\n\n- Verify payment recovery.\n- Set measurable launch thresholds.\n- Assign an owner to every P0 item.",
    "claude-haiku-4-5":
      "**Ownership and communication**\n\n- Define who can pause the launch.\n- Prepare provider-incident messaging.\n- Confirm launch-window support coverage.",
    "gemini-2-5-flash":
      "**Rollout and rollback**\n\n- Begin with a measured cohort.\n- Monitor latency, errors, and credit burn.\n- Document rollback triggers.",
  };
  await new Promise((resolve) => setTimeout(resolve, 650));
  await route.fulfill({
    status: 200,
    contentType: "text/plain; charset=utf-8",
    headers: { "X-Request-ID": `demo-${body.modelId || "model"}` },
    body:
      responseByModel[body.modelId] ||
      "Review the launch brief against measurable acceptance criteria.",
  });
});

await page.route(
  "**/api/conversations/marketing-proof-conversation/comparison-reviews**",
  async (route) => {
    console.log("[capture review request]", route.request().method());
    if (route.request().method() === "GET") {
      await new Promise((resolve) => setTimeout(resolve, 550));
      await route.fulfill(
        json({
          available: true,
          promptMessageId: "11111111-1111-4111-8111-111111111111",
          assistantMessageIds: [
            "21111111-1111-4111-8111-111111111111",
            "31111111-1111-4111-8111-111111111111",
            "41111111-1111-4111-8111-111111111111",
          ],
          responses: [
            { messageId: "21111111-1111-4111-8111-111111111111", modelId: reviewModels[0], modelName: "GPT-5.4 mini" },
            { messageId: "31111111-1111-4111-8111-111111111111", modelId: reviewModels[1], modelName: "Claude Haiku 4.5" },
            { messageId: "41111111-1111-4111-8111-111111111111", modelId: reviewModels[2], modelName: "Gemini 3.1 Flash-Lite" },
          ],
          estimatedCredits: 4,
          reviewerClass: "Advanced",
          freeMonthlyReviews: 3,
          disclaimer:
            "This compares only supplied answers and does not externally verify facts.",
        })
      );
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.fulfill(
      json({
        id: "marketing-proof-review",
        result: {
          consensus: [
            "All three answers recommend measurable launch gates and active monitoring.",
          ],
          differences: [
            {
              issue: "Primary launch risk",
              positions: [
                { responseId: "A", position: "Payment recovery and acceptance criteria." },
                { responseId: "B", position: "Ownership and customer communication." },
                { responseId: "C", position: "Cohort rollout and rollback signals." },
              ],
            },
          ],
          contradictions: [
            "The answers prioritize different first actions before paid traffic begins.",
          ],
          missingPoints: [
            "None defines the exact traffic percentage for the initial cohort.",
          ],
          verificationNeeded: [
            "Confirm current provider limits and payment-retry behavior in primary documentation.",
          ],
          modelAssessments: [
            { responseId: "A", strengths: ["Measurable gates"], cautions: ["Limited communication detail"] },
            { responseId: "B", strengths: ["Clear ownership"], cautions: ["No numeric rollout threshold"] },
            { responseId: "C", strengths: ["Operational safeguards"], cautions: ["Assumes monitoring is configured"] },
          ],
          synthesis:
            "Combine payment recovery, named incident ownership, and a measured cohort with explicit rollback triggers.",
          confidence: "medium",
          limitations: ["This is answer cross-review, not external fact verification."],
        },
        responseMap: [
          { responseId: "A", messageId: "21111111-1111-4111-8111-111111111111", modelId: reviewModels[0], modelName: "GPT-5.4 mini" },
          { responseId: "B", messageId: "31111111-1111-4111-8111-111111111111", modelId: reviewModels[1], modelName: "Claude Haiku 4.5" },
          { responseId: "C", messageId: "41111111-1111-4111-8111-111111111111", modelId: reviewModels[2], modelName: "Gemini 3.1 Flash-Lite" },
        ],
        reviewerModelId: "mistral-medium-3-1",
        usageCredits: 4,
        cached: false,
        disclaimer: "This review is not external fact verification.",
      })
    );
  }
);

await page.goto(`${origin}/chat?lang=en`, { waitUntil: "networkidle" });
const textarea = page.locator('[data-testid="chat-textarea"]');
try {
  await textarea.waitFor({ state: "visible", timeout: 30_000 });
} catch (error) {
  console.error("[capture diagnostics]", {
    url: page.url(),
    title: await page.title(),
    body: (await page.locator("body").innerText()).slice(0, 3000),
  });
  await page.screenshot({
    path: `${outputDirectory}/capture-failure.png`,
    type: "png",
    fullPage: true,
  });
  throw error;
}
await page.waitForTimeout(1800);
await textarea.fill(
  "Review launch-readiness.pdf and identify the three highest-priority risks with one next action each."
);
await page.waitForTimeout(1800);
await textarea.press("Enter");
await page
  .locator('[data-testid="chat-message"][data-message-role="assistant"]')
  .filter({ hasText: "Launch gates" })
  .waitFor({ state: "visible", timeout: 15_000 });
await page.waitForTimeout(4700);

await page.getByRole("button", { name: "AI answer cross-review" }).click();
const reviewDialog = page.getByRole("dialog", { name: "AI answer cross-review" });
await reviewDialog.getByTestId("comparison-review-setup").waitFor({ state: "visible" });
await page.waitForTimeout(1200);
await reviewDialog.getByRole("button", { name: /Run cross-review/ }).click();
try {
  await reviewDialog
    .getByText("All three answers recommend measurable launch gates")
    .waitFor({ state: "visible", timeout: 15_000 });
} catch (error) {
  console.error("[capture review diagnostics]", {
    dialog: (await reviewDialog.innerText()).slice(0, 4000),
  });
  await page.screenshot({
    path: `${outputDirectory}/capture-review-failure.png`,
    type: "png",
  });
  throw error;
}
await page.waitForTimeout(5200);

await page.screenshot({ path: posterPath, type: "png" });
await page.evaluate(() => {
  const overlay = document.createElement("div");
  overlay.setAttribute("data-marketing-proof-end-slate", "true");
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:9999",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "background:radial-gradient(circle at top,#12305d 0%,#09090b 62%)",
    "color:white",
    "font-family:Arial,sans-serif",
    "text-align:center",
    "padding:48px",
  ].join(";");
  overlay.innerHTML = `
    <div style="font-size:14px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#93c5fd">Tomverse AI</div>
    <div style="max-width:900px;margin-top:22px;font-size:54px;line-height:1.08;font-weight:900">One question. Multiple AI answers.<br/>One clearer view.</div>
    <div style="margin-top:28px;display:flex;gap:12px;font-size:17px;font-weight:800">
      <span style="border-radius:14px;background:#2563eb;padding:14px 22px">Follow up</span>
      <span style="border:1px solid #52525b;border-radius:14px;padding:14px 22px">Share the result</span>
    </div>`;
  document.body.appendChild(overlay);
});
await page.waitForTimeout(3900);

const video = page.video();
await page.close();
if (!video) throw new Error("Playwright did not create a marketing proof video.");
await video.saveAs(outputPath);
await context.close();
await browser.close();

console.log(`Saved ${outputPath}`);
console.log(`Saved ${posterPath}`);
