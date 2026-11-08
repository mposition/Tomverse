// The daily media job's Higgsfield image path (owner 2026-11-08), run by
// run-daily.sh only when MARKETING_MEDIA_IMAGE_PATH=higgsfield:
//   node run-higgsfield.mjs
// Deterministic: it picks the feature, runs each model call with only the
// tools that call needs, checks every answer before acting on it, spends only
// through hf-image-core.mjs (the cap), and submits. No model call here has a
// shell, a write tool, MCP, the submission secret or the Higgsfield login.
//
//  1. concepts   one Claude call (JOB-higgsfield.md), Read on research notes;
//                check-concepts rules; asked once more with the reason
//  2. picture    the English picture per concept (gpt_image_2_6, 4:5, one)
//  3. review 1   a separate Claude call, Read on its own review folder: the
//                guide as a checklist, plus where marks and words sit
//  4. refine     on "fix", one edit, then review 1 again; not "pass" drops it
//  5. languages  per locale one edit (headline space cleared, screen words
//                replaced), real-font screen words, one smoothing edit, then
//                the real-font headline (never redrawn by the model)
//  6. review 2   a separate Claude call reads every word; check-review
//                compares them with the approved words; one remake, then
//                that locale is dropped
//  7. marks      flat provider marks painted over with the real files
//  8. card       the band (logo, address, AI line), make-card.mjs checks
//  9. submit     submit-asset.mjs; history.json keeps concept, device,
//                feature, credits and verdicts
// The report is one JSON line, as JOB.md's.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bandLayout, BAND_ALT } from "./band-layout.mjs";
import { checkConcepts, loadFeatures, pickFeature, recentDevices, TRANSLATED } from "./concepts-core.mjs";
import { bottomIsDark, ICON_DIR, setLogos, setTexts } from "./compose-core.mjs";
import { brisbaneDay, ledgerPath, readLedger } from "./higgsfield-cap.mjs";
import { makeImage } from "./hf-image-core.mjs";
import { checkReview, textsFor } from "./review-core.mjs";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(toolDir);
const day = brisbaneDay();
const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
const dir = path.join("job", day);
const genDir = path.join(dir, "generated");
for (const sub of [genDir, path.join(dir, "review"), path.join(dir, "calls")]) mkdirSync(sub, { recursive: true });
const report = { job: "marketing-media", path: "higgsfield", date, feature: null, concepts: [], submitted: [], refused: [], failed: [], dropped: [], halted: null, credits: 0 };
const finish = (code) => {
  try {
    report.credits = readLedger(ledgerPath("job", day)).entries.reduce((sum, entry) => sum + entry.cost, 0);
  } catch {
    // no ledger: nothing was spent
  }
  console.log(JSON.stringify(report));
  process.exit(code);
};

