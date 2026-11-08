// The fixed layout of a card on a generated picture (owner 2026-11-08): the
// picture full bleed, a 230 px band at the bottom, the Tomverse lockup bottom
// left (60 px high, 64 px in, 58 px up), tomverse.app bottom right (Geist 500,
// 32 px) and the locale's AI line centred under them (18 px). On a dark
// picture the band is dark and the lockup white. The image model never draws
// the logo or the address; this code always puts them in the same place.
// make-card.mjs renders the layout and checks it like any other.

/** The AI line per locale (make-card.mjs AI_LINE). */
export const AI_LINE = {
  en: "Photo: AI-generated",
  ko: "사진: AI 생성",
  "zh-Hant": "照片：AI 生成",
  "zh-Hans": "照片：AI 生成",
};

/** What the alt adds for the band, in each locale: the address is named, never written. */
export const BAND_ALT = {
  en: "At the bottom: the Tomverse logo and web address.",
  ko: "아래에는 Tomverse 로고와 웹 주소가 있습니다.",
  "zh-Hant": "下方是 Tomverse 標誌與網址。",
  "zh-Hans": "下方是 Tomverse 标志与网址。",
};

/** @param {{picture: string, locale: string, dark: boolean}} options picture: the file name under generated/ */
export function bandLayout({ picture, locale, dark }) {
  if (!AI_LINE[locale]) throw new Error(`no AI line for ${locale}`);
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(picture)) throw new Error("picture is a plain file name");
  const ink = dark ? "#ffffff" : "#18181b";
  const band = dark
    ? "linear-gradient(to bottom, rgba(24,24,27,0) 0%, rgba(24,24,27,0.82) 42%, rgba(24,24,27,0.94) 100%)"
    : "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.86) 42%, rgba(255,255,255,0.96) 100%)";
  return `<style>
  .picture { position: absolute; left: 0; top: 0; width: 1080px; height: 1350px; object-fit: cover; }
  .band { position: absolute; left: 0; bottom: 0; width: 1080px; height: 230px; background: ${band}; }
  .lockup { position: absolute; left: 64px; bottom: 58px; height: 60px; display: flex; align-items: center; gap: 14px; }
  .lockup img { width: 60px; height: 60px; border-radius: 14px; }
  .wordmark { font-family: 'Geist', sans-serif; font-size: 44px; font-weight: 650; letter-spacing: -1.8px; line-height: 60px; color: ${ink}; white-space: nowrap; }
  .wordmark span { color: #155dfb; margin-left: 1px; }
  .address { position: absolute; right: 64px; bottom: 69px; font-family: 'Geist', sans-serif; font-size: 32px; font-weight: 500; line-height: 38px; color: ${ink}; white-space: nowrap; }
  .ai-line { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); white-space: nowrap; font-size: 18px; font-weight: 500; line-height: 24px; color: ${ink}; opacity: 0.78; }
</style>
<img class="picture" src="generated:${picture}" alt="">
<div class="band"></div>
<div class="lockup"><img src="library:tomverse-logo" alt=""><div class="wordmark">tomverse<span>.</span></div></div>
<div class="address">tomverse.app</div>
<div class="ai-line">${AI_LINE[locale]}</div>
`;
}
