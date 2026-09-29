/**
 * The one log line every chat refusal leaves behind.
 *
 * A reported trace used to point at nothing when the refusal was a validation
 * one -- an over-long context, a malformed transcript. Those codes are neither
 * cost-safety codes nor limit decisions, so neither of the two records the
 * chat routes already write covered them, and the person reading the report
 * had a trace id and an empty log.
 *
 * Content-free by construction. A refusal's details can name the user's files,
 * so only numeric details are copied, and the names of the rest are listed so
 * the reader knows what the response carried without seeing it.
 */
export const countableChatErrorDetails = (
  details: Readonly<Record<string, unknown>> | undefined
): Record<string, number | string[]> => {
  if (!details) return {};
  const numeric: Record<string, number> = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      numeric[key] = value;
    } else {
      withheld.push(key);
    }
  }
  return withheld.length > 0
    ? { ...numeric, withheldDetailKeys: withheld.sort() }
    : numeric;
};
