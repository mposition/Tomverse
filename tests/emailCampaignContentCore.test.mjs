import assert from "node:assert/strict";
import test from "node:test";

import {
  CampaignContentError,
  deliveryContentForLanguage,
  localizedCampaignEventPayload,
  readCampaignContentByLocale,
} from "../lib/emailCampaignContentCore.ts";

const content = {
  ko: { subject: "한국어" },
  en: { subject: "English" },
};

test("campaign content requires every approved locale", () => {
  assert.deepEqual(readCampaignContentByLocale(content, ["ko", "en"]), content);
  assert.throws(
    () => readCampaignContentByLocale(content, ["ko", "fr"]),
    CampaignContentError
  );
});

test("a delivery snapshots only its resolved locale", () => {
  const event = localizedCampaignEventPayload({
    locales: ["ko", "en"],
    contentByLocale: content,
  });
  assert.deepEqual(deliveryContentForLanguage(event, "ko"), {
    language: "ko",
    payload: content.ko,
  });
});

test("an unapproved recipient language falls back only to approved copy", () => {
  const withEnglish = localizedCampaignEventPayload({
    locales: ["ko", "en"],
    contentByLocale: content,
  });
  assert.equal(deliveryContentForLanguage(withEnglish, "fr").language, "en");

  const koreanOnly = localizedCampaignEventPayload({
    locales: ["ko"],
    contentByLocale: { ko: content.ko },
  });
  assert.equal(deliveryContentForLanguage(koreanOnly, "fr").language, "ko");
});

test("ordinary email event payloads remain unchanged", () => {
  const payload = { name: "Ada" };
  assert.deepEqual(deliveryContentForLanguage(payload, "en"), {
    language: "en",
    payload,
  });
});
