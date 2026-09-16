import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  deriveAssistantKnowledgeGuideStage,
  assistantKnowledgeCreateHref,
  assistantKnowledgeGuideHref,
  assistantKnowledgeGuideCaptionLabel,
  assistantKnowledgeGuideCaptionPath,
  assistantKnowledgeGuideContentLanguage,
  assistantKnowledgeGuideVideoPath,
  assistantKnowledgeGuideUrl,
  assistantKnowledgeProfileHref,
  assistantKnowledgeSignInHref,
  ASSISTANT_KNOWLEDGE_GUIDE_POSTER_PATH,
  ASSISTANT_KNOWLEDGE_GUIDE_POSTER_URL,
  ASSISTANT_KNOWLEDGE_GUIDE_CAPTION_LABELS,
  ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATHS,
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

test("each reviewed tutorial uses the UI language it teaches", () => {
  assert.equal(assistantKnowledgeGuideContentLanguage("ko"), "ko");
  assert.equal(assistantKnowledgeGuideContentLanguage("zh"), "zh");
  for (const language of ["en", "fr", "de", "es", "pt"]) {
    assert.equal(assistantKnowledgeGuideContentLanguage(language), "en");
  }

  for (const language of ["ko", "en", "zh"]) {
    const expectedPath =
      `/guides/assistant-knowledge/assistant-knowledge.${language}.mp4`;
    assert.equal(ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATHS[language], expectedPath);
    assert.equal(assistantKnowledgeGuideVideoPath(language), expectedPath);
    assert.equal(
      assistantKnowledgeGuideCaptionPath(language),
      `/guides/assistant-knowledge/assistant-knowledge.${language}.vtt`
    );
    assert.equal(
      assistantKnowledgeGuideCaptionLabel(language),
      ASSISTANT_KNOWLEDGE_GUIDE_CAPTION_LABELS[language]
    );
    assert.equal(
      existsSync(
        fileURLToPath(
          new URL(`../public${expectedPath}`, import.meta.url)
        )
      ),
      true
    );
  }

  assert.equal(
    assistantKnowledgeGuideVideoPath("fr"),
    ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATHS.en
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

test("all caption tracks stay ordered within the exported timeline", () => {
  assert.ok(ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_DURATION_SECONDS < 49);

  for (const language of ["ko", "en", "zh"]) {
    const cues = readCaptionCues(language);
    assert.equal(cues.length, 6);
    assert.ok(cues[0].start >= 0 && cues[0].start <= 1.5);
    for (let index = 1; index < cues.length; index += 1) {
      assert.ok(cues[index - 1].end <= cues[index].start);
      assert.ok(
        cues[index].start - cues[index - 1].end <= 0.25,
        `${language} captions leave an unintended gap before cue ${index + 1}`
      );
    }
    assert.ok(
      cues.at(-1).end <= ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_DURATION_SECONDS
    );
    assert.ok(
      cues.at(-1).end >=
        ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_DURATION_SECONDS - 1,
      `${language} captions do not cover the reviewed closing frame`
    );
  }
});

test("media regeneration preserves the reviewed closing captions and distinct slates", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../scripts/build-assistant-knowledge-tutorial-media.mjs", import.meta.url)
    ),
    "utf8"
  );

  for (const closingCue of [
    '["00:41.400", "00:43.500", "이제 나의 AI 어시스턴트를 만들어 보세요."]',
    '["00:35.000", "00:43.500", "Ready to begin? Create your assistant, add Knowledge, and start the first conversation."]',
    '["00:36.500", "00:43.500", "现在就创建你的 AI 助手，添加 Knowledge，并开始第一次对话。"]',
  ]) {
    assert.ok(source.includes(closingCue), `missing generator cue: ${closingCue}`);
  }
  assert.match(source, /slateSvg\(\{ label: copy\.label \}\)/);
  assert.doesNotMatch(source, /slateSvg\(copy\)/);
});

test("the public guide degrades to the unavailable import state when the flag read fails", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../app/(site)/(marketing)/guides/assistant-knowledge/page.tsx",
        import.meta.url
      )
    ),
    "utf8"
  );

  assert.match(source, /try\s*\{[\s\S]*isAssistantPackageImportEnabled\(\)/);
  assert.match(source, /catch \(error\) \{[\s\S]*return false;/);
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
