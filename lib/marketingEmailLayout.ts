import { EMAIL_FONT_STACK } from "@/lib/emailTypography";

export type MarketingFeature = {
  title: string;
  body: string;
};

export type MarketingEmailLayoutInput = {
  language: string;
  preheader: string;
  eyebrow: string;
  headline: string;
  intro: string;
  features: readonly MarketingFeature[];
  closing?: string | null;
  ctaLabel: string;
  ctaUrl: string;
};

export const escapeEmailHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Marketing calls to action stay on an HTTPS Tomverse-owned origin. */
export const normalizeTomverseMarketingUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ctaUrl must be an absolute URL.");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    (host !== "tomverse.app" && !host.endsWith(".tomverse.app"))
  ) {
    throw new Error("ctaUrl must use an HTTPS Tomverse domain.");
  }
  return parsed.toString();
};

/**
 * Shared Tomverse marketing shell.
 *
 * Tables and inline styles are intentional: this is delivered HTML, not a web
 * page, and it must remain readable in clients that remove modern layout CSS.
 * The visual system uses graphite, teal and emerald; the cyan-blue-purple
 * combination remains reserved for AI Review in the product UI.
 */
export const renderMarketingEmailLayout = (
  input: MarketingEmailLayoutInput
): { html: string; text: string } => {
  const featuresHtml = input.features
    .map(
      (feature, index) => `<tr>
        <td style="padding:${index === 0 ? "0" : "12px 0 0"}">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:16px">
            <tr>
              <td width="48" valign="top" style="padding:18px 0 18px 18px">
                <div style="width:30px;height:30px;line-height:30px;text-align:center;border-radius:10px;background:#ccfbf1;color:#115e59;font-size:13px;font-weight:800">${String(index + 1).padStart(2, "0")}</div>
              </td>
              <td style="padding:17px 18px 17px 12px">
                <p style="margin:0;color:#18181b;font-size:16px;line-height:1.4;font-weight:800">${escapeEmailHtml(feature.title)}</p>
                <p style="margin:6px 0 0;color:#52525b;font-size:14px;line-height:1.65">${escapeEmailHtml(feature.body)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    )
    .join("");

  const closingHtml = input.closing
    ? `<p style="margin:24px 0 0;color:#3f3f46;font-size:15px;line-height:1.75">${escapeEmailHtml(input.closing)}</p>`
    : "";

  const html = `<div lang="${escapeEmailHtml(input.language)}" style="margin:0;padding:0;background:#f4f4f5">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeEmailHtml(input.preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background:#f4f4f5">
    <tr>
      <td align="center" style="padding:28px 12px">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;background:#ffffff;border:1px solid #e4e4e7;border-radius:24px;overflow:hidden;font-family:${EMAIL_FONT_STACK}">
          <tr>
            <td style="padding:22px 28px;background:#09090b">
              <p style="margin:0;color:#ffffff;font-size:19px;line-height:1;font-weight:900;letter-spacing:-0.02em">Tomverse<span style="color:#2dd4bf">.</span></p>
            </td>
          </tr>
          <tr>
            <td style="padding:42px 36px 36px">
              <p style="margin:0;color:#0f766e;font-size:11px;line-height:1.4;font-weight:800;letter-spacing:0.16em;text-transform:uppercase">${escapeEmailHtml(input.eyebrow)}</p>
              <h1 style="margin:12px 0 0;color:#18181b;font-size:34px;line-height:1.16;font-weight:900;letter-spacing:-0.035em">${escapeEmailHtml(input.headline)}</h1>
              <p style="margin:18px 0 0;color:#52525b;font-size:16px;line-height:1.75">${escapeEmailHtml(input.intro)}</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;border-collapse:collapse">${featuresHtml}</table>
              ${closingHtml}
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:30px">
                <tr><td bgcolor="#0f766e" style="border-radius:12px"><a href="${escapeEmailHtml(input.ctaUrl)}" style="display:inline-block;padding:13px 20px;color:#ffffff;text-decoration:none;font-size:15px;line-height:1.2;font-weight:800">${escapeEmailHtml(input.ctaLabel)}</a></td></tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>`;

  const text = [
    input.eyebrow,
    input.headline,
    "",
    input.intro,
    "",
    ...input.features.flatMap((feature) => [
      `${feature.title}`,
      feature.body,
      "",
    ]),
    ...(input.closing ? [input.closing, ""] : []),
    `${input.ctaLabel}: ${input.ctaUrl}`,
  ].join("\n");

  return { html, text };
};
