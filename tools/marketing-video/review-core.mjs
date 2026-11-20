// The shape of a review call's answer, and the deterministic part of its
// verdict (check-review.mjs, run-higgsfield.mjs).
//
// Boxes are fractions of the picture's width and height (0-1), so they hold
// whatever size the model returns and whatever size the reviewer was shown.
//  logoBoxes: [{logo, cx, cy, size, rotate, flat, shapeOk}] where a provider
//    mark shows; size is the mark's width as a fraction of the picture's.
//    `flat` marks are painted over with the real file; a mark that is not flat
//    (on a tilted object) passes only when the reviewer says its shape matches
//    the real one (`shapeOk`).
//  textBoxes: [{textIndex, role, x, y, w, h, rotate, bg}] where each of the
//    concept's texts sits (textIndex into concept.texts), for the language
//    versions' real-font words.
// The content stage adds readTexts: every piece of text the reviewer can read
// in the picture, exactly as it reads.
import { MODEL_FAMILIES } from "./concepts-core.mjs";

export const VERDICTS = ["pass", "fix", "reject"];
export const MAX_FIXES = 10;
export const MAX_FIX_LENGTH = 500;
export const BOX_ROLES = ["headline", "screen", "cta"];

const isNumber = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
/**
 * Compared as a reader sees them: Unicode-normalised, spaces collapsed, quotes
 * unified, the quotation marks around a whole text dropped and a spaced list
 * separator (" · ", " - ", " | ", " • ") read as one. The 2026-11-12 box run
 * refused a quote drawn inside quotation marks and "GPT 6 Luna - Claude Haiku
 * 5.5" for "GPT 6 Luna · Claude Haiku 5.5", both right on the picture.
 */
