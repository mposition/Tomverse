import { chromium } from "@playwright/test";
import { mkdir, unlink } from "node:fs/promises";

const origin = process.env.CAPTURE_ORIGIN || "http://127.0.0.1:3100";
const outputDirectory = "public/marketing-launch/week1";
const outputPath = `${outputDirectory}/tomverse-business-risk-review-ko.webm`;
const posterPath = `${outputDirectory}/tomverse-business-risk-review-poster-ko.png`;
const comparisonScreenshotPath = `${outputDirectory}/model-answer-comparison-ko.png`;
const reviewScreenshotPath = `${outputDirectory}/ai-review-result-ko.png`;
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
  localStorage.setItem("tomverse_language", "ko");
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
    json({ theme: "dark", language: "ko", defaultModel: reviewModels[0] })
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
  title: "AI 식단 구독 사업성 검토",
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
      "**가장 큰 위험: 단위 경제성**\n\n- 헬스장이 월 비용을 부담할 이유가 아직 검증되지 않았습니다.\n- 회원당 사용률과 코치 업무 절감 효과가 불명확합니다.\n- 개발 전 5개 헬스장에서 유료 Concierge Pilot을 진행하세요.\n\n**판단: PIVOT** — 소프트웨어보다 코치 보조 서비스로 먼저 검증합니다.",
    "claude-haiku-4-5":
      "**가장 큰 위험: 신뢰와 안전**\n\n- 개인 건강정보와 부적절한 식단 권고가 핵심 위험입니다.\n- AI 단독 처방처럼 보이면 헬스장과 회원 모두 신뢰하기 어렵습니다.\n- 영양사 검토와 위험 고지 없이는 자동 추천을 출시하지 마세요.\n\n**판단: STOP 현재안** — 전문가 검토형 상품으로 재설계가 필요합니다.",
    "gemini-2-5-flash":
      "**가장 큰 위험: 도입과 유지율**\n\n- 헬스장 관리자가 새 도구를 운영하지 않으면 회원도 사용하지 않습니다.\n- 기존 상담·메신저 흐름과 연결되지 않으면 이탈 가능성이 큽니다.\n- 3개 헬스장에서 4주간 사용률과 재방문율을 측정하세요.\n\n**판단: GO 제한 실험** — 30곳 확장 전에 작은 Pilot이 필요합니다.",
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
      "핵심 위험과 검증 기준을 먼저 정의하세요.",
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
            "이 기능은 제공된 답변을 비교하며 외부 사실을 독립적으로 검증하지 않습니다.",
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
            "세 답변 모두 30개 헬스장으로 바로 확장하지 말고 소규모 Pilot으로 먼저 검증해야 한다는 데 동의합니다.",
          ],
          differences: [
            {
              issue: "가장 먼저 해결해야 할 실패 위험",
              positions: [
                { responseId: "A", position: "헬스장의 지불 의사와 단위 경제성" },
                { responseId: "B", position: "건강정보, 안전성과 전문가 검토" },
                { responseId: "C", position: "관리자 도입과 회원 유지율" },
              ],
            },
          ],
          contradictions: [
            "실행 판단이 PIVOT, STOP 현재안, GO 제한 실험으로 나뉩니다.",
          ],
          missingPoints: [
            "현재 고객획득비용, 회원 이탈률, 코치 업무 절감시간과 건강정보 처리 절차가 제공되지 않았습니다.",
          ],
          verificationNeeded: [
            "건강정보 관련 법적 의무, 영양 자문 범위와 실제 헬스장 지불 의사는 별도 확인이 필요합니다.",
          ],
          modelAssessments: [
            { responseId: "A", strengths: ["수익성 검증을 우선함"], cautions: ["안전·법적 위험 설명이 부족함"] },
            { responseId: "B", strengths: ["신뢰와 안전 위험을 구체화함"], cautions: ["수요 검증 기준이 부족함"] },
            { responseId: "C", strengths: ["실행 가능한 Pilot을 제안함"], cautions: ["전문가 검토 비용을 반영하지 않음"] },
          ],
          synthesis:
            "정식 개발을 보류하고 5개 헬스장에서 전문가 검토가 포함된 4주 Concierge Pilot을 운영하세요. 헬스장 지불 의사, 주간 회원 사용률, 코치 절감시간과 안전 이슈를 기준으로 Go/Pivot/Stop을 다시 판단하는 것이 가장 안전합니다.",
          confidence: "medium",
          limitations: ["이 결과는 답변 간 교차검토이며 외부 사실 검증이나 법률·의료 자문이 아닙니다."],
        },
        responseMap: [
          { responseId: "A", messageId: "21111111-1111-4111-8111-111111111111", modelId: reviewModels[0], modelName: "GPT-5.4 mini" },
          { responseId: "B", messageId: "31111111-1111-4111-8111-111111111111", modelId: reviewModels[1], modelName: "Claude Haiku 4.5" },
          { responseId: "C", messageId: "41111111-1111-4111-8111-111111111111", modelId: reviewModels[2], modelName: "Gemini 3.1 Flash-Lite" },
        ],
        reviewerModelId: "mistral-medium-3-1",
        usageCredits: 4,
        cached: false,
        disclaimer: "이 검토는 외부 사실 검증이 아닙니다.",
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

