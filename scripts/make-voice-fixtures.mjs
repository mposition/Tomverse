/**
 * Records real `MediaRecorder` clips and writes them to tests/fixtures/voice/.
 *
 *   node scripts/make-voice-fixtures.mjs
 *
 * ## Why the fixtures are recorded rather than written
 *
 * AGENTS.md, "채팅 첨부 형식과 압축파일": a binary parser's happy path is tested
 * with real documents, because a fixture written by our own writer only proves
 * that the writer and the parser agree with each other. `lib/voiceClipDuration.ts`
 * exists to read what browsers actually produce, so what it is tested against
 * has to be what a browser actually produced.
 *
 * This drives Chromium through Playwright with no microphone involved: an
 * `OscillatorNode` into a `MediaStreamDestination` is a real media stream, and
 * `MediaRecorder` encodes it exactly as it encodes a microphone. The container
 * is the artefact under test; what is inside it is a tone.
 *
 * Safari's MP4 cannot be recorded here, and this script does not pretend
 * otherwise — that gap is item D-3 on
 * docs/ops/voice-input-staging-checklist.md.
 *
 * The outputs are committed. Regenerating them is only necessary when the
 * pinned Chromium changes enough to alter its muxer, and a diff in these files
 * is a signal worth reading rather than noise to be accepted.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = resolve(root, "tests/fixtures/voice");

/**
 * Playwright's own download is skipped in some environments in favour of a
 * preinstalled browser, so an explicit path is honoured when given.
 */
const executablePath = process.env.VOICE_FIXTURE_CHROMIUM || undefined;

const CLIPS = [
  { file: "chromium-webm-opus-2500ms.webm", mimeType: "audio/webm;codecs=opus", ms: 2500 },
  { file: "chromium-mp4-aac-3000ms.mp4", mimeType: "audio/mp4", ms: 3000 },
  // Long enough that the duration limit's refusal path can be exercised
  // against a real container by comparing it with a lowered threshold, rather
  // than by recording an actual two-minute clip into the repository.
  { file: "chromium-webm-opus-400ms.webm", mimeType: "audio/webm;codecs=opus", ms: 400 },
];

const browser = await chromium.launch(
  executablePath ? { executablePath } : undefined
);
try {
  const page = await browser.newPage();
  await page.goto("about:blank");

  for (const clip of CLIPS) {
    const bytes = await page.evaluate(async ({ mimeType, ms }) => {
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        throw new Error(`This Chromium cannot record ${mimeType}`);
      }
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();

      const recorder = new MediaRecorder(destination.stream, {
        mimeType,
        audioBitsPerSecond: 32_000,
      });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolveStop) => {
        recorder.onstop = resolveStop;
      });
      recorder.start();
      await new Promise((wait) => setTimeout(wait, ms));
      recorder.stop();
      await stopped;
      oscillator.stop();
      await context.close();

      const blob = new Blob(chunks, { type: mimeType });
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }, clip);

    const target = resolve(outputDirectory, clip.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(bytes));
    console.log(`  ${clip.file}  ${bytes.length} bytes  (${clip.mimeType})`);
  }
} finally {
  await browser.close();
}
