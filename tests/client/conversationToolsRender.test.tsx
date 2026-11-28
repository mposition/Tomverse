import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";

import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { SavedPromptsTool } from "@/components/chat/SavedPromptsTool";
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
