import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

// The Deep Research 502 regression, from the client side.
//
// components/chat/ChatApp.tsx keeps a UI-only greeting bubble (id "welcome")
// in an empty conversation, and the send path used to post it to /api/chat
// alongside the first real question. For Perplexity's async deep-research
// endpoint that is an assistant turn ahead of the first user turn, which it
// rejects with 400 invalid_message -- "after the (optional) system message(s),
// user or tool message(s) should alternate with assistant message(s)" -- and
// app/api/chat/route.ts turned into DEEP_RESEARCH_SUBMIT_FAILED 502. Every
// Deep Research submit from a new conversation failed on staging.
//
// The server now normalizes the conversation as well (see
// lib/perplexityDeepResearch.ts and tests/perplexityDeepResearch.test.mjs).
// This spec pins the other half: what the browser actually puts on the wire.

const DEEP_RESEARCH_MODEL_ID = "perplexity/sonar-deep-research";
const WELCOME_COPY = "Hello! How can I help you today?";
const FIRST_QUESTION = "Research the 2026 solid-state battery market";
const FOLLOW_UP_QUESTION = "Now compare the supply chains";
const FIRST_REPORT = "Deep research report: pilot lines start in 2026.";
const FOLLOW_UP_REPORT = "Deep research report: two suppliers dominate.";

type CapturedMessage = { id?: string; role?: string; content?: string };
type CapturedChatRequest = { messages?: CapturedMessage[]; modelId?: string };

const asProPlan = async (page: Page) => {
  // Deep Research is a Pro model (lib/models.ts), so the Free defaults in
  // mockAuthenticatedApi would gate the send before it is ever built.
  await page.unroute("**/api/user/usage**");
  await page.route("**/api/user/usage**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plan: "Pro",
        subscription: {
          status: "active",
          billingInterval: "monthly",
          currentPeriodEnd: "2099-01-01T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
        usage: {
          creditsDay: 0,
          creditsMonth: 0,
          proModelResponsesMonth: 0,
          tokensDay: 0,
          tokensMonth: 0,
          costDay: 0,
          costMonth: 0,
        },
        balances: {
          dailyRemainingCredits: 300,
          dailyResetsAt: "2099-01-02T00:00:00.000Z",
          planRemainingCredits: 3000,
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
          proModelResponsesMonth: 3000,
          tokensDay: 0,
          tokensMonth: 0,
          costDay: 0,
          costMonth: 0,
          maxModels: 3,
          allowAttachments: true,
          allowSharing: true,
          allowDownloads: true,
        },
      }),
    })
  );
};

/**
 * Makes Deep Research the account's default model, so a brand-new
 * conversation opens with exactly one panel and it is the deep-research one.
 */
const selectOnlyDeepResearch = async (page: Page) => {
  await page.unroute("**/api/user/settings");
  await page.route("**/api/user/settings**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        theme: "dark",
        language: "en",
        defaultModel: DEEP_RESEARCH_MODEL_ID,
        timeZone: "UTC",
        timeZoneInitializedAt: "2026-05-01T00:00:00.000Z",
        timeZoneChangedAt: "2026-05-01T00:00:00.000Z",
        timeZoneChangeAllowedAt: "2026-05-31T00:00:00.000Z",
      }),
    });
  });
};

/**
 * Stands in for the async submit/poll pair: POST /api/chat answers like the
 * real route does for a deep-research model (immediate job id plus
 * X-Chat-Response-Mode: async-job), and the status endpoint reports
 * in-progress once before completing, so the client's polling loop is
 * genuinely exercised rather than short-circuited.
 */