const node = (args, env = process.env) => spawnSync(process.execPath, args, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
/** The environment a model call gets: no submission secret, no app address, no Higgsfield login or cap. */
const modelEnv = () => {
  const env = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
  for (const key of Object.keys(env)) if (/^(MARKETING_MEDIA_SUBMIT_SECRET|MARKETING_APP_URL|MARKETING_HIGGSFIELD_|HIGGSFIELD_|HF_)/u.test(key)) delete env[key];
  return env;
};

/** One Claude CLI call with Read on `readGlob` only. Its stream stays in job/<day>/calls/. Returns the final answer or null. */
function claude(name, prompt, readGlob, maxTurns) {
  const bin = process.env.CLAUDE_BIN || "claude";
  // A .mjs stand-in (a local dry run) is run with node.
  const [command, prefix] = /\.m?js$/u.test(bin) ? [process.execPath, [bin]] : [bin, []];
  const out = spawnSync(
    command,
    [
      ...prefix,
      "--print",
      prompt,
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--strict-mcp-config",
      "--tools",
      "Read",
      "--allowedTools",
      `Read(${readGlob})`,
      "--disallowedTools",
      "mcp__*",
      "--max-turns",
      String(maxTurns),
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    { encoding: "utf8", env: modelEnv(), timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(path.join(dir, "calls", `${name}.jsonl`), out.stdout ?? "");
  let answer = null;
  for (const line of String(out.stdout ?? "").split(/\r?\n/u)) {
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && typeof event.result === "string") answer = event.result;
    } catch {
      // not an event
    }
  }
  return answer;
}

const firstJsonLine = (text, key) => {
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    try {
      const value = JSON.parse(line.trim());
      if (value && typeof value === "object" && key in value) return value;
    } catch {
      // not it
    }
  }
  return null;
};

// 0. Stop the whole run only when the approved list cannot be read, as JOB.md.
const listed = node(["list-approved.mjs"]);
if (listed.status !== 0) {
  report.failed.push({ id: null, step: "list-approved", status: listed.status });
  finish(1);
}
const historyPath = path.join("job", "history.json");
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [];
const features = loadFeatures(toolDir);
const feature = pickFeature(history, features, day);
report.feature = feature;

// 1. Concepts.
const notesDir = path.join("job", "research-notes");
const newestNotes = existsSync(notesDir) ? readdirSync(notesDir).filter((file) => /^\d{8}\.json$/u.test(file)).sort().at(-1) : undefined;
const guide = readFileSync("HIGGSFIELD-GUIDE.md", "utf8");
const conceptPrompt = [
  readFileSync("JOB-higgsfield.md", "utf8").replace("{{GUIDE}}", guide),
  `## Today\n\n- Date: ${date}\n- Feature: ${feature}\n- Newest research notes: ${newestNotes ? `job/research-notes/${newestNotes}` : "none"}`,
  `## Scene ideas used in the last 14 days\n\n${recentDevices(history, day).map((device) => `- ${device}`).join("\n") || "- none"}`,
  `## Logo files\n\n${readdirSync(ICON_DIR).filter((file) => file.endsWith(".png")).map((file) => file.replace(/\.png$/u, "")).join(", ")}`,
  `## features.json\n\n\`\`\`json\n${readFileSync("features.json", "utf8")}\n\`\`\``,
].join("\n\n");
let concepts = null;
let refusal = null;
for (let attempt = 1; attempt <= 2 && !concepts; attempt += 1) {
  const prompt = refusal ? `${conceptPrompt}\n\n## Your last answer was refused\n\n${refusal}\nAnswer again, fixing that.` : conceptPrompt;
  const answer = firstJsonLine(claude(`concepts-${attempt}`, prompt, "./job/research-notes/**", 20), "concepts");
  refusal = answer ? checkConcepts(answer, { feature, history, day, toolDir }) : "the answer held no concepts line";
  if (!refusal) concepts = answer.concepts;
}
if (!concepts) {
  report.failed.push({ id: null, step: "concepts", error: refusal });
  finish(1);
}
const conceptsPath = path.join(dir, "concepts.json");
writeFileSync(conceptsPath, `${JSON.stringify({ feature, concepts }, null, 1)}\n`);
report.concepts = concepts.map((concept) => concept.id);

// Paid steps stop for the day at the first refusal by the cap; finished cards are still submitted.
const HALTING = new Set(["no_daily_cap", "ledger_locked", "daily_cap_reached", "unknown_outcome_pending", "cost_unreadable", "cost_above_call_ceiling", "create_outcome_unknown", "wait_outcome_unknown", "more_than_one_job"]);
const NO_LOGO = "Do not draw the Tomverse logo, any wordmark or any web address. Fill the frame edge to edge, and keep the bottom 10% of the picture calm, without text or important detail.";
async function picture(label, prompt, references, out) {
  if (report.halted) return null;
  let made;
  try {
    made = await makeImage({ prompt: `${prompt}\n\n${NO_LOGO}`, references, out, label, jobDir: "job", day });
  } catch (error) {
    // An error inside a paid call (the ledger could not be written, say): no further paid call today.
    made = { ok: false, reason: "call_error", detail: String(error instanceof Error ? error.message : error).slice(0, 200) };
    report.halted = { at: label, reason: "call_error" };
  }
  if (made.ok) return out;
  if (HALTING.has(made.reason)) report.halted = { at: label, reason: made.reason };
  report.failed.push({ id: label, step: "higgsfield", reason: made.reason });
  return null;
}

const STAGE_RULES = {
  guide:
    "Judge rules 1-11 of the guide one by one. Look hard at hands and fingers (rule 5), at every logo against its real file, and at every word on the picture against `texts`. On `fix`, write each change so an image model can make it in one edit.",
  content:
    "Read every piece of text in the picture exactly as it is written, character by character, and list it in `readTexts`, one string per text, in reading order, even where it is wrong. Do not correct what you read. Then check the facts, the logos and the hands again. A script compares your `readTexts` with `texts`.",
};
const ANSWER_SHAPE = {
  guide: '`{"id":"<concept id>","verdict":"pass|fix|reject","fixes":["..."],"logoBoxes":[...],"textBoxes":[...]}`',
  content: '`{"id":"<concept id>","verdict":"pass|fix|reject","fixes":["..."],"readTexts":["..."],"logoBoxes":[...],"textBoxes":[...]}`',
};
/** One review call on its own folder; the checked review, or null. */
function review(stage, concept, locale, file, attempt) {
  const name = `${concept.id}-${locale}-${stage}-${attempt}`;
  const folder = path.join(dir, "review", name);
  mkdirSync(path.join(folder, "logos"), { recursive: true });
  copyFileSync(file, path.join(folder, "picture.png"));
  writeFileSync(path.join(folder, "concept.json"), JSON.stringify({ id: concept.id, feature: concept.feature, device: concept.device, texts: textsFor(concept, locale), logos: concept.logos }, null, 1));
  for (const logo of concept.logos) copyFileSync(path.join(ICON_DIR, `${logo}.png`), path.join(folder, "logos", `${logo}.png`));
  const rel = folder.split(path.sep).join("/");
  const prompt = readFileSync("REVIEW-higgsfield.md", "utf8")
    .replaceAll("{{DIR}}", rel)
    .replaceAll("{{STAGE}}", stage)
    .replaceAll("{{LOCALE}}", locale)
    .replace("{{GUIDE}}", guide)
    .replace("{{STAGE_RULES}}", STAGE_RULES[stage])
    .replace("{{ANSWER_SHAPE}}", ANSWER_SHAPE[stage]);
  const checked = checkReview(claude(`review-${name}`, prompt, `./${rel}/**`, 12) ?? "", { stage, concept, locale });
  if (checked.problem) {
    report.failed.push({ id: name, step: "check-review", error: checked.problem });
    return null;
  }
  writeFileSync(path.join(folder, "review.json"), JSON.stringify(checked.review, null, 1));
  return checked.review;
}

const editPrompt = (fixes) => `Edit the attached picture. Keep everything else exactly as it is: the people, the scene, the light, the composition and every word that is right. Make only these changes:\n${fixes.map((fix) => `- ${fix}`).join("\n")}`;
const SMOOTH =
  "Edit the attached picture. Do not change a single character of any text. Make the whole photo look natural, as if the words were really shown on the screens: match each screen's light, focus, glare and perspective, and keep everything else as it is.";
const localePrompt = (concept, locale, boxes) => {
  const texts = textsFor(concept, locale);
  const cleared = boxes.filter((box) => box.role !== "screen").map((box) => `"${concept.texts[box.textIndex].text}"`);
  const screens = boxes.filter((box) => box.role === "screen").map((box) => `- "${concept.texts[box.textIndex].text}" becomes "${texts[box.textIndex].text}"`);
  return [
    "Edit the attached picture. Keep the scene, the people, the light, the provider logos and the layout exactly as they are.",
    cleared.length > 0 ? `Remove these words and leave their space clean, continuing the background, with no letters at all: ${cleared.join(", ")}.` : "",
    screens.length > 0 ? `Replace the words on the screens, exactly, keeping model and company names as written:\n${screens.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

const madeIds = new Set(history.map((entry) => entry.id).filter(Boolean));
const newId = (locale) => {
  const base = `media-${day}-${feature}-${locale.toLowerCase()}-card`;
  let id = base;
  for (let n = 2; madeIds.has(id); n += 1) id = `${base}-${n}`;
  madeIds.add(id);
  return id;
};
const newHistory = [];
const creditsFor = (prefix) => readLedger(ledgerPath("job", day)).entries.filter((entry) => String(entry.label ?? "").startsWith(prefix)).reduce((sum, entry) => sum + entry.cost, 0);

/** Marks, band, card, submit. */
async function deliver(concept, locale, file, verdicts) {
  const marked = path.join(genDir, `${concept.id}-${locale.toLowerCase()}-final.png`);
  await setLogos({ input: file, review: verdicts.at(-1), out: marked });
  const id = newId(locale);
  const name = path.basename(marked);
  writeFileSync(path.join(dir, `${id}.layout.html`), bandLayout({ picture: name, locale, dark: await bottomIsDark(marked) }));
  writeFileSync(
    path.join(dir, `${id}.spec.json`),
    JSON.stringify({ id, locale, layout: `${id}.layout.html`, alt: `${concept.alt[locale]} ${BAND_ALT[locale]}`, texts: textsFor(concept, locale).map((text) => text.text) }, null, 1),
  );
  const entry = { date, id, locale, kind: "card", path: "higgsfield", feature, concept: concept.device, device: concept.device, pictures: [`generated:${name}`], headline: textsFor(concept, locale).find((text) => text.role === "headline")?.text ?? null, verdicts: verdicts.map((v) => `${v.stage}:${v.verdict}`), refused: null };
  newHistory.push(entry);
  const card = node(["make-card.mjs", path.join(dir, `${id}.spec.json`), dir]);
  if (card.status !== 0) {
    entry.refused = "make-card";
    report.failed.push({ id, step: "make-card", error: card.stderr.trim().slice(0, 400) });
    return;
  }
  const submitted = node(["submit-asset.mjs", path.join(dir, `${id}.png`), path.join(dir, `${id}.asset.json`)]);
  if (submitted.status === 0) report.submitted.push(id);
  else if (submitted.status === 3) {
    const codes = firstJsonLine(submitted.stdout, "guardCodes")?.guardCodes ?? [];
    entry.refused = codes;
    report.refused.push({ id, guardCodes: codes });
  } else {
    entry.refused = "submit";
    report.failed.push({ id, step: "submit", status: submitted.status });
  }
}

const drop = (concept, locale, reason) => {
  report.dropped.push({ id: `${concept.id}-${locale}`, reason });
  newHistory.push({ date, id: null, locale, kind: "card", path: "higgsfield", feature, concept: concept.device, device: concept.device, dropped: reason });
};

for (const concept of concepts) {
  const logos = concept.logos.map((logo) => path.join(ICON_DIR, `${logo}.png`));
  // 2-4. The English picture and its guide review.
  let en = await picture(`${concept.id}/en/make`, concept.prompt_en, logos, path.join(genDir, `${concept.id}-en-1.png`));
  if (!en) {
    drop(concept, "en", "not_made");
    continue;
  }
  let guideReview = review("guide", concept, "en", en, 1);
  if (guideReview?.verdict === "fix") {
    en = await picture(`${concept.id}/en/refine`, editPrompt(guideReview.fixes), [en, ...logos], path.join(genDir, `${concept.id}-en-2.png`));
    guideReview = en ? review("guide", concept, "en", en, 2) : null;
  }
  if (!en || guideReview?.verdict !== "pass") {
    drop(concept, "en", guideReview ? `guide_${guideReview.verdict}` : "guide_not_passed");
    continue;
  }
  const base = en;
  const boxes = guideReview.textBoxes;

  // 6-9 for English: the model's own words, read back and compared.
  {
    let file = base;
    let content = review("content", concept, "en", file, 1);
    if (content && content.verdict === "fix") {
      file = await picture(`${concept.id}/en/remake`, editPrompt(content.fixes), [file, ...logos], path.join(genDir, `${concept.id}-en-3.png`));
      content = file ? review("content", concept, "en", file, 2) : null;
    }
    if (file && content?.verdict === "pass") {
      try {
        await deliver(concept, "en", file, [guideReview, content]);
      } catch (caught) {
        report.failed.push({ id: `${concept.id}-en`, step: "compose", error: String(caught instanceof Error ? caught.message : caught).slice(0, 300) });
      }
    } else drop(concept, "en", content ? `content_${content.verdict}` : "content_not_passed");
  }

  // 5-9 for the other languages.
  for (const locale of TRANSLATED) {
    let delivered = false;
    let content = null;
    let error = null;
    try {
      for (let attempt = 1; attempt <= 2 && !delivered && !report.halted; attempt += 1) {
        const stem = path.join(genDir, `${concept.id}-${locale.toLowerCase()}-${attempt}`);
        const edited = await picture(`${concept.id}/${locale}/edit`, localePrompt(concept, locale, boxes), [base, ...logos], `${stem}-a.png`);
        if (!edited) break;
        let file = edited;
        if (boxes.some((box) => box.role === "screen")) {
          await setTexts({ input: file, review: guideReview, concept, locale, roles: ["screen"], out: `${stem}-b.png` });
          file = await picture(`${concept.id}/${locale}/smooth`, SMOOTH, [`${stem}-b.png`], `${stem}-c.png`);
          if (!file) break;
        }
        // The headline last, so no model edit ever redraws its letters.
        await setTexts({ input: file, review: guideReview, concept, locale, roles: ["headline", "cta"], out: `${stem}-d.png` });
        content = review("content", concept, locale, `${stem}-d.png`, attempt);
        if (content?.verdict === "pass") {
          delivered = true;
          await deliver(concept, locale, `${stem}-d.png`, [guideReview, content]);
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      report.failed.push({ id: `${concept.id}-${locale}`, step: "compose", error: error.slice(0, 300) });
    }
    if (!delivered) drop(concept, locale, error ? "compose_failed" : content ? `content_${content.verdict}` : report.halted ? "halted" : "not_made");
  }
}

// Feed videos on Mondays (Brisbane), as JOB.md: each usable pack whose short
// has no feed video yet, its approved file unchanged on a 4:5 frame. No model
// and no credits: the id comes from the pack's own asset id.
if (new Date().toLocaleDateString("en-US", { timeZone: "Australia/Brisbane", weekday: "long" }) === "Monday") {
  const approved = new Set(JSON.parse(readFileSync(path.join("job", "approved.json"), "utf8")).map((asset) => asset.id ?? asset.assetId));
  const sources = path.join("job", "sources");
  for (const assetId of existsSync(sources) ? readdirSync(sources) : []) {
    const packPath = path.join(sources, assetId, "pack.json");
    if (!existsSync(packPath)) continue;
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    if (!approved.has(pack.assetId) || !["en", "ko", "zh-Hant"].includes(pack.locale)) continue;
    const topic = pack.assetId.replace(/^media-(?:\d{8}-)?/u, "").replace(/-short$/u, "").slice(0, 60).replace(/-+$/u, "");
    if (history.some((entry) => entry.kind === "feed" && (entry.source === pack.assetId || String(entry.id ?? "").includes(topic)))) continue;
    const id = `media-${day}-${topic}-feed`;
    const made = node(["make-feed-video.mjs", packPath, id, dir]);
    const entry = { date, id, locale: pack.locale, kind: "feed", path: "higgsfield", source: pack.assetId, feature: null, refused: null };
    newHistory.push(entry);
    if (made.status !== 0) {
      entry.refused = "make-feed-video";
      report.failed.push({ id, step: "make-feed-video", status: made.status });
      continue;
    }
    const submitted = node(["submit-asset.mjs", path.join(dir, `${id}.mp4`), path.join(dir, `${id}.asset.json`)]);
    if (submitted.status === 0) report.submitted.push(id);
    else {
      entry.refused = submitted.status === 3 ? firstJsonLine(submitted.stdout, "guardCodes")?.guardCodes ?? [] : "submit";
      (submitted.status === 3 ? report.refused : report.failed).push({ id, ...(submitted.status === 3 ? { guardCodes: entry.refused } : { step: "submit", status: submitted.status }) });
    }
  }
}

// History: one entry per asset or dropped version, with the credits of its concept.
for (const entry of newHistory) {
  const concept = concepts.find((candidate) => candidate.device === entry.device);
  entry.credits = concept ? creditsFor(`${concept.id}/${entry.locale}/`) : 0;
}
writeFileSync(historyPath, `${JSON.stringify([...history, ...newHistory], null, 1)}\n`);
finish(0);
