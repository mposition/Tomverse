import "server-only";

import { z } from "zod";
import { readResponseToBuffer } from "@/lib/boundedBuffer";
import {
  isProviderApiKeyConfigured,
  resolveProviderApiKey,
} from "@/lib/modelRegistryShared";

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
  /** Pages the provider returned, which is what it bills. */
  pageCount: number;
  /**
   * 1-based pages whose whole text is in `text`: returned with content and not
   * cut off by the character limit. A page the provider skipped or returned
   * empty is not here, nor is the page the limit cut or any page after it, and
   * a caller that asked for specific pages checks them against this list
   * rather than taking any text as proof they were read.
   */
  pageNumbers: number[];
  /** The text was cut at the character limit. */
  truncated: boolean;
  /** The page the limit cut in the middle (only part of it is in `text`), if any. */
  truncatedPage: number | null;
  modelId: typeof MISTRAL_OCR_MODEL_ID;
};

export const isMistralOcrConfigured = () =>
  isProviderApiKeyConfigured("mistral");

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
    /**
     * 1-based pages to read; the rest of the document is neither processed nor
     * billed. Used for a PDF whose other pages already have a text layer.
     */
    pages?: readonly number[];
  } = {}
): Promise<MistralOcrResult | null> {
  const apiKey = dependencies.apiKey ?? resolveProviderApiKey("mistral");
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
      // The provider counts pages from 0.
      ...(dependencies.pages?.length
        ? { pages: dependencies.pages.map((page) => page - 1) }
        : {}),
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

  const requested = dependencies.pages?.length ? new Set(dependencies.pages) : null;
  const blocks: Array<{ pageNumber: number; block: string }> = [];
  validated.data.pages.forEach((page, position) => {
    // The page's own index; without one, its place among the pages asked for.
    const pageNumber =
      page.index !== undefined
        ? page.index + 1
        : (dependencies.pages?.[position] ?? position + 1);
    const markdown = page.markdown.trim();
    if (!markdown || (requested && !requested.has(pageNumber))) return;
    blocks.push({ pageNumber, block: `## Page ${pageNumber}\n\n${markdown}` });
  });
  const joined = blocks.map((entry) => entry.block).join("\n\n");
  const text = joined.slice(0, maxCharacters).trim();
  // A page counts as read only when all of it survives the cut; the page the
  // limit lands in is reported on its own, and the pages after it are simply
  // not here.
  const pageNumbers: number[] = [];
  let truncatedPage: number | null = null;
  let offset = 0;
  for (const entry of blocks) {
    if (offset >= maxCharacters) break;
    if (offset + entry.block.length > maxCharacters) {
      truncatedPage = entry.pageNumber;
      break;
    }
    pageNumbers.push(entry.pageNumber);
    offset += entry.block.length + 2;
  }

  return {
    text,
    pageCount: validated.data.pages.length,
    pageNumbers,
    truncated: joined.length > maxCharacters,
    truncatedPage,
    modelId: MISTRAL_OCR_MODEL_ID,
  };
}
