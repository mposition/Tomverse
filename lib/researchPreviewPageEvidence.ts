import { z } from "zod";

export const RESEARCH_PAGE_MAX_MODEL_CHARACTERS = 12_000;
export const RESEARCH_PAGE_MAX_READS = 2;
export const RESEARCH_PAGE_MAX_RESPONSE_BYTES = 128 * 1024;
export const RESEARCH_PAGE_DEADLINE_MS = 10_000;
export const RESEARCH_PAGE_MAX_REDIRECTS = 2;

export const RESEARCH_PAGE_FAILURE_REASONS = [
  "disabled", "unknown_source", "unsafe_url", "unsafe_address", "dns_unavailable",
  "redirect_limit", "http_error", "unsupported_content", "response_too_large",
  "timeout", "aborted", "network_error",
] as const;
export type ResearchPageFailureReason = (typeof RESEARCH_PAGE_FAILURE_REASONS)[number];

/** Only this projection may enter final Message metadata/account exports. */
export const researchPageEvidenceSchema = z.object({
  status: z.enum(["read", "unavailable"]),
  readAt: z.string().datetime({ offset: true }),
  truncated: z.boolean(),
  contentType: z.enum(["text/html", "text/plain"]).optional(),
  reason: z.enum(RESEARCH_PAGE_FAILURE_REASONS).optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "read" ? !value.contentType || value.reason !== undefined :
      !value.reason || value.contentType !== undefined || value.truncated) {
    context.addIssue({ code: "custom", message: "Invalid page read evidence" });
  }
});
export type ResearchPageEvidence = z.infer<typeof researchPageEvidenceSchema>;

const pageResultBase = {
  sourceId: z.string().regex(/^R(?:[1-9]|1\d|2[0-5])$/),
  url: z.string().max(2048), readAt: z.string().datetime({ offset: true }),
};
/** Private active checkpoint only. `content` must never enter the public DTO. */
export const researchPageReadResultSchema = z.discriminatedUnion("status", [
  z.object({ ...pageResultBase, status: z.literal("read"), truncated: z.boolean(),
    content: z.string().max(RESEARCH_PAGE_MAX_MODEL_CHARACTERS),
    contentType: z.enum(["text/html", "text/plain"]),
    finalUrl: z.string().max(2048).url().optional(), notice: z.string().max(512).optional(),
  }).strict(),
  z.object({ ...pageResultBase, status: z.literal("unavailable"), truncated: z.literal(false),
    reason: z.enum(RESEARCH_PAGE_FAILURE_REASONS),
  }).strict(),
]);
export type ResearchPageReadResult = z.infer<typeof researchPageReadResultSchema>;

export function curateResearchPageEvidence(value: unknown): ResearchPageEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const parsed = researchPageEvidenceSchema.safeParse({
    status: record.status, readAt: record.readAt, truncated: record.truncated,
    ...(record.contentType !== undefined ? { contentType: record.contentType } : {}),
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
  });
  return parsed.success ? parsed.data : null;
}
