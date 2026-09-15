import { expect, test, type Page } from "@playwright/test";

import {
  ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_DURATION_SECONDS,
} from "@/lib/assistantKnowledgeGuide";
import { prepareGuestPage } from "./support/app-fixtures";

type GuideLanguage = "en" | "ko";

async function openGuide(page: Page, language: GuideLanguage) {
  await prepareGuestPage(page, language);
  await page.goto(`/guides/assistant-knowledge?lang=${language}`);

  const video = page.locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate(
        (element) => {
          const media = element as HTMLVideoElement;
          return Number.isFinite(media.duration) && media.readyState >= 2;
        }
      )
    )
    .toBe(true);
  const duration = await video.evaluate(
    (element) => (element as HTMLVideoElement).duration
  );
  expect(duration).toBeLessThan(49);
  expect(duration).toBeCloseTo(
    ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_DURATION_SECONDS,
    2
  );

  return video;
}

test("the guide serves the reviewed tutorial and matches captions to the page language", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The checked-in H.264 export only needs one browser playback contract."
  );

  for (const language of ["ko", "en"] as const) {
    const video = await openGuide(page, language);
    await expect(video).toHaveAttribute(
      "poster",
      "/guides/assistant-knowledge/poster"
    );

    const [boxRatio, mediaRatio, videoWidth, videoHeight] = await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      const box = media.getBoundingClientRect();
      return [
        box.width / box.height,
        media.videoWidth / media.videoHeight,
        media.videoWidth,
        media.videoHeight,
      ];
    });
    expect(boxRatio).toBeCloseTo(mediaRatio, 4);
    expect(videoWidth).toBe(1920);
    expect(videoHeight).toBe(1080);

    await video.evaluate((element) => (element as HTMLVideoElement).play());
    await expect
      .poll(() =>
        video.evaluate(
          (element) => (element as HTMLVideoElement).currentTime
        )
      )
      .toBeGreaterThan(0);

    const state = await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      media.pause();
      return {
        currentSrc: media.currentSrc,
        currentTime: media.currentTime,
        tracks: Array.from(media.textTracks).map((track) => ({
          language: track.language,
          mode: track.mode,
        })),
      };
    });

    expect(state.currentSrc).toMatch(/assistant-knowledge\.mp4$/);
    expect(state.currentTime).toBeGreaterThan(0);
    expect(state.tracks).toEqual(
      expect.arrayContaining([
        { language, mode: "showing" },
        {
          language: language === "ko" ? "en" : "ko",
          mode: "disabled",
        },
      ])
    );
  }
});
