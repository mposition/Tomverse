import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../../components/LanguageProvider";
import { MobileConnectGrant } from "../../components/auth/MobileConnectGrant";

test("connection code creation starts disabled and asks the owner to compare the app's public request ID", () => {
  const challenge = "a".repeat(35) + "request8";
  const markup = renderToStaticMarkup(createElement(LanguageProvider, { initialLang: "en", children:
    createElement(MobileConnectGrant, { challenge }),
  }));
  assert.ok(markup.includes('data-testid="mobile-pairing-request">request8'));
  assert.ok(markup.includes("matches the request shown in my Tomverse app"));
  assert.match(markup, /<button[^>]*disabled=""[^>]*data-testid="mobile-create-code"/);
  assert.ok(!markup.includes('id="mobile-pairing-code"'));
  assert.ok(!markup.includes(challenge));
});
