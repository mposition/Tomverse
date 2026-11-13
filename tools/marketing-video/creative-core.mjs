// What the creative short job checks without judgement (owner 2026-11-09: a
// new, different ad every time). A model writes the plan and the film's code;
// everything here is checked before anything is paid for, rendered or
// submitted (docs/policy/marketing-automation.md §2: model text is data).
//
//  - checkPlan: the plan's shape and limits, the AI line on screen in every
//    locale, a capture pack that exists, and a logline not used before.
//  - checkFilmSource: the film may import only react, remotion and its own
//    files (read by a parser), and holds nothing that reaches the network or
//    the machine. render-creative.mjs also renders it in a sandbox.
//  - usablePacks: capture packs of shorts approved now and still valid.
//  - checkFinal: a 1080x1920 video of 10-60 s with sound.
//  - creativeAsset: the registry entry, written here rather than by a model:
//    AI origin, a disclosure on every channel, zh-Hans to RedNote only.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

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

/**
 * A Claude CLI file rule anchored at an absolute path ("//abs/path"; on Windows "//c/..."). A
 * relative "./path" rule is read against the shell's current directory, which a `cd` in the
 * model's first Bash command moves: run 20261110-2 lost every Write to film/ that way. Edit rules
 * also cover Write; a Write(path) rule matches nothing.
 */