export const sameText = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .replace(/[“”„«»「」『』]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(["'])(.+)\1$/u, "$2")
    .trim()
    .replace(/ [·•|\-–—] /gu, " · ")
    // One closing full stop is not a different text: on 2026-11-13 every
    // English card was refused for "...for this message." against "...for
    // this message", and the forced "show exactly" plus "remove" fixes made
    // the model erase the subhead and the call to action on the remake.
    .replace(/(?<![.。])[.。]$/u, "");

/** The approved texts of a concept in one locale. */
export const textsFor = (concept, locale) => (locale === "en" ? concept.texts : concept.translations[locale]);

function answerLine(text) {
  for (const line of String(text).split(/\r?\n/u)) {
    try {
      const value = JSON.parse(line.trim());
      if (value && typeof value === "object" && "verdict" in value) return value;
    } catch {
      // not the answer line
    }
  }
  return null;
}

/** @returns {{problem: string} | {review: object}} */
export function checkReview(answerText, { stage, concept, locale }) {
  const answer = answerLine(answerText);
  if (!answer) return { problem: "the answer holds no review line" };
  const keys = ["fixes", "id", "logoBoxes", "textBoxes", "verdict", ...(stage === "content" ? ["readTexts"] : [])].sort().join(",");
  if (Object.keys(answer).sort().join(",") !== keys) return { problem: `keys must be exactly ${keys}` };
  if (answer.id !== concept.id) return { problem: `id must be ${concept.id}` };
  if (!VERDICTS.includes(answer.verdict)) return { problem: `verdict is one of ${VERDICTS.join(", ")}` };
  // The prompt asks for at most 8 one-sentence fixes; this is the hard limit,
  // wide enough for a reviewer that writes a little more (the first box run,
  // 2026-11-10, lost two reviews at 300 characters) and still small enough that
  // an edit prompt stays under the 8000 characters higgsfield-cap.mjs allows.
  if (!Array.isArray(answer.fixes) || answer.fixes.length > MAX_FIXES || !answer.fixes.every((fix) => typeof fix === "string" && fix.trim() && fix.length <= MAX_FIX_LENGTH)) {
    return { problem: `fixes: at most ${MAX_FIXES} strings of ${MAX_FIX_LENGTH} characters` };
  }
  if (answer.verdict === "fix" && answer.fixes.length === 0) return { problem: "a fix verdict lists what to fix" };

  if (!Array.isArray(answer.logoBoxes) || answer.logoBoxes.length > 8) return { problem: "logoBoxes: at most 8" };
  for (const [index, box] of answer.logoBoxes.entries()) {
    const at = `logoBoxes[${index}]`;
    if (Object.keys(box ?? {}).sort().join(",") !== "cx,cy,flat,logo,rotate,shapeOk,size") return { problem: `${at}: keys are logo, cx, cy, size, rotate, flat, shapeOk` };
    if (!concept.logos.includes(box.logo)) return { problem: `${at}: ${box.logo} is not one of the concept's logos` };
    if (!isNumber(box.cx, 0, 1) || !isNumber(box.cy, 0, 1)) return { problem: `${at}: cx and cy are fractions 0-1` };
    if (!isNumber(box.size, 0.01, 0.4)) return { problem: `${at}: size is 0.01-0.4 of the width` };
    if (!isNumber(box.rotate, -180, 180)) return { problem: `${at}: rotate is -180 to 180 degrees` };
    if (typeof box.flat !== "boolean" || typeof box.shapeOk !== "boolean") return { problem: `${at}: flat and shapeOk are true or false` };
  }

  const texts = textsFor(concept, locale);
  if (!Array.isArray(answer.textBoxes) || answer.textBoxes.length > 12) return { problem: "textBoxes: at most 12" };
  for (const [index, box] of answer.textBoxes.entries()) {
    const at = `textBoxes[${index}]`;
    if (Object.keys(box ?? {}).sort().join(",") !== "bg,h,role,rotate,textIndex,w,x,y") return { problem: `${at}: keys are textIndex, role, x, y, w, h, rotate, bg` };
    if (!Number.isInteger(box.textIndex) || box.textIndex < 0 || box.textIndex >= texts.length) return { problem: `${at}: textIndex points into the concept's texts` };
    if (!BOX_ROLES.includes(box.role)) return { problem: `${at}: role is one of ${BOX_ROLES.join(", ")}` };
    if (!isNumber(box.x, 0, 1) || !isNumber(box.y, 0, 1) || !isNumber(box.w, 0.02, 1) || !isNumber(box.h, 0.01, 1) || box.x + box.w > 1.001 || box.y + box.h > 1.001) {
      return { problem: `${at}: x, y, w, h are fractions inside the picture` };
    }
    if (!isNumber(box.rotate, -45, 45)) return { problem: `${at}: rotate is -45 to 45 degrees` };
    if (typeof box.bg !== "string" || !/^#[0-9a-f]{6}$/iu.test(box.bg)) return { problem: `${at}: bg is a #rrggbb colour` };
  }

  const review = { ...answer, stage, locale, checked: [] };
  // A mark on a tilted object cannot be painted over; it stays only if its shape is right.
  const badMarks = answer.logoBoxes.filter((box) => !box.flat && !box.shapeOk);
  if (badMarks.length > 0 && review.verdict === "pass") {
    review.verdict = "fix";
    review.fixes = [...review.fixes, `Redraw the ${badMarks.map((box) => box.logo).join(", ")} mark exactly as the reference file, or lay it flat`];
    review.checked.push("mark_shape_forced_fix");
  }

  if (stage === "content") {
    if (!Array.isArray(answer.readTexts) || answer.readTexts.length > 40 || !answer.readTexts.every((text) => typeof text === "string" && text.length <= 600)) {
      return { problem: "readTexts: at most 40 strings" };
    }
    const read = answer.readTexts.map(sameText).filter(Boolean);
    const approved = texts.map((text) => sameText(text.text));
    const missing = approved.filter((text) => !read.includes(text));
    // Words that are not approved: only a provider's own name on its mark, or
    // the name an answer is shown under (its `speaker`), may stand beside them.
    const names = [...MODEL_FAMILIES, ...texts.map((text) => text.speaker).filter((name) => typeof name === "string")].map(sameText);
    const extra = read.filter((text) => !approved.includes(text) && !names.includes(text));
    if (missing.length > 0 || extra.length > 0) {
      review.verdict = review.verdict === "reject" ? "reject" : "fix";
      review.fixes = [
        ...review.fixes,
        ...missing.map((text) => `Show exactly: ${text}`),
        ...extra.map((text) => `Remove text that is not approved: ${text}`),
      ].slice(0, 12);
      review.checked.push("text_mismatch_forced_fix");
    } else {
      review.checked.push("texts_match");
    }
  }
  return { review };
}
