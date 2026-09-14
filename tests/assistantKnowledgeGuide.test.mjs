import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveAssistantKnowledgeGuideStage,
  assistantKnowledgeCreateHref,
  assistantKnowledgeGuideHref,
  assistantKnowledgeGuideUrl,
  assistantKnowledgeProfileHref,
  assistantKnowledgeSignInHref,
  ASSISTANT_KNOWLEDGE_GUIDE_POSTER_PATH,
  ASSISTANT_KNOWLEDGE_GUIDE_POSTER_URL,
  isAssistantKnowledgeGuideValue,
  isAssistantKnowledgeGuideRequest,
} from "../lib/assistantKnowledgeGuide.ts";

test("the setup guide resumes from persisted Knowledge state", () => {
  assert.equal(
    deriveAssistantKnowledgeGuideStage({ isNew: true, savedKnowledgeCount: 4 }),
    "create_assistant"
  );
  assert.equal(
    deriveAssistantKnowledgeGuideStage({ isNew: false, savedKnowledgeCount: null }),
    "add_knowledge"
  );
  assert.equal(
    deriveAssistantKnowledgeGuideStage({ isNew: false, savedKnowledgeCount: 0 }),
    "add_knowledge"
  );
  assert.equal(
    deriveAssistantKnowledgeGuideStage({ isNew: false, savedKnowledgeCount: 1 }),
    "start_chat"
  );
});

test("newsletter guide links keep attribution and language on Tomverse paths", () => {
  const guide = new URL(assistantKnowledgeGuideHref("ko"), "https://tomverse.app");
  assert.equal(guide.pathname, "/guides/assistant-knowledge");
  assert.equal(guide.searchParams.get("lang"), "ko");
  assert.equal(guide.searchParams.get("utm_source"), "newsletter");
  assert.equal(guide.searchParams.get("utm_medium"), "email");
  assert.equal(guide.searchParams.get("utm_campaign"), "assistant_knowledge_launch");
  assert.equal(
    ASSISTANT_KNOWLEDGE_GUIDE_POSTER_PATH,
    "/guides/assistant-knowledge/poster"
  );
  assert.equal(
    ASSISTANT_KNOWLEDGE_GUIDE_POSTER_URL,
    "https://tomverse.app/guides/assistant-knowledge/poster"
  );
  assert.equal(assistantKnowledgeGuideUrl("ko"), guide.toString());
});

test("the setup guide uses a literal flag and encodes opaque profile ids", () => {
  assert.equal(
    isAssistantKnowledgeGuideRequest(
      new URLSearchParams("guide=assistant-knowledge")
    ),
    true
  );
  assert.equal(
    isAssistantKnowledgeGuideRequest(new URLSearchParams("guide=elsewhere")),
    false
  );
  assert.equal(isAssistantKnowledgeGuideValue(["assistant-knowledge"]), false);
  assert.equal(
    assistantKnowledgeCreateHref("en"),
    "/settings/assistants/new?guide=assistant-knowledge&lang=en"
  );
  assert.match(
    assistantKnowledgeProfileHref("profile/with spaces", "ko"),
    /^\/settings\/assistants\/profile%2Fwith%20spaces\?/
  );
});

test("guest entry signs in with a fixed local callback", () => {
  const href = new URL(assistantKnowledgeSignInHref("ko"), "https://tomverse.app");
  assert.equal(href.pathname, "/auth/signin");
  assert.equal(href.searchParams.get("lang"), "ko");
  assert.equal(
    href.searchParams.get("callbackUrl"),
    "/settings/assistants/new?guide=assistant-knowledge&lang=ko"
  );
});
