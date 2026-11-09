// What the creative short job checks without judgement (owner 2026-11-09: a
// new, different ad every time). A model writes the plan and the film's code;
// everything here is checked before anything is paid for, rendered or
// submitted (docs/policy/marketing-automation.md §2: model text is data).
//
//  - checkPlan: the plan's shape and limits, the AI line on screen in every
//    locale, a capture pack that exists, and a logline not used before.
//  - checkFilmSource: the film may import only react, remotion and its own
//    files, and holds nothing that reaches the network or the machine.
//  - checkFinal: a 1080x1920 video of 10-60 s with sound.
//  - creativeAsset: the registry entry, written here rather than by a model:
//    AI origin, a disclosure on every channel, zh-Hans to RedNote only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { LOCALES } from "./concepts-core.mjs";

/** The on-screen AI line per locale; every film shows it (and the plan must list it). */
export const AI_LINE = Object.freeze({
  en: "Video: partly AI-generated",
  ko: "영상: 일부 AI 생성",
  "zh-Hant": "影片：部分由 AI 生成",
  "zh-Hans": "视频：部分由 AI 生成",
});
export const LIMITS = Object.freeze({ shots: 3, lines: [3, 10], lineChars: 200, localeChars: 700, screenLines: 16, screenChars: 60, altChars: 400, promptChars: 2500, seconds: [15, 38] });
const URL_LIKE = /https?:|www\.|\b[a-z0-9-]+\.(?:com|net|org|ai|io|co)\b/iu;

const isText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
export const compact = (text) => String(text ?? "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

/** The JSON object on the first line of `text` that has `key`, or null. */
export function jsonLine(text, key) {
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    try {
      const value = JSON.parse(line.trim());
      if (value && typeof value === "object" && key in value) return value[key];
    } catch {
      // not it
    }
  }
  return null;
}

/**
 * Checks the plan call's answer.
 * @param packs {Array<{topic: string, locale: string}>} the capture packs on the box
 * @param history {Array<{logline?: string, concept?: string}>} earlier creative shorts
 * @returns {{plan: object, locales: string[]} | {refusal: string}}
 */
export function checkPlan(answer, { packs, history = [] }) {
  const plan = jsonLine(answer, "creative");
  const refuse = (refusal) => ({ refusal });
  if (!plan || typeof plan !== "object") return refuse("the answer held no {\"creative\": ...} line");
  for (const key of ["concept", "logline", "topic", "music"]) if (!isText(plan[key], key === "music" ? LIMITS.promptChars : 300)) return refuse(`${key} is missing or too long`);
  if (!Number.isInteger(plan.seconds) || plan.seconds < LIMITS.seconds[0] || plan.seconds > LIMITS.seconds[1]) return refuse(`seconds is a whole number from ${LIMITS.seconds[0]} to ${LIMITS.seconds[1]}`);
  const topicPacks = packs.filter((pack) => pack.topic === plan.topic);
  if (topicPacks.length === 0) return refuse(`no capture pack has the topic ${plan.topic}`);

  if (!Array.isArray(plan.shots) || plan.shots.length > LIMITS.shots) return refuse(`shots is a list of at most ${LIMITS.shots}`);
  const ids = new Set();
  for (const shot of plan.shots) {
    if (!shot || !/^[a-z][a-z0-9-]{0,20}$/u.test(shot.id ?? "") || ids.has(shot.id)) return refuse("every shot has its own short id (a-z, 0-9, -)");
    ids.add(shot.id);
    if (!isText(shot.image, LIMITS.promptChars) || !isText(shot.motion, LIMITS.promptChars)) return refuse(`shot ${shot.id} needs an image prompt and a motion prompt`);
  }

  if (!plan.locales || typeof plan.locales !== "object") return refuse("locales is missing");
  for (const locale of Object.keys(plan.locales)) if (!LOCALES.includes(locale)) return refuse(`${locale} is not a locale`);
  // A locale is made when its plan is there and a pack of the topic has its captures.
  const made = LOCALES.filter((locale) => plan.locales[locale] && topicPacks.some((pack) => pack.locale === locale));
  if (made.length === 0) return refuse("no planned locale has a capture pack of the topic");
  for (const locale of made) {
    const words = plan.locales[locale];
    if (!Array.isArray(words.lines) || words.lines.length < LIMITS.lines[0] || words.lines.length > LIMITS.lines[1]) return refuse(`${locale}: lines is a list of ${LIMITS.lines[0]}-${LIMITS.lines[1]} narration lines`);
    if (!words.lines.every((line) => isText(line, LIMITS.lineChars))) return refuse(`${locale}: a narration line is empty or longer than ${LIMITS.lineChars}`);
    if (words.lines.join("").length > LIMITS.localeChars) return refuse(`${locale}: the narration is longer than ${LIMITS.localeChars} characters`);
    if (!Array.isArray(words.screen) || words.screen.length > LIMITS.screenLines || !words.screen.every((line) => isText(line, LIMITS.screenChars))) return refuse(`${locale}: screen is at most ${LIMITS.screenLines} lines of at most ${LIMITS.screenChars}`);
    if (!words.screen.includes(AI_LINE[locale])) return refuse(`${locale}: screen must include the AI line "${AI_LINE[locale]}" exactly`);
    if (!isText(words.alt, LIMITS.altChars)) return refuse(`${locale}: alt is missing or longer than ${LIMITS.altChars}`);
    if ([...words.lines, ...words.screen].some((line) => URL_LIKE.test(line))) return refuse(`${locale}: no web address in the words (the end card carries tomverse.app)`);
  }
  const logline = compact(plan.logline);
  const concept = compact(plan.concept);
  if (history.some((entry) => compact(entry.logline) === logline || compact(entry.concept) === concept)) return refuse("this concept or logline was used before: make a new one");
  return { plan, locales: made };
}

