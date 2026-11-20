import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ImageFeedbackButtons, ImageSelectButton } from "@/components/images/ImageSignalControls";

const render = (node: React.ReactNode, lang: "en" | "ko" = "en") =>
  renderToStaticMarkup(<LanguageProvider initialLang={lang}>{node}</LanguageProvider>);

test("an unrated image offers a thumbs up, a thumbs down and a text-answer request, none pressed", () => {
  const html = render(<ImageFeedbackButtons generationId="gen-1" />);
  assert.match(html, /data-testid="image-signal-helpful"[^>]*aria-pressed="false"/);
  assert.match(html, /data-testid="image-signal-not-helpful"[^>]*aria-pressed="false"/);
  assert.match(html, /data-testid="image-signal-wanted-text"[^>]*aria-pressed="false"/);
  assert.match(html, /aria-label="This image is helpful"/);
  assert.match(html, /I wanted a text answer/);
  // The 44px touch target of the mobile contract, on all three controls.
  assert.equal((html.match(/min-h-11/g) ?? []).length, 3);
});

test("the choose-this-result control states whether it is chosen, in words and in aria-pressed", () => {
  const idle = render(<ImageSelectButton selected={false} onSelect={() => {}} />);
  assert.match(idle, /aria-pressed="false"[^>]*>Choose this result</);
  const chosen = render(<ImageSelectButton selected onSelect={() => {}} />);
  assert.match(chosen, /aria-pressed="true"/);
  assert.match(chosen, />Chosen</);
  assert.match(render(<ImageSelectButton selected={false} onSelect={() => {}} />, "ko"), /이 결과 선택/);
});

test("a reload shows what the person already said, so a second press takes it back", () => {
  const html = render(<ImageFeedbackButtons generationId="gen-1" initialSignals={["helpful", "wanted_text", "selected", "download"]} />);
  assert.match(html, /data-testid="image-signal-helpful"[^>]*aria-pressed="true"/);
  assert.match(html, /data-testid="image-signal-not-helpful"[^>]*aria-pressed="false"/);
  assert.match(html, /data-testid="image-signal-wanted-text"[^>]*aria-pressed="true"/);
});
