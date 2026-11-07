import assert from "node:assert/strict";
import test from "node:test";
import { MessageCircle, Paperclip } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  EmergencyStopsSection,
  FeatureSwitchesSection,
} from "@/components/admin/PlatformSwitchSections";
import { AdminToggleSwitch } from "@/components/admin/ui/AdminToggleSwitch";

/**
 * Feature flags, rendered. The sections only draw what the panel hands them;
 * the save, its step-up and its audit stay in `PlatformSettingsPanel`, which is
 * covered by the source contracts and the e2e journeys.
 */

const noop = () => {};

test("a switch is a real checkbox with the switch role and a name", () => {
  const html = renderToStaticMarkup(
    <AdminToggleSwitch checked label="AI chat" onChange={noop} data-testid="x" />
  );
  assert.match(html, /<input[^>]*type="checkbox"/);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-label="AI chat"/);
  assert.match(html, /checked=""/);
  assert.match(html, /data-testid="x"/);
});

test("a disabled switch is disabled", () => {
  const html = renderToStaticMarkup(<AdminToggleSwitch checked={false} label="x" disabled onChange={noop} />);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /checked=""/);
});

const stops = (enabled: boolean[]) => [
  { id: "ai-chat", icon: MessageCircle, label: "AI chat", detail: "Answers from every model", enabled: enabled[0], onChange: noop },
  { id: "attachments", icon: Paperclip, label: "Attachments", detail: "Uploading and reading files", enabled: enabled[1], onChange: noop },
];

test("the emergency stops are one red zone with a card each, running or stopped in words", () => {
  const html = renderToStaticMarkup(<EmergencyStopsSection items={stops([true, false])} />);
  assert.match(html, /<h2[^>]*>Emergency stops</);
  assert.match(html, /border-red-500\/40/);
  assert.match(html, /data-testid="admin-kill-switch-ai-chat"[^>]*data-enabled="true"/);
  assert.match(html, /data-testid="admin-kill-switch-attachments"[^>]*data-enabled="false"/);
  assert.match(html, /data-tone="ok"[^>]*>Running</);
  assert.match(html, /data-tone="bad"[^>]*>Stopped</);
  // Saving and the audit trail are said before the operator flips anything.
  assert.match(html, /recent sign-in/);
  assert.match(html, /audit log/);
});

test("every stop has its own switch named after it", () => {
  const html = renderToStaticMarkup(<EmergencyStopsSection items={stops([true, true])} />);
  assert.match(html, /role="switch"[^>]*aria-label="AI chat"|aria-label="AI chat"[^>]*role="switch"/);
  assert.match(html, /admin-kill-switch-attachments-toggle/);
});

const flags = [
  { testId: "admin-chat-starter-flag", label: "Chat starter cards", detail: "Suggestions", enabled: true, onChange: noop },
  { testId: "admin-image-generation-flag", label: "Image generation", detail: "Make images", enabled: false, onChange: noop },
  { testId: "admin-assistant-knowledge-flag", label: "Assistant knowledge files", detail: "Files", enabled: true, onChange: noop, waiting: true },
];

test("each feature shows who it is on for as a chip, beside its switch", () => {
  const html = renderToStaticMarkup(<FeatureSwitchesSection items={flags} />);
  assert.match(html, /data-tone="ok"[^>]*>On for everyone</);
  assert.match(html, /data-tone="idle"[^>]*>Off</);
  assert.match(html, /data-testid="admin-chat-starter-flag"/);
  assert.match(html, /data-testid="admin-image-generation-flag"/);
});

test("a switch held back by another says so instead of claiming to be on", () => {
  const html = renderToStaticMarkup(<FeatureSwitchesSection items={flags} />);
  assert.match(html, /data-tone="warn"[^>]*>Waits for profiles</);
  assert.match(html, /Knowledge stays off until assistant profiles are enabled\./);
});

test("the page promises a switch a person turned off is never turned back on by automation", () => {
  const html = renderToStaticMarkup(<FeatureSwitchesSection items={flags} />);
  assert.match(html, /A switch a person turned off is never turned back on by automation\./);
});

test("policy notes sit behind Technical details, closed", () => {
  const html = renderToStaticMarkup(<FeatureSwitchesSection items={flags} />);
  const details = html.match(/<details[^>]*>/)?.[0] ?? "";
  assert.ok(details);
  assert.doesNotMatch(details, /open/);
  assert.match(html, /Policy notes for each switch/);
});