const mockDeepResearchJob = async (page: Page) => {
  const chatRequests: CapturedChatRequest[] = [];
  const reports = [FIRST_REPORT, FOLLOW_UP_REPORT];
  let statusPolls = 0;

  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    chatRequests.push(route.request().postDataJSON() as CapturedChatRequest);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "X-Request-ID": `qa-trace-deep-research-${chatRequests.length}`,
        "X-Chat-Response-Mode": "async-job",
      },
      body: JSON.stringify({
        deepResearchJobId: `qa-deep-research-job-${chatRequests.length}`,
        status: "submitted",
      }),
    });
  });

  await page.route("**/api/chat/deep-research/status", async (route) => {
    statusPolls += 1;
    // The very first poll is still running, so the panel has to keep polling
    // to reach a result -- a completed-on-first-poll mock would pass even if
    // the client never polled again.
    const isFirstPoll = statusPolls === 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        isFirstPoll
          ? { status: "in_progress" }
          : {
              status: "completed",
              content: reports[Math.min(chatRequests.length - 1, reports.length - 1)],
            }
      ),
    });
  });

  return {
    chatRequests,
    statusPollCount: () => statusPolls,
  };
};

const assertNoWelcomeTurn = (request: CapturedChatRequest, context: string) => {
  const messages = request.messages ?? [];
  expect(messages.length, `${context}: no messages were sent`).toBeGreaterThan(0);
  expect(
    messages.map((message) => message.id),
    `${context}: the UI-only welcome message was sent to the provider`
  ).not.toContain("welcome");
  expect(
    messages.map((message) => message.content),
    `${context}: the welcome greeting was sent as conversation content`
  ).not.toContain(WELCOME_COPY);
  expect(
    messages[0]?.role,
    `${context}: the conversation must start with the user's question`
  ).toBe("user");
  expect(
    messages[messages.length - 1]?.role,
    `${context}: the provider must be left answering a user turn`
  ).toBe("user");
  for (const [index, message] of messages.entries()) {
    expect(
      message.role,
      `${context}: message ${index} broke the user/assistant alternation`
    ).toBe(index % 2 === 0 ? "user" : "assistant");
  }
};

test("a Deep Research first question posts only the user turn, then renders the polled report", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);

  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, { selectedModels: [DEEP_RESEARCH_MODEL_ID] });
  await asProPlan(page);
  await selectOnlyDeepResearch(page);
  const job = await mockDeepResearchJob(page);

  await page.goto("/chat?lang=en");

  // A brand-new conversation -- the state whose panel holds the UI-only
  // greeting message that used to poison the request. The centred welcome
  // screen hides that bubble from view, which is precisely why the leak was
  // invisible until Perplexity rejected it.
  await expect(page.getByTestId("chat-welcome-greeting")).toBeVisible();

  await sendChatMessage(page, testInfo, FIRST_QUESTION);

  await expect.poll(() => job.chatRequests.length).toBe(1);
  const firstRequest = job.chatRequests[0]!;
  expect(firstRequest.modelId).toBe(DEEP_RESEARCH_MODEL_ID);
  assertNoWelcomeTurn(firstRequest, "first question");
  expect(firstRequest.messages).toHaveLength(1);
  expect(firstRequest.messages?.[0]?.content).toBe(FIRST_QUESTION);

  // The async path really was taken: the panel polled the status endpoint
  // until the job completed, then showed the report.
  await expect(page.getByText(FIRST_REPORT)).toBeVisible({ timeout: 30_000 });
  expect(job.statusPollCount()).toBeGreaterThan(1);

  // A follow-up in the same conversation keeps the real history and still
  // never carries the greeting.
  await sendChatMessage(page, testInfo, FOLLOW_UP_QUESTION);

  await expect.poll(() => job.chatRequests.length).toBe(2);
  const followUpRequest = job.chatRequests[1]!;
  assertNoWelcomeTurn(followUpRequest, "follow-up question");
  expect(followUpRequest.messages?.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
  expect(followUpRequest.messages?.[0]?.content).toBe(FIRST_QUESTION);
  expect(followUpRequest.messages?.[2]?.content).toBe(FOLLOW_UP_QUESTION);

  await expect(page.getByText(FOLLOW_UP_REPORT)).toBeVisible({ timeout: 30_000 });
});
