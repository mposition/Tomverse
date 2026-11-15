import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageProvider } from "@/components/LanguageProvider";
import { AvailableCreditsProvider, UsageMeter } from "@/components/credits/UsageMeter";

const render = (available: number | null, credits: number, kind: "chat" | "image") =>
  renderToStaticMarkup(
    <LanguageProvider initialLang="ko" forceInitialLang>
      <AvailableCreditsProvider value={available}>
        <UsageMeter credits={credits} kind={kind} />
      </AvailableCreditsProvider>
    </LanguageProvider>
  );

test("a model card shows a usage level and remaining uses, never the credit number", () => {
  const chat = render(3_000, 16, "chat");
  assert.match(chat, /data-usage-level="3"/);
  assert.match(chat, /약 180회/);
  assert.match(chat, /사용량 5단계 중 3단계 · 남은 양으로 약 180회/);
  assert.doesNotMatch(chat, /credit-coin-icon/);
  assert.doesNotMatch(chat, />16</);

  const image = render(3_000, 50, "image");
  assert.match(image, /data-usage-level="4"/);
  assert.match(image, /약 60장/);
});

test("without a balance only the meter shows; with too little it says so", () => {
  const unknown = render(null, 50, "image");
  assert.match(unknown, /data-usage-level="4"/);
  assert.doesNotMatch(unknown, /usage-meter-count/);
  const short = render(40, 50, "image");
  assert.match(short, /남은 양 부족/);
  assert.doesNotMatch(short, /남은 양으로 남은 양/);
});
