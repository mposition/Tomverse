import "server-only";

import { z } from "zod";
import { readResponseToBuffer } from "@/lib/boundedBuffer";

export const MISTRAL_OCR_MODEL_ID = "mistral-ocr-4-0";
export const MISTRAL_OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr";
export const MISTRAL_OCR_COST_MICRO_USD_PER_PAGE = 4_000;

const OCR_TIMEOUT_MS = 45_000;
const OCR_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const mistralOcrResponseSchema = z.object({
  pages: z
    .array(
      z.object({
        index: z.number().int().nonnegative().optional(),
        markdown: z.string(),
      })
    )
    .max(500),
});

export class MistralOcrError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "MistralOcrError";
    this.statusCode = statusCode;
  }
}

export type MistralOcrResult = {
  text: string;
  pageCount: number;
  modelId: typeof MISTRAL_OCR_MODEL_ID;
};

export const isMistralOcrConfigured = () =>
  Boolean(process.env.MISTRAL_API_KEY?.trim());

/**
 * Converts a validated PDF to bounded Markdown with Mistral OCR 4.
 *
 * The caller validates the PDF locally before invoking this function. Images
 * and layout blocks are deliberately omitted: chat needs searchable text, and
 * returning embedded images would increase both payload size and exposure.
 */
export async function extractPdfTextWithMistralOcr(
  pdf: Buffer,
  maxCharacters: number,
  dependencies: {
    fetch?: typeof fetch;
    apiKey?: string;
    signal?: AbortSignal;
  } = {}
): Promise<MistralOcrResult | null> {
  const apiKey = dependencies.apiKey ?? process.env.MISTRAL_API_KEY?.trim();
  if (!apiKey) return null;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    throw new MistralOcrError("Mistral OCR requires a positive text limit.");
  }

  const fetchImpl = dependencies.fetch ?? fetch;
  const response = await fetchImpl(MISTRAL_OCR_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MISTRAL_OCR_MODEL_ID,
      document: {
        type: "document_url",
        document_url: `data:application/pdf;base64,${pdf.toString("base64")}`,
      },
      include_image_base64: false,
      include_blocks: false,
      table_format: "markdown",
    }),
    signal: dependencies.signal ?? AbortSignal.timeout(OCR_TIMEOUT_MS),
    cache: "no-store",
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new MistralOcrError(
      `Mistral OCR returned HTTP ${response.status}.`,
      response.status
    );
  }

  let parsed: unknown;
  try {
    const responseBuffer = await readResponseToBuffer(
      response,
      OCR_MAX_RESPONSE_BYTES
    );
    parsed = JSON.parse(responseBuffer.toString("utf8"));
  } catch (error) {
    throw new MistralOcrError(
      error instanceof Error
        ? `Mistral OCR response could not be read: ${error.name}.`
        : "Mistral OCR response could not be read."
    );
  }

  const validated = mistralOcrResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new MistralOcrError("Mistral OCR returned an invalid response shape.");
  }

  const text = validated.data.pages
    .map((page, position) => {
      const pageNumber = (page.index ?? position) + 1;
      return `## Page ${pageNumber}\n\n${page.markdown.trim()}`;
    })
    .filter((page) => page.length > 0)
    .join("\n\n")
    .trim()
    .slice(0, maxCharacters);

  return {
    text,
    pageCount: validated.data.pages.length,
    modelId: MISTRAL_OCR_MODEL_ID,
  };
}
