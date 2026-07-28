/**
 * The single font policy for every outgoing email.
 *
 * Email clients do not reliably load webfonts, and several of them (Outlook's
 * Word engine in particular) fall back to a serif default when a stack opens
 * with a name they cannot resolve. So the stack is web-safe only: it names
 * fonts that are already installed, ends on `Arial, sans-serif`, and carries
 * the Korean and Chinese system faces inline so a mixed subject line does not
 * fall back to a random glyph source.
 *
 * Values use single quotes because they are interpolated into
 * `style="..."` attributes.
 */
export const EMAIL_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', " +
  "'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', 'PingFang SC', " +
  "'Microsoft YaHei', Arial, sans-serif";

/** For verification codes and other characters that must not be confusable. */
export const EMAIL_MONO_FONT_STACK =
  "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace";