export function fileRule(tool, file, resolve = path.resolve, sep = path.sep) {
  const absolute = resolve(file).split(sep).join("/").replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`);
  return `${tool}(/${absolute})`;
}

/**
 * The stills in `dir` as posix paths, sorted, at most about `keep` of them spread evenly. The plan
 * and review calls have Read only, which cannot list a folder, so every still they are to look at
 * is named in the prompt (run 20261111's review saw none and gave no verdict).
 */
export function stillsIn(dir, keep = Infinity) {
  const files = existsSync(dir) ? readdirSync(dir).filter((file) => /\.(?:png|jpe?g)$/u.test(file)).sort() : [];
  const step = Math.max(1, Math.ceil(files.length / keep));
  return files.filter((_, index) => index % step === 0).map((file) => path.join(dir, file).split(path.sep).join("/"));
}

/** The final answer in a Claude CLI stream-json transcript, or null. */
export function answerOf(stream) {
  let answer = null;
  for (const line of String(stream ?? "").split(/\r?\n/u)) {
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && typeof event.result === "string") answer = event.result;
    } catch {
      // not an event
    }
  }
  return answer;
}

/**
 * Where a run's build stands, from its calls/ transcripts: how many build rounds ran and the last
 * review's verdict (null when none answered). A rebuild (owner 2026-11-11) goes on from there with
 * the run's paid shots, music and voice, so it spends nothing.
 */
export function lastBuild(callsDir) {
  const files = existsSync(callsDir) ? readdirSync(callsDir) : [];
  const rounds = (prefix) => files.map((file) => new RegExp(`^${prefix}-(\\d+)\\.jsonl$`, "u").exec(file)?.[1]).filter(Boolean).map(Number);
  const builds = rounds("build");
  const reviews = rounds("review");
  const last = reviews.length > 0 ? Math.max(...reviews) : 0;
  const review = last > 0 ? jsonLine(answerOf(readFileSync(path.join(callsDir, `review-${last}.jsonl`), "utf8")), "review") : null;
  return { rounds: builds.length > 0 ? Math.max(...builds) : 0, review: review && typeof review === "object" ? review : null };
}

/**
 * The pack a run's copied captures came from, among `packs` (approved now): the one of the topic
 * and locale whose present captures are exactly the files in `captureDir`, by name and byte. A
 * rebuild renders those copies, so its words and claims must come from that pack and no other; when
 * none matches (the pack changed or is no longer approved), null.
 * @returns {{pack: object, words: string[]} | null}
 */
export function packOfRun(captureDir, packs, topic, locale) {
  const copied = existsSync(captureDir) ? readdirSync(captureDir).sort() : [];
  if (copied.length === 0) return null;
  for (const pack of packs) {
    if (pack.topic !== topic || pack.locale !== locale) continue;
    const entries = Object.entries(pack.captures);
    const named = entries.map(([name, { file }]) => `${name}${path.extname(file)}`);
    if (named.length !== copied.length || [...named].sort().some((name, index) => name !== copied[index])) continue;
    const same = entries.every(([name, { file }]) => {
      const from = path.join(pack.dir, file);
      return existsSync(from) && readFileSync(from).equals(readFileSync(path.join(captureDir, `${name}${path.extname(file)}`)));
    });
    if (same) return { pack, words: entries.map(([, { text }]) => text) };
  }
  return null;
}

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
    if (!Array.isArray(words.screen) || words.screen.length > LIMITS.screenLines || !words.screen.every((line) => isText(line, LIMITS.screenChars))) {
      // Name the line to mend, so a retry changes that line and nothing else.
      const long = Array.isArray(words.screen) ? words.screen.find((line) => !isText(line, LIMITS.screenChars)) : undefined;
      return refuse(`${locale}: screen is at most ${LIMITS.screenLines} lines of at most ${LIMITS.screenChars} characters${Array.isArray(words.screen) && words.screen.length > LIMITS.screenLines ? ` (it has ${words.screen.length})` : ""}${long !== undefined ? `; shorten or split ${JSON.stringify(String(long).slice(0, 120))}` : ""}`);
    }
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
/** The creative kit (creative-kit/), copied into the run by render-creative.mjs: the job's code, not the film's. */
const KIT_IMPORT = "../kit";
const LOCAL_IMPORT = /^\.\/([A-Za-z0-9_-]+)(\.tsx?)?$/u;
/**
 * A second, cruder layer after the parser: words that have no place in a film
 * drawn from props. The boundary that holds is the parser (every import, in
 * any syntax) and render-creative.mjs's sandbox (no network, no secrets).
 */
const FORBIDDEN = [
  [/\bfetch\b/u, "fetch"],
  [/XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|\bWorker\b/u, "a network or worker API"],
  [/\beval\b|\bFunction\s*\(|new\s+Function\b|\bimport\s*\(|import\.meta/u, "eval, Function, a dynamic import or import.meta"],
  [/\brequire\b|\bprocess\b|__dirname|__filename|__webpack|__non_webpack|child_process|\bmodule\.|\bglobalThis\b|\bwindow\b|\bdocument\b/u, "Node, webpack or page globals"],
  [/https?:\/\/|\/\/[a-z0-9-]+\.[a-z]|\bnew\s+URL\b/iu, "a URL"],
  [/localStorage|sessionStorage|indexedDB|\bcookie\b/u, "browser storage"],
  [/Math\.random\s*\(|Date\.now\s*\(|new\s+Date\s*\(|performance\.now/u, "randomness or the clock (a frame must be a pure function of time)"],
  // Screens, the logo and AI clips come only through the kit (Screen, Logo, Shot), which keeps
  // their words whole, readable and in the safe area, and the AI line on every clip.
  [/\b(?:Img|OffthreadVideo|IFrame|staticFile)\b|<Video\b|<img\b|<video\b/u, "Img, a video or staticFile (show screens with the kit's Screen, clips with Shot, the logo with Logo, the voice with Narration)"],
];

/**
 * Every import of every file in the film, read by esbuild's parser (static,
 * re-export, side-effect, dynamic and require, comments and all), so no
 * spelling slips past: a bare `react` or `remotion`, or `./Name` that is a
 * .ts/.tsx file in the film folder. A webpack loader (`!`), a package, a path
 * out of the folder and every dynamic form are refused. verbatimModuleSyntax
 * keeps an unused import visible instead of dropping it unread.
 */
async function importProblems(dir, names) {
  // esbuild wants absolute paths back from a plugin; the runner passes a relative folder.
  const filmDir = path.resolve(dir);
  const problems = [];
  const plugin = {
    name: "film-imports",
    setup(builder) {
      // esbuild takes a Go regular expression: no `u` flag.
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: args.path };
        const from = path.basename(args.importer);
        const refuse = (why) => {
          problems.push(`${from}: ${why}`);
          return { path: args.path, external: true };
        };
        if (args.kind !== "import-statement") return refuse(`${args.kind} of ${args.path} (static imports only)`);
        if (ALLOWED_IMPORTS.has(args.path) || args.path === KIT_IMPORT) return { path: args.path, external: true };
        const local = LOCAL_IMPORT.exec(args.path);
        if (!local) return refuse(`imports ${args.path} (only react, remotion, ../kit and ./ files)`);
        const file = (local[2] ? [args.path] : [`${args.path}.tsx`, `${args.path}.ts`]).map((name) => path.join(filmDir, name)).find((candidate) => existsSync(candidate));
        if (!file) return refuse(`imports ${args.path}, which is not a file in film/`);
        return { path: file };
      });
    },
  };
  try {
    await build({
      entryPoints: names.map((name) => path.join(filmDir, name)),
      bundle: true,
      write: false,
      outdir: path.join(filmDir, ".check"),
      format: "esm",
      platform: "browser",
      jsx: "transform",
      logLevel: "silent",
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      plugins: [plugin],
    });
  } catch (error) {
    const first = error?.errors?.[0];
    problems.push(first ? `${path.basename(first.location?.file ?? "film")}:${first.location?.line ?? 0}: ${first.text}` : `the film does not compile: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  return problems;
}

