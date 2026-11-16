import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { HelpGuideAccessProvider } from "@/components/chat/HelpGuideAccess";
import { ChatWelcomeScreen } from "@/components/chat/ChatWelcomeScreen";
import { HELP_FLAG_KEYS } from "@/lib/helpNavigationIntents";
import { SUPPORTED_LANGUAGES, type Language } from "@/lib/language";

function renderWelcome({
  signedIn = true,
  enabled = true,
  product = "chat",
  lang = "en",
  starters = true,
  recent = false,
}: {
  signedIn?: boolean;
  enabled?: boolean;
  product?: "chat" | "review";
  lang?: Language;
  starters?: boolean;
  recent?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <SessionProvider session={signedIn ? {
      user: { id: "fixture-user", name: "Fixture" },
      expires: "2099-01-01T00:00:00Z",
    } : null}>
      <LanguageProvider initialLang={lang}>
        <HelpGuideAccessProvider enabledFlagKeys={enabled ? [HELP_FLAG_KEYS.externalImport] : []}>
          <ChatWelcomeScreen
            product={product}
            recentConversations={recent ? [{ id: "fixture-conversation" }] : undefined}
            onOpenRecentConversations={recent ? () => {} : undefined}
            starterGallery={starters ? <section data-testid="chat-starter-gallery">Starter choices</section> : undefined}
          />
        </HelpGuideAccessProvider>
      </LanguageProvider>
    </SessionProvider>,
  );
}

test("the import card appears between the greeting and starter choices in all interface languages", () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    const html = renderWelcome({ lang });
    const card = html.indexOf('data-testid="chat-import-entry"');
    assert.ok(card > html.indexOf('data-testid="chat-welcome-greeting"'), lang);
    assert.ok(card < html.indexOf('data-testid="chat-starter-gallery"'), lang);
    assert.match(html, /href="\/settings\/imports\/new"/);
    assert.doesNotMatch(html, /journey\.entry|journey\.entryHint/);
    assert.equal(html.split('data-testid="chat-import-entry"').length - 1, 1);
  }
});

test("the mobile recent-chats row sits above the import card so a short screen cuts a card, not the row", () => {
  const html = renderWelcome({ recent: true });
  const row = html.indexOf('data-testid="recent-conversations-disclosure"');
  assert.ok(row > html.indexOf('data-testid="chat-welcome-greeting"'));
  assert.ok(row < html.indexOf('data-testid="chat-import-entry"'));
  assert.match(html, /data-testid="recent-conversations-disclosure"[^>]*class="[^"]*\bmin-h-11\b[^"]*\bshrink-0\b/);
});

test("the import card keeps its content height so a wrapped hint is not cut off on a narrow phone", () => {
  const html = renderWelcome({ lang: "ko" });
  assert.match(html, /data-testid="chat-import-entry"[^>]*class="[^"]*\bmin-h-16\b[^"]*\bshrink-0\b/);
  assert.doesNotMatch(html, /data-testid="chat-import-entry"[^>]*class="(?:[^"]*\s)?(?:h-16|max-h-\S+|truncate|line-clamp-\d|overflow-hidden)[\s"]/);
});

test("an available import entry does not depend on the starter catalogue being enabled", () => {
  const html = renderWelcome({ starters: false });
  assert.match(html, /data-testid="chat-import-entry"/);
  assert.doesNotMatch(html, /data-testid="chat-starter-gallery"/);
});

test("the import card respects sign-in, import availability and the current product", () => {
  for (const options of [{ signedIn: false }, { enabled: false }, { product: "review" as const }]) {
    const html = renderWelcome(options);
    assert.doesNotMatch(html, /data-testid="chat-import-entry"/);
    assert.match(html, /Starter choices/);
  }
});
