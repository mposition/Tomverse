import { chromium } from "@playwright/test";
import { mkdir, unlink } from "node:fs/promises";

const origin = process.env.CAPTURE_ORIGIN || "http://127.0.0.1:3100";
const outputDirectory = "public/marketing-launch/week1";
const outputPath = `${outputDirectory}/tomverse-business-risk-review-en.webm`;
const posterPath = `${outputDirectory}/tomverse-business-risk-review-poster-en.png`;
const comparisonScreenshotPath = `${outputDirectory}/model-answer-comparison-en.png`;
const reviewScreenshotPath = `${outputDirectory}/ai-review-result-en.png`;
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
  localStorage.setItem("tomverse_sidebar_tour_v1", "completed");
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

let selectedModelIds = [reviewModels[0]];
const conversation = () => ({
  id: "marketing-proof-conversation",
  title: "AI Fitness Subscription Review",
  selectedModels: selectedModelIds,
  disabledPanels: [],
  isLocked: false,
  shareEnabled: false,
  shareExpiresAt: null,
});

await page.route("**/api/conversations", async (route) => {
  if (route.request().method() === "GET") {
    await route.fulfill(json([conversation()]));
    return;
  }
  await route.fulfill(json(conversation(), 201));
});
await page.route(
  "**/api/conversations/marketing-proof-conversation/messages**",
  (route) => route.fulfill(json({}, route.request().method() === "POST" ? 201 : 200))
);
await page.route(
  /.*\/api\/conversations\/marketing-proof-conversation(\?.*)?$/,
  (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      if (Array.isArray(body?.selectedModels)) selectedModelIds = body.selectedModels;
      return route.fulfill(json(conversation()));
    }
    return route.fulfill(
      json({ ...conversation(), messages: [], nextCursor: null })
    );
  }
);
page.on("response", (response) => {
  if (response.status() >= 400) {
    console.error("[capture response]", response.status(), response.url());
  }
});

await page.route(/\/api\/chat(?:\?.*)?$/, async (route) => {
  if (route.request().method() !== "POST") {
    await route.fallback();
    return;
  }
  const body = route.request().postDataJSON();
  console.log("[capture chat request]", body.modelId);
  const responseByModel = {
    "gpt-5-4-mini":
      "**Biggest risk: Unit economics**\n\n- Gyms have not yet shown a clear willingness to pay the monthly fee.\n- Member usage and coach time savings remain unproven.\n- Run a paid concierge pilot with five gyms before building the full product.\n\n**Decision: PIVOT** — validate it first as a coach-assistance service.",
    "claude-haiku-4-5":
      "**Biggest risk: Trust and safety**\n\n- Sensitive health data and unsuitable diet advice create the main risk.\n- Gyms and members may not trust recommendations that look like AI-only prescriptions.\n- Do not launch automated advice without expert review and clear safety notices.\n\n**Decision: STOP current plan** — redesign it around professional review.",
    "gemini-2-5-flash":
      "**Biggest risk: Adoption and retention**\n\n- Members will not use the product if gym managers do not support the new workflow.\n- Churn will be high unless it fits existing coaching and messaging habits.\n- Measure weekly usage and return rates in three gyms for four weeks.\n\n**Decision: GO for a limited test** — run a small pilot before expanding to 30 gyms.",
  };
  const delayByModel = {
    "gpt-5-4-mini": 900,
    "claude-haiku-4-5": 1500,
    "gemini-2-5-flash": 2200,
  };
  await new Promise((resolve) =>
    setTimeout(resolve, delayByModel[body.modelId] || 900)
  );
  await route.fulfill({
    status: 200,
    contentType: "text/plain; charset=utf-8",
    headers: { "X-Request-ID": `demo-${body.modelId || "model"}` },
    body:
      responseByModel[body.modelId] ||
      "Define the key risk and validation criteria first.",
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
            "This feature compares the supplied answers and does not independently verify external facts.",
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
            "All three answers recommend validating the idea with a small pilot before expanding to 30 gyms.",
          ],
          differences: [
            {
              issue: "The failure risk that should be addressed first",
              positions: [
                { responseId: "A", position: "Gym willingness to pay and unit economics" },
                { responseId: "B", position: "Health data, safety, and professional review" },
                { responseId: "C", position: "Manager adoption and member retention" },
              ],
            },
          ],
          contradictions: [
            "The recommendations conflict: PIVOT, STOP the current plan, and GO for a limited test.",
          ],
          missingPoints: [
            "Customer acquisition cost, member churn, coach time saved, and the health-data process are missing.",
          ],
          verificationNeeded: [
            "Legal duties for health data, the scope of nutrition advice, and gyms' actual willingness to pay need verification.",
          ],
          modelAssessments: [
            { responseId: "A", strengths: ["Prioritizes commercial validation"], cautions: ["Underexplains safety and legal risk"] },
            { responseId: "B", strengths: ["Makes trust and safety risks concrete"], cautions: ["Lacks demand-validation criteria"] },
            { responseId: "C", strengths: ["Suggests an actionable pilot"], cautions: ["Does not include expert-review costs"] },
          ],
          synthesis:
            "Pause full development and run a four-week concierge pilot with expert review in five gyms. Reassess Go/Pivot/Stop using willingness to pay, weekly member usage, coach time saved, and safety issues.",
          confidence: "medium",
          limitations: ["This is a cross-review of supplied answers, not external fact-checking or legal or medical advice."],
        },
        responseMap: [
          { responseId: "A", messageId: "21111111-1111-4111-8111-111111111111", modelId: reviewModels[0], modelName: "GPT-5.4 mini" },
          { responseId: "B", messageId: "31111111-1111-4111-8111-111111111111", modelId: reviewModels[1], modelName: "Claude Haiku 4.5" },
          { responseId: "C", messageId: "41111111-1111-4111-8111-111111111111", modelId: reviewModels[2], modelName: "Gemini 3.1 Flash-Lite" },
        ],
        reviewerModelId: "mistral-medium-3-1",
        usageCredits: 4,
        cached: false,
        disclaimer: "This review is not external fact-checking.",
      })
    );
  }
);

