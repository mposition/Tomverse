import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  allowProductSwitchNavigation,
  ChatProductSwitcherView,
} from "@/components/chat/ChatProductSwitcher";
import { chatProductUiCopy } from "@/lib/chatProductUiCopy";
import { SUPPORTED_LANGUAGES } from "@/lib/language";

const renderSwitcher = (
  props: Parameters<typeof ChatProductSwitcherView>[0]
) => renderToStaticMarkup(createElement(ChatProductSwitcherView, props));

test("Chat is current and Review remains a navigation link", () => {
  const html = renderSwitcher({ currentProduct: "chat", language: "en" });

  assert.match(
    html,
    /<a(?=[^>]*data-testid="chat-product-chat")(?=[^>]*href="\/chat\?lang=en")(?=[^>]*aria-current="page")[^>]*>/
  );
  assert.match(
    html,
    /<a(?=[^>]*data-testid="chat-product-review")(?=[^>]*href="\/review\?lang=en")[^>]*>/
  );
});

test("Review is current without pretending Smart Adaptive is a product", () => {
  const html = renderSwitcher({ currentProduct: "review", language: "ko" });

  assert.match(
    html,
    /aria-label="Tomverse Chat\. 스마트 자동\. [^"]+"/
  );
  assert.match(
    html,
    /aria-label="Tomverse Review\. 모델 비교\. [^"]+"/
  );
  assert.match(
    html,
    /<a(?=[^>]*data-testid="chat-product-review")(?=[^>]*aria-current="page")[^>]*>/
  );
});

test("every locale distinguishes the two products and names both features", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const copy = chatProductUiCopy[language];
    assert.notEqual(copy.chat.description, copy.review.description);
    assert.ok(copy.chat.feature.length > 0);
    assert.ok(copy.review.feature.length > 0);
    assert.ok(copy.chat.description.length > 0);
    assert.ok(copy.review.description.length > 0);
    assert.ok(copy.guestChatDescription.toLowerCase().includes(copy.chat.feature.toLowerCase()));
    assert.doesNotMatch(copy.guestChatDescription, /[–—]/);
  }
});

test("the switcher has one named navigation region and 44px product targets", () => {
  const html = renderSwitcher({ currentProduct: "chat", language: "en" });

  assert.match(
    html,
    new RegExp(`aria-label="${chatProductUiCopy.en.selectorLabel}"`)
  );
  assert.equal((html.match(/min-h-11/g) ?? []).length, 2);
  assert.match(html, /max-w-\[236px\]/);
  assert.match(html, /lucide-message-square/);
  assert.match(html, /lucide-panels-top-left/);
});

test("a Review visitor can enter the Chat trial directly in every locale", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const html = renderSwitcher({
      currentProduct: "review",
      language,
    });

    assert.match(html, new RegExp(`href="/chat\\?lang=${language}"`));
    assert.doesNotMatch(html, /\/auth\/signin/);
  }
});

test("pending switchers have unique described-by targets and keep 44px links", () => {
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(ChatProductSwitcherView, {
        currentProduct: "chat",
        language: "en",
        disabled: true,
      }),
      createElement(ChatProductSwitcherView, {
        currentProduct: "review",
        language: "en",
        disabled: true,
      })
    )
  );
  const ids = Array.from(
    html.matchAll(/id="(chat-product-switch-disabled-description-[^"]+)"/g),
    (match) => match[1]
  );

  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) {
    assert.match(html, new RegExp(`aria-describedby="${id}"`));
  }
  assert.equal((html.match(/aria-disabled="true"/g) ?? []).length, 4);
  assert.equal((html.match(/min-h-11/g) ?? []).length, 4);
});

test("pending and rejected snapshots block navigation without duplicate callbacks", () => {
  let callbackCount = 0;
  const callback = () => {
    callbackCount += 1;
    return false;
  };

  assert.equal(
    allowProductSwitchNavigation({
      currentProduct: "chat",
      nextProduct: "review",
      disabled: true,
      onProductSwitch: callback,
    }),
    false
  );
  assert.equal(callbackCount, 0);
  assert.equal(
    allowProductSwitchNavigation({
      currentProduct: "chat",
      nextProduct: "review",
      disabled: false,
      onProductSwitch: callback,
    }),
    false
  );
  assert.equal(callbackCount, 1);
});

test("an accepted idle snapshot admits canonical navigation once", () => {
  const calls: string[] = [];

  assert.equal(
    allowProductSwitchNavigation({
      currentProduct: "chat",
      nextProduct: "review",
      disabled: false,
      onProductSwitch: (product) => {
        calls.push(product);
        return true;
      },
    }),
    true
  );
  assert.deepEqual(calls, ["review"]);
});
