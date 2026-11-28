import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageProvider } from "@/components/LanguageProvider";
import { AssistantSkillExport } from "@/components/assistants/AssistantSkillExport";

const render = (lang: "en" | "ko", profileId: string) =>
  renderToStaticMarkup(
    <LanguageProvider initialLang={lang} forceInitialLang>
      <AssistantSkillExport profileId={profileId} className="section" buttonClassName="button" />
    </LanguageProvider>
  );

test("the download is a link to the skill route that saves as SKILL.md", () => {
  const html = render("en", "clx123");
  assert.match(html, /data-testid="assistant-skill-export"/);
  assert.match(html, /href="\/api\/assistant-profiles\/clx123\/skill"/);
  assert.match(html, /download="SKILL\.md"/);
  assert.match(html, /Export as SKILL\.md/);
  assert.match(html, /Download SKILL\.md/);
  // The limits of the file are said where the button is, not discovered after.
  assert.match(html, /Documents, model and tool settings are not included/);
});

test("the copy follows the language", () => {
  const html = render("ko", "clx123");
  assert.match(html, /SKILL\.md로 내보내기/);
  assert.match(html, /SKILL\.md 내려받기/);
});

test("an id with a path character cannot change the route it points at", () => {
  const html = render("en", "a/../b");
  assert.match(html, /href="\/api\/assistant-profiles\/a%2F\.\.%2Fb\/skill"/);
});