const showStep = async (eyebrow, title, detail = "") => {
  await page.evaluate(
    ({ eyebrow, title, detail }) => {
      document.querySelector("[data-week1-step-overlay]")?.remove();
      const overlay = document.createElement("div");
      overlay.setAttribute("data-week1-step-overlay", "true");
      overlay.style.cssText = [
        "position:fixed",
        "top:18px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:9998",
        "display:flex",
        "align-items:center",
        "gap:12px",
        "max-width:850px",
        "border:1px solid rgba(147,197,253,.45)",
        "border-radius:16px",
        "background:rgba(9,9,11,.92)",
        "box-shadow:0 16px 45px rgba(0,0,0,.38)",
        "padding:11px 16px",
        "color:white",
        "font-family:Arial,'Noto Sans KR',sans-serif",
        "backdrop-filter:blur(12px)",
      ].join(";");
      overlay.innerHTML = `
        <span style="flex:none;border-radius:999px;background:#2563eb;padding:6px 10px;font-size:12px;font-weight:900;letter-spacing:.05em">${eyebrow}</span>
        <span style="font-size:18px;font-weight:900">${title}</span>
        ${detail ? `<span style="font-size:13px;color:#a1a1aa">${detail}</span>` : ""}`;
      document.body.appendChild(overlay);
    },
    { eyebrow, title, detail }
  );
};

const clearStep = async () => {
  await page.evaluate(() => {
    document.querySelector("[data-week1-step-overlay]")?.remove();
  });
};

const showSlate = async ({ eyebrow, title, detail, cta }) => {
  await page.evaluate(
    ({ eyebrow, title, detail, cta }) => {
      document.querySelector("[data-week1-slate]")?.remove();
      const overlay = document.createElement("div");
      overlay.setAttribute("data-week1-slate", "true");
      overlay.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:9999",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "background:radial-gradient(circle at top,#173b70 0%,#09090b 64%)",
        "color:white",
        "font-family:Arial,'Noto Sans KR',sans-serif",
        "text-align:center",
        "padding:48px",
      ].join(";");
      overlay.innerHTML = `
        <div style="font-size:14px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#93c5fd">${eyebrow}</div>
        <div style="max-width:960px;margin-top:22px;font-size:48px;line-height:1.14;font-weight:900">${title}</div>
        <div style="max-width:780px;margin-top:20px;font-size:19px;line-height:1.6;color:#d4d4d8">${detail}</div>
        ${cta ? `<div style="margin-top:30px;border-radius:14px;background:#2563eb;padding:14px 24px;font-size:17px;font-weight:900">${cta}</div>` : ""}`;
      document.body.appendChild(overlay);
    },
    { eyebrow, title, detail, cta }
  );
};

const clearSlate = async () => {
  await page.evaluate(() => {
    document.querySelector("[data-week1-slate]")?.remove();
  });
};

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
await page.evaluate(() => {
  const disclosure = document.createElement("div");
  disclosure.setAttribute("data-week1-demo-disclosure", "true");
  disclosure.style.cssText = [
    "position:fixed",
    "right:14px",
    "bottom:10px",
    "z-index:9997",
    "border-radius:999px",
    "background:rgba(9,9,11,.78)",
    "padding:6px 10px",
    "font:700 11px Arial,'Noto Sans KR',sans-serif",
    "color:#d4d4d8",
    "pointer-events:none",
  ].join(";");
  disclosure.textContent = "Feature demo · Results may vary by model and over time";
  document.body.appendChild(disclosure);
});
await showSlate({
  eyebrow: "TOMVERSE AI",
  title: "What happens when three AIs<br/>review the same business idea?",
  detail: "Each model identified a different risk as the one that mattered most.",
  cta: "One question. Multiple AI answers. One clearer view.",
});
await page.waitForTimeout(3200);
await clearSlate();

