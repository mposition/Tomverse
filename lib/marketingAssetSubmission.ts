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
  MARKETING_ASSET_MAX_VIDEO_SECONDS,
} from "@/lib/marketingAssetCore";
import { marketingAssetSchema } from "@/lib/marketingAssets";

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
  })
  .strict()
  .superRefine((submission, context) => {
    if (!MARKETING_ASSET_ID.test(submission.asset.id)) {
      context.addIssue({ code: "custom", message: "a stored asset id is media- followed by lower case letters, digits and -" });
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
  });
export type MarketingAssetSubmission = z.infer<typeof marketingAssetSubmissionSchema>;

