import assert from "node:assert/strict";
import test from "node:test";

import { consentCopy } from "@/components/analytics/AnalyticsProvider";

// The phone-width consent notice must name the same exclusions as the desktop
// body, so a visitor consents on the same information at every screen size.
test("Korean mobile consent copy names prompts, responses, filenames and file contents", () => {
  for (const text of [consentCopy.ko.mobileBody, consentCopy.ko.noticeMobileBody]) {
    for (const item of ["프롬프트", "응답", "파일명", "파일 내용"]) {
      assert.ok(text.includes(item), `${text} is missing ${item}`);
    }
  }
});