await showStep("1", "Ask a real decision question", "Not a trivia prompt — a decision with consequences");
await textarea.fill(
  "Analyze the biggest failure risks in this business idea and decide whether to proceed. Idea: a $15/month B2B2C service that gives small-gym members weekly AI-generated meal and workout plans. Team of two, $25,000 development budget, target of 30 paying gyms within six months. Include: 1) the top three failure risks, 2) a validation experiment, and 3) a Go/Pivot/Stop decision."
);
await page.waitForTimeout(3300);

await showStep("2", "Select three AI models", "OpenAI · Anthropic · Google");
const modelMenuTrigger = page
  .locator('button[aria-controls="chat-input-popover"]')
  .nth(1);
await modelMenuTrigger.click();
const modelDialog = page.locator("#chat-input-popover");
await modelDialog.waitFor({ state: "visible" });
for (const modelId of reviewModels.slice(1)) {
  const option = modelDialog.locator(
    `[data-testid="model-option"][data-model-id="${modelId}"]`
  );
  await option.click();
  await page.waitForTimeout(1300);
}
await page.keyboard.press("Escape");
await page.waitForTimeout(1100);

await showStep("3", "Generate answers together", "One question · Different priorities");
await textarea.press("Enter");
await page
  .locator('[data-testid="chat-message"][data-message-role="assistant"]')
  .filter({ hasText: "Biggest risk" })
  .waitFor({ state: "visible", timeout: 15_000 });
await page.waitForTimeout(4300);

await showStep("4", "Compare model perspectives", "Economics · Safety · Adoption");
await page.waitForTimeout(1600);
await clearStep();
await page.evaluate(() => {
  document.querySelectorAll('[data-testid="desktop-model-panel"]').forEach((panel) => {
    const container = panel.querySelector('[data-testid="chat-message-list"]');
    const answers = panel.querySelectorAll(
      '[data-testid="chat-message"][data-message-role="assistant"]'
    );
    const answer = answers[answers.length - 1];
    if (!container || !answer) return;
    container.scrollTop = Math.max(0, answer.offsetTop - container.offsetTop - 12);
  });
  document.querySelectorAll("button").forEach((button) => {
    const label = button.textContent?.replace(/\s+/g, " ").trim();
    if (label?.includes("Jump to latest")) {
      button.style.display = "none";
    }
  });
});
await page.waitForTimeout(500);
await page.evaluate(() => {
  document.querySelectorAll("button").forEach((button) => {
    const label = button.textContent?.replace(/\s+/g, " ").trim();
    if (label?.includes("Jump to latest")) {
      button.style.display = "none";
    }
  });
});
await page.screenshot({ path: comparisonScreenshotPath, type: "png" });
await showStep("4", "Compare model perspectives", "Economics · Safety · Adoption");
await page.waitForTimeout(2100);

await showStep("5", "Tomverse AI Review", "Consensus · Differences · Gaps · What to verify next");
await page.getByRole("button", { name: "AI answer cross-review" }).click();
const reviewDialog = page.getByRole("dialog", { name: "AI answer cross-review" });
await reviewDialog.getByTestId("comparison-review-setup").waitFor({ state: "visible" });
await page.waitForTimeout(2300);
await reviewDialog.getByRole("button", { name: /Run cross-review/ }).click();
try {
  await reviewDialog
    .getByText("All three answers recommend validating the idea")
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
await page.waitForTimeout(2700);

await clearStep();
await page.screenshot({ path: reviewScreenshotPath, type: "png" });
await page.screenshot({ path: posterPath, type: "png" });
await page.waitForTimeout(2500);

await showSlate({
  eyebrow: "TOMVERSE AI",
  title: "Before trusting one answer,<br/>compare what the models see differently.",
  detail: "Ask once. Compare multiple AI answers and review the important differences in one place.",
  cta: "tomverse.app",
});
await page.waitForTimeout(4000);

const video = page.video();
await page.close();
if (!video) throw new Error("Playwright did not create a marketing proof video.");
await video.saveAs(outputPath);
const temporaryVideoPath = await video.path();
await context.close();
await browser.close();
if (temporaryVideoPath !== outputPath) {
  await unlink(temporaryVideoPath).catch(() => undefined);
}

console.log(`Saved ${outputPath}`);
console.log(`Saved ${posterPath}`);
console.log(`Saved ${comparisonScreenshotPath}`);
console.log(`Saved ${reviewScreenshotPath}`);