await page.goto(`${origin}/chat?lang=ko`, { waitUntil: "networkidle" });
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
  disclosure.textContent = "기능 시연용 데모 · 결과는 모델과 시점에 따라 달라질 수 있습니다";
  document.body.appendChild(disclosure);
});
await showSlate({
  eyebrow: "TOMVERSE AI",
  title: "하나의 사업 아이디어를<br/>세 개의 AI에게 물어보면?",
  detail: "같은 질문에서도 모델마다 가장 중요하게 보는 실패 위험은 달랐습니다.",
  cta: "One question. Multiple AI answers. One clearer view.",
});
await page.waitForTimeout(3200);
await clearSlate();

await showStep("1", "실제 의사결정 질문 입력", "단순 지식 질문이 아닌 실행 판단");
await textarea.fill(
  "다음 사업 아이디어의 가장 큰 실패 가능성을 분석하고 실행 여부를 판단해 주세요. 아이디어: 소규모 헬스장 회원에게 AI가 식단과 운동 계획을 매주 제공하는 월 19,900원 B2B2C 구독 서비스. 초기 팀 2명, 개발 예산 3,000만원, 6개월 내 유료 헬스장 30곳 목표. 반드시 ① 가장 큰 실패 요인 3개 ② 검증 실험 ③ Go/Pivot/Stop 판단을 제시하세요."
);
await page.waitForTimeout(3300);

await showStep("2", "세 개의 모델 선택", "OpenAI · Anthropic · Google");
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

await showStep("3", "답변 동시 생성", "같은 질문 · 서로 다른 우선순위");
await textarea.press("Enter");
await page
  .locator('[data-testid="chat-message"][data-message-role="assistant"]')
  .filter({ hasText: "가장 큰 위험" })
  .waitFor({ state: "visible", timeout: 15_000 });
await page.waitForTimeout(4300);

await showStep("4", "모델별 관점 비교", "수익성 · 안전 · 도입률");
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
    if (label?.includes("최신 메시지로 이동")) {
      button.style.display = "none";
    }
  });
});
await page.waitForTimeout(500);
await page.evaluate(() => {
  document.querySelectorAll("button").forEach((button) => {
    const label = button.textContent?.replace(/\s+/g, " ").trim();
    if (label?.includes("최신 메시지로 이동")) {
      button.style.display = "none";
    }
  });
});
await page.screenshot({ path: comparisonScreenshotPath, type: "png" });
await showStep("4", "모델별 관점 비교", "수익성 · 안전 · 도입률");
await page.waitForTimeout(2100);

await showStep("5", "Tomverse AI Review", "합의점·차이·누락·추가 검증을 한 번 더 정리");
await page.getByRole("button", { name: "AI 답변 교차검토" }).click();
const reviewDialog = page.getByRole("dialog", { name: "AI 답변 교차검토" });
await reviewDialog.getByTestId("comparison-review-setup").waitFor({ state: "visible" });
await page.waitForTimeout(2300);
await reviewDialog.getByRole("button", { name: /교차검토 실행/ }).click();
try {
  await reviewDialog
    .getByText("세 답변 모두 30개 헬스장으로 바로 확장하지 말고")
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
  title: "한 모델의 답을 믿기 전에<br/>답변의 차이부터 확인하세요.",
  detail: "질문은 한 번만. 여러 AI 답변과 고급 교차검토를 한곳에서.",
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
