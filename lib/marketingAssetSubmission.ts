/**
 * What the media CLI sends to announce a file (operator decision 2026-10-31):
 * the registry entry it will become, in the hand-kept registry's schema, and
 * what the bytes are. Apart from lib/marketingAssetCore.ts because it needs the
 * registry schema, and the core stays free of local imports.
 */

import { z } from "zod";

import {
  MARKETING_ASSET_CONTENT_TYPES,
  MARKETING_ASSET_ID,
  MARKETING_ASSET_KINDS,
  MARKETING_ASSET_MAX_BYTES,
  MARKETING_ASSET_MAX_TRANSCRIPT_CHARS,
  MARKETING_ASSET_MAX_VIDEO_SECONDS,
} from "@/lib/marketingAssetCore";
import { MARKETING_LOCALES } from "@/lib/marketingAutomationSchema";
import { marketingAssetSchema } from "@/lib/marketingAssets";
import {
  MARKETING_VIDEO_CHAPTERS_MAX,
  MARKETING_VIDEO_CHAPTER_TITLE_MAX_CHARS,
  marketingVideoChapterIssues,
  marketingVideoChapterTitleValid,
} from "@/lib/marketingVideoChapters";

/**
 * One of a video's YouTube chapters (owner decision 2026-11-07): where the
 * section starts and its title per locale. The rules that need the video's
 * length and its alt locales are checked with the submission below.
 */
const chapterSchema = z
  .object({
    startSeconds: z.number().int().min(0).max(MARKETING_ASSET_MAX_VIDEO_SECONDS),
    title: z.partialRecord(
      z.enum(MARKETING_LOCALES),
      z
        .string()
        .max(MARKETING_VIDEO_CHAPTER_TITLE_MAX_CHARS)
        .refine(marketingVideoChapterTitleValid, "a chapter title is one line with nothing to trim"),
    ),
  })
  .strict();

/**
 * One file announced for upload: the registry entry it will become, and what
 * the bytes are. The file itself goes to R2 by the URL the answer carries.
 */
export const marketingAssetSubmissionSchema = z
  .object({
    asset: marketingAssetSchema,
    kind: z.enum(MARKETING_ASSET_KINDS),
    contentType: z.string().min(1).max(100),
    bytes: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    durationSeconds: z.number().int().min(1).max(MARKETING_ASSET_MAX_VIDEO_SECONDS).nullable(),
    /**
     * Everything the file says, per locale: a video's narration and every
     * on-screen line, an image's text. The Guard reads it before the row is
     * written, and the person approving sees it beside the file.
     */
    transcript: z
      .partialRecord(z.enum(MARKETING_LOCALES), z.string().trim().min(1).max(MARKETING_ASSET_MAX_TRANSCRIPT_CHARS))
      .optional(),
    /**
     * A long video's chapters, which the draft intake writes into a YouTube
     * description. The Guard reads their titles with the transcript.
     */
    chapters: z.array(chapterSchema).max(MARKETING_VIDEO_CHAPTERS_MAX).optional(),
  })
  .strict()
  .superRefine((submission, context) => {
    if (!MARKETING_ASSET_ID.test(submission.asset.id)) {
      context.addIssue({ code: "custom", message: "a stored asset id is media- followed by lower case letters, digits and -" });
    }
    // A presenter speaks, so this provenance is a video's (owner decision
    // 2026-11-07; AI_PRESENTER_PROVENANCE). The registry entry has no kind, so
    // the rule is here and in MarketingAsset_presenter_check.
    if (submission.asset.provenance === "capture_with_ai_presenter" && submission.kind !== "video") {
      context.addIssue({ code: "custom", message: "capture_with_ai_presenter is a video's provenance" });
    }
    if (!Object.hasOwn(MARKETING_ASSET_CONTENT_TYPES[submission.kind], submission.contentType)) {
      context.addIssue({ code: "custom", message: `${submission.contentType} is not a ${submission.kind} type` });
    }
    if (submission.bytes > MARKETING_ASSET_MAX_BYTES[submission.kind]) {
      context.addIssue({ code: "custom", message: `a ${submission.kind} is at most ${MARKETING_ASSET_MAX_BYTES[submission.kind]} bytes` });
    }
    if ((submission.kind === "video") !== (submission.durationSeconds !== null)) {
      context.addIssue({ code: "custom", message: "a video has a duration and an image has none" });
    }
    // A video always says something; an image may say nothing.
    if (submission.kind === "video" && Object.keys(submission.transcript ?? {}).length === 0) {
      context.addIssue({ code: "custom", message: "a video needs its transcript in at least one locale" });
    }
    if (submission.chapters !== undefined) {
      const issues =
        submission.kind === "video"
          ? marketingVideoChapterIssues(submission.chapters, submission.durationSeconds, Object.keys(submission.asset.alt))
          : ["only a video has chapters"];
      for (const message of issues) context.addIssue({ code: "custom", message, path: ["chapters"] });
    }
  });
export type MarketingAssetSubmission = z.infer<typeof marketingAssetSubmissionSchema>;