/** Import specifiers the film may use; anything else (and every package) is refused. */
const ALLOWED_IMPORTS = new Set(["react", "remotion"]);
const FORBIDDEN = [
  [/\bfetch\s*\(/u, "fetch"],
  [/XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon/u, "a network API"],
  [/\beval\s*\(|new\s+Function\b|\bimport\s*\(/u, "eval, new Function or a dynamic import"],
  [/\brequire\s*\(|\bprocess\.|__dirname|child_process/u, "Node APIs"],
  [/https?:\/\/|\/\/[a-z0-9-]+\.[a-z]/iu, "a URL"],
  [/document\.cookie|localStorage|sessionStorage|indexedDB/u, "browser storage"],
  [/Math\.random\s*\(|Date\.now\s*\(|new\s+Date\s*\(/u, "randomness or the clock (a frame must be a pure function of time)"],
];

/** Problems with the film's code (film/*.tsx, *.ts), or [] when it may be rendered. */
export function checkFilmSource(filmDir) {
  const problems = [];
  let files = [];
  try {
    files = readdirSync(filmDir);
  } catch {
    return ["there is no film folder"];
  }
  if (!files.includes("Film.tsx")) problems.push("film/Film.tsx is missing");
  for (const name of files) {
    const full = path.join(filmDir, name);
    if (statSync(full).isDirectory()) {
      problems.push(`${name}: the film folder holds files only`);
      continue;
    }
    if (!/^[A-Za-z0-9_-]+\.(?:tsx|ts)$/u.test(name)) {
      problems.push(`${name}: only .tsx and .ts files`);
      continue;
    }
    const source = readFileSync(full, "utf8");
    for (const match of source.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/gu)) {
      const spec = match[1] ?? match[2];
      const local = /^\.\/[A-Za-z0-9_-]+(?:\.tsx?)?$/u.test(spec);
      if (!local && !ALLOWED_IMPORTS.has(spec)) problems.push(`${name}: imports ${spec} (only react, remotion and ./ files)`);
    }
    for (const [pattern, what] of FORBIDDEN) if (pattern.test(source)) problems.push(`${name}: uses ${what}`);
  }
  return problems;
}

/** Problems with a finished file, from ffprobe's JSON (-show_streams -show_format), or []. */
export function checkFinal(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const seconds = Number(probe?.format?.duration);
  const problems = [];
  if (!video || video.width !== 1080 || video.height !== 1920) problems.push("not a 1080x1920 video");
  if (!audio) problems.push("no sound");
  if (!(seconds >= 10 && seconds <= 60)) problems.push("not 10-60 seconds long");
  return problems;
}

/** Where a locale's creative short may go: zh-Hans is RedNote's (Simplified). */
export const CHANNELS = Object.freeze({
  en: ["instagram", "youtube", "tiktok", "x"],
  ko: ["instagram", "youtube", "tiktok", "x"],
  "zh-Hant": ["instagram", "youtube", "tiktok", "x"],
  "zh-Hans": ["rednote"],
});
/**
 * Never `none`: the narration, the music and the shots are AI-made. YouTube's
 * label is set by the publisher (containsSyntheticMedia); the other platforms'
 * posts carry it in the caption, and RedNote, posted by hand, both.
 */
const DISCLOSURE = Object.freeze({ instagram: "caption_disclosure", youtube: "platform_label", tiktok: "caption_disclosure", x: "caption_disclosure", rednote: "platform_label_and_caption" });

/**
 * The asset file submit-asset.mjs sends. Real captures mixed with AI shots,
 * voice and music: `ai_modified`, and so not marked as depicting the product
 * interface (lib/marketingAssets.ts allows that only for an AI presenter).
 */
export function creativeAsset({ id, locale, words, today = new Date() }) {
  const channels = CHANNELS[locale];
  if (!channels) throw new Error(`no channels for ${locale}`);
  const validUntil = new Date(today.getTime() + 90 * 86_400_000).toISOString().slice(0, 10);
  return {
    asset: {
      id,
      provenance: "ai_modified",
      allowedChannels: [...channels],
      alt: { [locale]: words.alt },
      claimIds: [],
      validUntil,
      disclosure: Object.fromEntries(channels.map((channel) => [channel, DISCLOSURE[channel]])),
      depictsProductInterface: false,
    },
    transcript: { [locale]: `${words.lines.join(" ")}\n\n${[...words.screen, "tomverse.app"].join("\n")}` },
  };
}
