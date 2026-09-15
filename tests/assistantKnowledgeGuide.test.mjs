import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATH,
  ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_DURATION_SECONDS,
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

test("the reviewed tutorial is served from the Tomverse guide origin", () => {
  assert.equal(
    ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATH,
    "/guides/assistant-knowledge/assistant-knowledge.mp4"
  );
  assert.equal(
    existsSync(
      fileURLToPath(
        new URL(
          "../public/guides/assistant-knowledge/assistant-knowledge.mp4",
          import.meta.url
        )
      )
    ),
    true
  );
});

const cueSeconds = (minutes, seconds, milliseconds) =>
  Number(minutes) * 60 + Number(seconds) + Number(milliseconds) / 1000;

const readCaptionCues = (language) => {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        `../public/guides/assistant-knowledge/assistant-knowledge.${language}.vtt`,
        import.meta.url
      )
    ),
    "utf8"
  );
  return [
    ...source.matchAll(
      /(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2})\.(\d{3})/g
    ),
  ].map((match) => ({
    start: cueSeconds(match[1], match[2], match[3]),
    end: cueSeconds(match[4], match[5], match[6]),
  }));
};

test("both caption tracks cover one contiguous exported timeline", () => {
  assert.ok(ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_DURATION_SECONDS < 49);

  for (const language of ["ko", "en"]) {
    const cues = readCaptionCues(language);
    assert.equal(cues.length, 5);
    assert.equal(cues[0].start, 0);
    for (let index = 1; index < cues.length; index += 1) {
      assert.equal(cues[index - 1].end, cues[index].start);
    }
    assert.equal(
      cues.at(-1).end,
      ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_DURATION_SECONDS
    );
  }
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
