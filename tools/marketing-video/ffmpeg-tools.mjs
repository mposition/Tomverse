// The ffmpeg and ffprobe Remotion ships (the box has no system ffmpeg), or the
// ones on the PATH elsewhere. Used by the creative short job.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function compositorDir() {
  const dir = path.join(here, "node_modules", "@remotion");
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).filter((entry) => entry.startsWith("compositor-")).sort().find((entry) => existsSync(path.join(dir, entry, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")));
  return name ? path.join(dir, name) : null;
}

function binary(name) {
  const dir = compositorDir();
  if (!dir) return { file: name, env: process.env };
  // The compositor's libraries sit beside its binaries.
  const env = { ...process.env, LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) };
  return { file: path.join(dir, process.platform === "win32" ? `${name}.exe` : name), env };
}

export function ffmpeg(args) {
  const { file, env } = binary("ffmpeg");
  return execFileSync(file, ["-v", "error", "-y", ...args], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** ffmpeg's raw output bytes (a decoded picture), for an output of `-`. */
export function ffmpegBytes(args) {
  const { file, env } = binary("ffmpeg");
  return execFileSync(file, ["-v", "error", ...args], { env, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** ffprobe's JSON for a file: streams and format. */
export function probe(file) {
  const { file: bin, env } = binary("ffprobe");
  return JSON.parse(execFileSync(bin, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { env, encoding: "utf8" }));
}

export const seconds = (file) => Number(probe(file).format?.duration);

/** A narration line at the same loudness as the others (engines and lines differ by several dB). */
export const levelVoice = (input, out, lufs = -16) => ffmpeg(["-i", input, "-af", `loudnorm=I=${lufs}:TP=-2:LRA=7`, "-ar", "48000", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", out]);

/** A finished film mastered to -14 LUFS / -1 dBTP; the picture is copied as it is. */
export const master = (input, out) => ffmpeg(["-i", input, "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]);

/** Stills of a clip, `fps` a second, as PNGs in `dir` (for the model that checks AI shots). */
export function stills(input, dir, fps = 4) {
  mkdirSync(dir, { recursive: true });
  // `-r` on the output, not the fps filter: Remotion's ffmpeg is built without it.
  ffmpeg(["-i", input, "-vf", "scale=540:-2", "-r", String(fps), path.join(dir, "t%03d.png")]);
  return readdirSync(dir).filter((name) => name.endsWith(".png")).sort();
}
