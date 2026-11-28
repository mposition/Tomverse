import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";

import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { SavedPromptEditor, SavedPromptsTool } from "@/components/chat/SavedPromptsTool";
import { SAVED_PROMPT_LIMITS } from "@/lib/savedPromptsCore";
import { SidebarSelectionBar } from "@/components/chat/SidebarSelectionBar";
import type { Conversation } from "@/components/chat/types";
import { conversationToolsCopy } from "@/locales/conversationTools";

const copy = conversationToolsCopy.en;
const noop = () => {};

const bar = (props: Partial<React.ComponentProps<typeof SidebarSelectionBar>> = {}) =>
  renderToStaticMarkup(
    <SidebarSelectionBar
      copy={copy}
      active={false}
      onStart={noop}
      onEnd={noop}
      selectedCount={0}
      visibleCount={3}
      limit={50}
      onSelectAll={noop}
      archivedView={false}
      busy={false}
      onArchive={noop}
      onDelete={async () => {}}
      touch={false}
      {...props}
    />
  );

test("selection mode starts from one control, and is not offered over an empty list", () => {
  assert.match(bar(), /data-testid="sidebar-selection-start"/);
  assert.equal(bar({ visibleCount: 0 }), "");
});

test("while selecting, the bar is a named toolbar that announces the count", () => {
  const html = bar({ active: true, selectedCount: 2 });
  assert.match(html, /role="toolbar"/);
  assert.match(html, /aria-label="Select"/);
  assert.match(html, /aria-describedby="[^"]+-selection-hint"/);
  assert.match(html, /role="status" aria-live="polite" data-testid="sidebar-selection-count"[^>]*>2 selected</);
  assert.match(html, /data-testid="sidebar-selection-delete"/);
  assert.match(html, /data-testid="sidebar-selection-archive"[^>]*>.*Archive</);
  // Nothing to act on: the actions wait for a selection.
  const empty = bar({ active: true, selectedCount: 0 });
  assert.match(empty, /data-testid="sidebar-selection-delete"[^>]*disabled=""/);
  assert.match(empty, /data-testid="sidebar-selection-archive"[^>]*disabled=""/);
});

test("the archived view offers Unarchive in place of Archive, and the drawer keeps 44px targets", () => {
  const html = bar({ active: true, selectedCount: 1, archivedView: true, touch: true });
  assert.match(html, /Unarchive/);
  assert.ok(!/>Archive</.test(html));
  assert.match(html, /min-h-11/);
});

test("the saved prompts row says what it does, and asks a guest to sign in", () => {
  const render = (isGuestMode: boolean) =>
    renderToStaticMarkup(
      <SavedPromptsTool language="ko" value="" isGuestMode={isGuestMode} disabled={false} onInsert={noop} onDone={noop} />
    );
  assert.match(render(false), /data-testid="tools-saved-prompts-row"[^>]*aria-haspopup="dialog"/);
  assert.match(render(false), /저장한 프롬프트/);
  assert.match(render(true), /로그인하면/);
});

const editor = (body: string) =>
  renderToStaticMarkup(
    <SavedPromptEditor
      language="ko"
      editing={{ id: null, title: "긴 프롬프트", body }}
      busy={false}
      onChange={noop}
      onCancel={noop}
      onSave={noop}
    />
  );

test("a prompt over the length limit is held whole, says how long it is, and cannot be saved", () => {
  const body = `${"가".repeat(SAVED_PROMPT_LIMITS.bodyMax)}끝부분`;
  const html = editor(body);
  // Not cut to fit: the whole text, its last characters included, is in the editor.
  assert.ok(html.includes("끝부분"));
  assert.ok(!/data-testid="saved-prompt-body"[^>]*maxLength/i.test(html));
  assert.match(html, /data-testid="saved-prompt-body"[^>]*aria-invalid="true"/);
  assert.match(
    html,
    new RegExp(`role="alert"[^>]*>저장할 수 있는 길이를 넘었습니다\\(현재 ${body.length}자, 최대 ${SAVED_PROMPT_LIMITS.bodyMax}자\\)`)
  );
  assert.match(html, /data-testid="saved-prompt-save"[^>]*disabled=""/);
});

test("a prompt within the limit shows its count and can be saved", () => {
  const body = "회의록을 요약해 줘";
  const html = editor(body);
  assert.match(html, new RegExp(`>${body.length}/${SAVED_PROMPT_LIMITS.bodyMax}<`));
  assert.ok(!html.includes('role="alert"'));
  assert.ok(!/data-testid="saved-prompt-save"[^>]*disabled=""/.test(html));
});

const row = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title: `Conversation ${id}`,
  kind: "chat",
  surface: "workspace",
  selectedModels: ["gpt-6-luna"],
  updatedAt: new Date().toISOString(),
  ...extra,
});

const sidebar = (conversations: Conversation[]) =>
  renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang="en">
        <ChatSidebar
          conversations={conversations}
          currentChatId={null}
          onNewChat={noop}
          onSelectConversation={noop}
          onRename={noop}
          onDelete={noop}
          onShare={noop}
          onRevokeShare={noop}
          onDownload={noop}
        />
      </LanguageProvider>
    </SessionProvider>
  );

test("an archived conversation is out of the default list, pinned or not, and selection mode is offered", () => {
  const html = sidebar([row("live"), row("put-away", { archived: true, pinned: true })]);
  assert.match(html, /data-conversation-id="live"/);
  assert.ok(!html.includes('data-conversation-id="put-away"'), "archived rows are not in the default list");
  assert.ok(!html.includes('data-testid="sidebar-pinned-header"'), "an archived pin draws no pinned section");
  assert.match(html, /data-testid="sidebar-selection-start"/);
});

// The organizer (where the Archived filter lives) starts collapsed in a static
// render, so the filter row itself is not asserted here.