/** Problems with the film's code (film/*.tsx, *.ts), or [] when it may be rendered. */
export async function checkFilmSource(filmDir) {
  const problems = [];
  let files = [];
  try {
    files = readdirSync(filmDir);
  } catch {
    return ["there is no film folder"];
  }
  if (!files.includes("Film.tsx")) problems.push("film/Film.tsx is missing");
  const sources = [];
  for (const name of files) {
    const full = path.join(filmDir, name);
    if (lstatSync(full).isDirectory() || !lstatSync(full).isFile()) {
      problems.push(`${name}: the film folder holds plain files only`);
      continue;
    }
    if (!/^[A-Za-z0-9_-]+\.(?:tsx|ts)$/u.test(name)) {
      problems.push(`${name}: only .tsx and .ts files`);
      continue;
    }
    sources.push(name);
    const source = readFileSync(full, "utf8");
    for (const [pattern, what] of FORBIDDEN) if (pattern.test(source)) problems.push(`${name}: uses ${what}`);
  }
  if (problems.length > 0 || sources.length === 0) return problems;
  return importProblems(filmDir, sources);
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

/**
 * The packs whose short is approved now and still valid (job/approved.json,
 * as list-approved.mjs wrote it this run): a pack left on the box from a short
 * that was never approved, retired or expired is not a source.
 * @param approved {Array<{id: string, validUntil?: string}>}
 * @param date {string} today, YYYY-MM-DD (Brisbane)
 */
export function usablePacks(packs, approved, date) {
  const valid = new Set((Array.isArray(approved) ? approved : []).filter((asset) => typeof asset?.id === "string" && (!asset.validUntil || asset.validUntil >= date)).map((asset) => asset.id));
  return packs.filter((pack) => typeof pack.assetId === "string" && valid.has(pack.assetId));
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
 * voice and music.
 *
 * Provenance: `capture_with_ai_media` with `depictsProductInterface: true`
 * (owner decision 2026-11-09): the product screens are real captures from an
 * approved short, unchanged, and the run makes no film without one; the shots,
 * the voice and the music are AI-made, so it is of AI origin and disclosed on
 * every channel (lib/marketingAssets.ts, policy §7.3).
 *
 * What the Guard reads is still the whole film, as make-card.mjs does for a
 * card with captures: the words inside the captures it shows go into the
 * transcript, and the claims of the approved short they came from go with it.
 */
export function creativeAsset({ id, locale, words, captureWords = [], claimIds = [], today = new Date() }) {
  const channels = CHANNELS[locale];
  if (!channels) throw new Error(`no channels for ${locale}`);
  const validUntil = new Date(today.getTime() + 90 * 86_400_000).toISOString().slice(0, 10);
  const inside = captureWords.map((text) => String(text).replace(/\s+/gu, " ").trim()).filter(Boolean);
  return {
    asset: {
      id,
      provenance: "capture_with_ai_media",
      allowedChannels: [...channels],
      alt: { [locale]: words.alt },
      claimIds: [...new Set(claimIds)],
      validUntil,
      disclosure: Object.fromEntries(channels.map((channel) => [channel, DISCLOSURE[channel]])),
      depictsProductInterface: true,
    },
    transcript: { [locale]: [words.lines.join(" "), [...words.screen, "tomverse.app"].join("\n"), ...(inside.length > 0 ? [inside.join("\n")] : [])].join("\n\n") },
  };
}

/** The scores CREATIVE-REVIEW.md asks for; a pass needs every one at 8 or more. */
export const REVIEW_SCORES = Object.freeze(["creative", "craft", "readability", "truth", "disclosure"]);
/** Whether the review call's answer passes the film: the verdict and every score, checked here. */
export function reviewPassed(review) {
  if (review?.verdict !== "pass" || !review.scores || typeof review.scores !== "object") return false;
  return REVIEW_SCORES.every((key) => Number.isFinite(review.scores[key]) && review.scores[key] >= 8 && review.scores[key] <= 10);
}

const PACK_LOCALE = /-(?:en|ko|zh-hant|zh-hans)$/u;
/** A pack's topic: its own, or its short's id without date, locale and `-short` (as the daily job names topics). */
export const packTopic = (assetId) => String(assetId).replace(/^media-(?:\d{8}-)?/u, "").replace(/-short$/u, "").replace(PACK_LOCALE, "");

/**
 * Either pack shape as one: `captures` ({name: {file, text}}, JOB.md), or the
 * first packs' `images` with `captureText`/`summaryText` (make-card.mjs reads
 * both the same way). Null for a pack with no locale or no capture file.
 */
export function normalizePack(raw) {
  if (!raw || typeof raw.assetId !== "string" || !LOCALES.includes(raw.locale)) return null;
  const source =
    raw.captures && typeof raw.captures === "object"
      ? raw.captures
      : Object.fromEntries(
          [
            ["left", raw.captureText?.[0]],
            ["center", raw.captureText?.[1]],
            ["right", raw.captureText?.[2]],
            ["summary", raw.summaryText],
          ].map(([name, text]) => [name, { file: raw.images?.[name], text }]),
        );
  // A capture is a real product screen. The logo is not one (the film takes it from the library),
  // so a pack with only a logo left has no screen and is not usable.
  const captures = Object.fromEntries(
    Object.entries(source)
      .filter(([name, entry]) => /^[A-Za-z0-9_-]{1,40}$/u.test(name) && name.toLowerCase() !== "logo" && typeof entry?.file === "string" && /^[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp)$/iu.test(entry.file))
      .map(([name, entry]) => [name, { file: entry.file, text: Array.isArray(entry.text) ? entry.text.join(" ") : String(entry.text ?? "") }]),
  );
  if (Object.keys(captures).length === 0) return null;
  const topic = typeof raw.topic === "string" && raw.topic.trim() ? raw.topic.trim() : packTopic(raw.assetId);
  return { assetId: raw.assetId, locale: raw.locale, topic, captures, videoAsset: typeof raw.videoAsset === "string" ? raw.videoAsset : null };
}
