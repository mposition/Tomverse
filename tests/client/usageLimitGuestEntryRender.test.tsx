import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";

import { LanguageProvider } from "@/components/LanguageProvider";
import { UsageLimitModal } from "@/components/chat/UsageLimitModal";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { GeneratedArtifactCard } from "@/components/chat/GeneratedArtifactCard";
import { chatProductUiCopy } from "@/lib/chatProductUiCopy";
import { SUPPORTED_LANGUAGES, type Language } from "@/lib/language";
import { en } from "@/locales/en";

const render = (language: Language, guestImportAvailable: boolean) =>
  renderToStaticMarkup(
    <LanguageProvider initialLang={language}>
      <UsageLimitModal
        open
        onClose={() => {}}
        isGuestMode
        isAccountMonthlyLimitReached={false}
        accountPlan={null}
        dailyCreditLimit={0}
        planCreditsRemaining={0}
        purchasedCreditsRemaining={0}
        dailyResetLabel=""
        estimatedRequestCredits={1}
        totalAvailableCredits={0}
        creditShortfall={1}
        signInCallbackUrl="/chat?lang=en"
        currentChatId="guest-chat-local"
        guestImportAvailable={guestImportAvailable}
      />
    </LanguageProvider>
  );

test("the Chat guest limit offers sign-in without promising account import in every locale", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const html = render(language, false);
    assert.ok(html.includes(chatProductUiCopy[language].guestChatSignInDescription));
    assert.match(html, /data-testid="usage-limit-guest-signin"/);
    assert.match(html, /href="\/auth\/signin\?callbackUrl=%2Fchat%3Flang%3Den"/);
    assert.doesNotMatch(html, /text-blue-100/);
  }
  const html = render("en", false);
  assert.ok(!html.includes(en.chat.continueConversationCta));
  assert.ok(!html.includes(en.chat.continueConversationCtaSubtext));
});

test("the Review guest limit retains its existing continue-and-save action", () => {
  const html = render("en", true);
  assert.ok(html.includes(en.chat.continueConversationCta));
  assert.ok(html.includes(en.chat.continueConversationCtaSubtext));
  assert.ok(html.includes(en.chat.guestLimitReachedBody));
});

test("a Guest Chat quota error uses a general sign-in action and browser-local disclosure", () => {
  const html = renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang="en">
        <ChatMessageList
          messages={[{ id: "guest-quota", role: "assistant", status: "error",
            content: "Guest quota reached", errorCode: "CHAT_QUOTA_EXCEEDED" }]}
          isGuestMode
          guestImportAvailable={false}
          currentProduct="chat"
          currentChatId="guest-chat-local"
        />
      </LanguageProvider>
    </SessionProvider>
  );
  assert.ok(html.includes(en.auth.login));
  assert.ok(html.includes(chatProductUiCopy.en.guestChatSignInDescription));
  assert.ok(!html.includes(en.chat.continueConversationCta));
  assert.ok(!html.includes(en.chat.guestQuotaLoginBenefitHint));
  assert.match(html, /href="\/auth\/signin\?callbackUrl=%2Fchat%3Flang%3Den"/);
});

test("shared quota and artifact sign-in actions return to the product that rendered them", () => {
  const reviewQuota = renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang="en">
        <ChatMessageList
          messages={[{ id: "review-quota", role: "assistant", status: "error",
            content: "Guest quota reached", errorCode: "CHAT_QUOTA_EXCEEDED" }]}
          isGuestMode
          guestImportAvailable
          currentProduct="review"
          currentChatId="guest-review-local"
        />
      </LanguageProvider>
    </SessionProvider>
  );
  assert.match(reviewQuota, /href="\/auth\/signin\?callbackUrl=%2Freview%3Flang%3Den"/);

  const chatArtifact = renderToStaticMarkup(
    <LanguageProvider initialLang="en">
      <GeneratedArtifactCard
        artifact={{
          id: "artifact-blocked",
          ordinal: 0,
          format: "xlsx",
          filename: "report.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          byteSize: 0,
          status: "blocked",
          failureCode: "sign_in_required",
        }}
        isGuestMode
        currentProduct="chat"
      />
    </LanguageProvider>
  );
  assert.match(chatArtifact, /href="\/auth\/signin\?callbackUrl=%2Fchat%3Flang%3Den"/);

  const renderedReviewArtifact = renderToStaticMarkup(
    <LanguageProvider initialLang="en">
      <GeneratedArtifactCard
        artifact={{
          id: "artifact-blocked",
          ordinal: 0,
          format: "xlsx",
          filename: "report.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          byteSize: 0,
          status: "blocked",
          failureCode: "sign_in_required",
        }}
        isGuestMode
        currentProduct="review"
      />
    </LanguageProvider>
  );
  assert.match(renderedReviewArtifact, /href="\/auth\/signin\?callbackUrl=%2Freview%3Flang%3Den"/);
});
