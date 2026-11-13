// The creative kit: the parts every creative short is laid out with, so the
// failures its reviewer kept finding cannot be built (owner 2026-11-13, after
// four paid runs failed on craft): a screen cropped through a line of words,
// shrunk past reading, or run off the frame; captions and screens on top of
// each other; words outside the safe area; words that are not the plan's; an
// AI shot without its AI line. The film imports it as "../kit" and stays free
// in everything else: backgrounds, colour, motion, rhythm, the idea.
//
// render-creative.mjs copies this folder into the run before every render
// (edits there are overwritten) and wraps the film in <KitRoot>.
import React, { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

import { FRAME, SAFE, SAFE_HEIGHT, SAFE_WIDTH, blocksOf, lineTimes, readGrid, screenScale, screenWord, snapCrop } from "./geometry.js";

export { FRAME, SAFE, SAFE_HEIGHT, SAFE_WIDTH };

type Line = { text: string; file: string; seconds: number };
type Shot = { id: string; file: string; from: number; to: number };
export type FilmProps = {
  locale: string;
  seconds: number;
  lines: Line[];
  screen: string[];
  captures: { name: string; file: string }[];
  shots: Shot[];
  music: string | null;
  logo: string;
  url: string;
};
type GridEntry = { width: number; height: number; cols: number; rows: number; bits: string };
type Kit = { props: FilmProps; aiLine: string; final: boolean; grids: Record<string, ReturnType<typeof readGrid>> };

const KitContext = createContext<Kit | null>(null);
const InStack = createContext(false);

/** Set up by the render entry, not by the film. `final`: the film's own render, not stills. */
export function KitRoot({ props, aiLine, layout, final, children }: { props: FilmProps; aiLine: string; layout: Record<string, GridEntry>; final: boolean; children: React.ReactNode }) {
  const grids = useMemo(() => Object.fromEntries(Object.entries(layout).map(([name, entry]) => [name, readGrid(entry)])), [layout]);
  return <KitContext.Provider value={{ props, aiLine, final, grids }}>{children}</KitContext.Provider>;
}

/**
 * A working view, for stills only (a final render refuses it): the capture
 * fitted to the frame with its blocks of words (blocksOf) outlined and
 * numbered as in kit/blocks-<locale>.json, to choose crops from.
 */
export function BlockMap({ capture }: { capture: string }) {
  const { props, grids, final } = useKit();
  if (final) throw new Error("BlockMap is a working view: take it out of the film");
  const source = props.captures.find((entry) => entry.name === capture);
  const grid = grids[capture];
  if (!source || !grid) throw new Error(`BlockMap "${capture}": no such capture`);
  const scale = FRAME.width / grid.width;
  return (
    <AbsoluteFill style={{ background: "#111827" }}>
      <div style={{ position: "absolute", left: 0, top: 200, width: FRAME.width, height: grid.height * scale }}>
        <Img src={staticFile(source.file)} style={{ width: "100%", height: "100%" }} />
        {blocksOf(grid).map((block, index) => (
          <div key={index} style={{ position: "absolute", left: block.x * scale, top: block.y * scale, width: block.w * scale, height: block.h * scale, border: "3px solid #ef4444" }}>
            <span style={{ position: "absolute", left: 0, top: 0, background: "#ef4444", color: "#fff", font: "700 22px sans-serif", padding: "0 4px" }}>{index}</span>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function useKit(): Kit {
  const kit = useContext(KitContext);
  if (!kit) throw new Error("the kit is used outside the film");
  return kit;
}

/** A CSS font stack for the locale: Geist (or Instrument Serif) first, then the locale's Noto face. */
export function fontFamily(locale: string, role: "sans" | "serif" = "sans") {
  const cjk = locale === "ko" ? "Noto Sans KR Variable" : locale === "zh-Hant" ? "Noto Sans TC Variable" : locale.startsWith("zh") ? "Noto Sans SC Variable" : null;
  return [role === "serif" ? '"Instrument Serif"' : '"Geist Variable"', cjk ? `"${cjk}"` : null, "sans-serif"].filter(Boolean).join(", ");
}

/** The film's props, its AI line, and when each narration line plays (frames). */
export function useFilm() {
  const { props, aiLine } = useKit();
  const { fps } = useVideoConfig();
  return { ...props, aiLine, times: lineTimes(props.lines, fps), font: (role?: "sans" | "serif") => fontFamily(props.locale, role) };
}

/** An entrance: where an element comes from, from which frame (relative to its Sequence). */
export type Enter = { at?: number; from?: "left" | "right" | "up" | "down" | "scale" | "none"; distance?: number; stiffness?: number };

function useEnter(enter: Enter | undefined): React.CSSProperties {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!enter || enter.from === "none") return {};
  const progress = spring({ frame: frame - (enter.at ?? 0), fps, config: { damping: 18, stiffness: enter.stiffness ?? 140, mass: 0.9 } });
  const distance = (1 - progress) * (enter.distance ?? 220);
  const move = { left: `translateX(${-distance}px)`, right: `translateX(${distance}px)`, up: `translateY(${-distance}px)`, down: `translateY(${distance}px)`, scale: `scale(${0.85 + 0.15 * progress})` }[enter.from ?? "up"];
  return { transform: move, opacity: Math.min(1, progress * 1.6) };
}

/** Throws when a box's content overflows it: nothing overlaps or leaves the safe area. */
function useFits(ref: React.RefObject<HTMLDivElement | null>, what: string) {
  const frame = useCurrentFrame();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Layout boxes (offset*), not painted ones: an entrance or a small tilt may pass the edge for a moment.
    let over = 0;
    for (const child of Array.from(element.children) as HTMLElement[]) {
      over = Math.max(over, -child.offsetTop, -child.offsetLeft, child.offsetTop + child.offsetHeight - element.clientHeight, child.offsetLeft + child.offsetWidth - element.clientWidth);
    }
    if (over > 1) {
      throw new Error(`${what} at frame ${frame} of its Sequence overflows the safe area by ${Math.round(over)} px: make its screens shorter or narrower, or its captions smaller, or split it across two moments`);
    }
  });
}

/**
 * The only place words and screens go: a column inside the safe area (90 px
 * sides, 220 px top, 300 px bottom), its children one under another with
 * `gap` between, so they never overlap. `top`/`height` take a part of the safe
 * area (film px from the frame's top); `justify` places the column in it.
 * Several Stacks may share a frame if their parts do not overlap.
 */
export function Stack({ children, top = SAFE.top, height, gap = 32, justify = "center", align = "center" }: { children: React.ReactNode; top?: number; height?: number; gap?: number; justify?: "start" | "center" | "end"; align?: "start" | "center" | "end" }) {
  const ref = useRef<HTMLDivElement>(null);
  const tall = height ?? FRAME.height - SAFE.bottom - top;
  if (top < SAFE.top || top + tall > FRAME.height - SAFE.bottom + 0.5 || tall <= 0) {
    throw new Error(`Stack top ${top} height ${tall} leaves the safe area (y ${SAFE.top} to ${FRAME.height - SAFE.bottom})`);
  }
  useFits(ref, "A Stack");
  const flex = { start: "flex-start", center: "center", end: "flex-end" } as const;
  return (
    <InStack.Provider value>
      <div ref={ref} style={{ position: "absolute", left: SAFE.left, top, width: SAFE_WIDTH, height: tall, display: "flex", flexDirection: "column", justifyContent: flex[justify], alignItems: flex[align], gap }}>
        {children}
      </div>
    </InStack.Provider>
  );
}

/** Screens (or captions) side by side inside a Stack; their widths plus gaps fit the safe width. */
export function Row({ children, gap = 24, align = "start" }: { children: React.ReactNode; gap?: number; align?: "start" | "center" | "end" }) {
  const ref = useRef<HTMLDivElement>(null);
  if (!useContext(InStack)) throw new Error("A Row goes inside a Stack");
  useFits(ref, "A Row");
  const flex = { start: "flex-start", center: "center", end: "flex-end" } as const;
  return (
    <div ref={ref} style={{ position: "relative", display: "flex", flexDirection: "row", gap, alignItems: flex[align], maxWidth: SAFE_WIDTH, flexShrink: 0 }}>
      {children}
    </div>
  );
}

/**
 * A real Tomverse screen: a crop of a capture, drawn `width` film px wide (at
 * most the safe width) and never smaller than its own pixels. Its edges move
 * to the nearest gaps between lines and words, so no word is cut; a crop with
 * no gap nearby, or one too wide to read, stops the render with the reason.
 * Crop in the capture's own pixels (2880x1800 for Review captures).
 */
export function Screen({ capture, crop, width = SAFE_WIDTH, radius = 28, shadow = true, enter, tilt = 0 }: { capture: string; crop: { x: number; y: number; w: number; h: number }; width?: number; radius?: number; shadow?: boolean; enter?: Enter; tilt?: number }) {
  const { props, grids } = useKit();
  const motion = useEnter(enter);
  if (!useContext(InStack)) throw new Error(`Screen "${capture}" goes inside a Stack (or a Row in one), so it never overlaps a caption or leaves the frame`);
  const source = props.captures.find((entry) => entry.name === capture);
  const grid = grids[capture];
  if (!source || !grid) throw new Error(`Screen "${capture}": no such capture; the captures are ${props.captures.map((entry) => entry.name).join(", ")}`);
  if (width > SAFE_WIDTH) throw new Error(`Screen "${capture}": width ${width} is wider than the safe width ${SAFE_WIDTH}`);
  if (Math.abs(tilt) > 3) throw new Error(`Screen "${capture}": tilt ${tilt} degrees; at most 3, or its words stop reading as a screen`);
  const cut = snapCrop(grid, crop, capture);
  const scale = screenScale(cut, width, capture);
  return (
    <div style={{ width, height: Math.round(cut.h * scale), flexShrink: 0, position: "relative", overflow: "hidden", borderRadius: radius, boxShadow: shadow ? "0 24px 60px rgba(15, 23, 42, 0.28)" : undefined, ...motion, transform: [motion.transform, tilt ? `rotate(${tilt}deg)` : null].filter(Boolean).join(" ") || undefined }}>
      <Img src={staticFile(source.file)} style={{ position: "absolute", left: -cut.x * scale, top: -cut.y * scale, width: grid.width * scale, height: grid.height * scale, maxWidth: "none" }} />
    </div>
  );
}

/**
 * One of the props' `screen` lines, exactly as written (anything else stops the
 * render), inside a Stack. Text is 44 px or larger; lines are balanced and
 * Korean breaks between words.
 */
export function Caption({ text, size = 60, weight = 700, serif = false, italic = false, color = "#0f172a", background, padding, radius = 14, align = "center", tilt = 0, maxWidth = SAFE_WIDTH, enter }: { text: string; size?: number; weight?: number; serif?: boolean; italic?: boolean; color?: string; background?: string; padding?: string | number; radius?: number; align?: "left" | "center" | "right"; tilt?: number; maxWidth?: number; enter?: Enter }) {
  const { props } = useKit();
  const motion = useEnter(enter);
  if (!useContext(InStack)) throw new Error(`Caption "${text.slice(0, 40)}" goes inside a Stack, so it stays in the safe area and off the screens`);
  const words = screenWord(props.screen, text);
  if (size < 44) throw new Error(`Caption "${words.slice(0, 40)}": ${size} px; at least 44 px so it reads on a phone`);
  if (Math.abs(tilt) > 4) throw new Error(`Caption "${words.slice(0, 40)}": tilt ${tilt} degrees; at most 4`);
  return (
    <div style={{ maxWidth: Math.min(maxWidth, SAFE_WIDTH), flexShrink: 0, fontFamily: fontFamily(props.locale, serif ? "serif" : "sans"), fontSize: size, fontWeight: weight, fontStyle: italic ? "italic" : "normal", lineHeight: 1.18, color, background, padding: padding ?? (background ? "0.28em 0.5em" : 0), borderRadius: radius, textAlign: align, textWrap: "balance", wordBreak: props.locale === "ko" ? "keep-all" : "normal", overflowWrap: "break-word", ...motion, transform: [motion.transform, tilt ? `rotate(${tilt}deg)` : null].filter(Boolean).join(" ") || undefined }}>
      {words}
    </div>
  );
}

/** The AI line, where the apps never cover it: the bottom of the safe area. */
function AiLine({ color = "#ffffff", shade = "rgba(15, 23, 42, 0.55)" }: { color?: string; shade?: string }) {
  const { props, aiLine } = useKit();
  return (
    <div style={{ position: "absolute", left: SAFE.left, bottom: SAFE.bottom + 12, maxWidth: SAFE_WIDTH, fontFamily: fontFamily(props.locale), fontSize: 30, fontWeight: 600, color, background: shade, padding: "8px 16px", borderRadius: 10 }}>
      {aiLine}
    </div>
  );
}

/**
 * An AI clip, full frame, with its AI line always on it. Children (a Stack of
 * captions, say) draw over the clip; the line stays at the bottom of the safe
 * area, so keep a Stack over a shot above y 1560 (height at most 1340 from 220).
 */
export function Shot({ id, children, fit = "cover", aiColor, aiShade }: { id: string; children?: React.ReactNode; fit?: "cover" | "contain"; aiColor?: string; aiShade?: string }) {
  const { props } = useKit();
  const { fps } = useVideoConfig();
  const shot = props.shots.find((entry) => entry.id === id);
  if (!shot) throw new Error(`Shot "${id}": no such shot; the shots are ${props.shots.map((entry) => entry.id).join(", ")}`);
  return (
    <AbsoluteFill>
      <OffthreadVideo src={staticFile(shot.file)} muted trimBefore={Math.round(shot.from * fps)} trimAfter={Math.round(shot.to * fps)} style={{ width: "100%", height: "100%", objectFit: fit }} />
      {children}
      <AiLine color={aiColor} shade={aiShade} />
    </AbsoluteFill>
  );
}

/** The Tomverse logo, inside a Stack. */
export function Logo({ height = 140, enter }: { height?: number; enter?: Enter }) {
  const { props } = useKit();
  const motion = useEnter(enter);
  if (!useContext(InStack)) throw new Error("Logo goes inside a Stack");
  return <Img src={staticFile(props.logo)} style={{ height, width: "auto", flexShrink: 0, ...motion }} />;
}

/**
 * The end card (its last 2 seconds or more): logo, the url, the call to action
 * (a `screen` line) and the AI line. Draw any background behind it.
 */
export function EndCard({ cta, color = "#0f172a", accent = "#155dfb", aiColor = "#334155", aiShade = "rgba(255, 255, 255, 0.7)" }: { cta?: string; color?: string; accent?: string; aiColor?: string; aiShade?: string }) {
  const { props } = useKit();
  return (
    <AbsoluteFill>
      <Stack gap={36} height={SAFE_HEIGHT - 90}>
        <Logo enter={{ from: "scale" }} />
        <div style={{ fontFamily: fontFamily(props.locale), fontSize: 64, fontWeight: 700, color: accent, flexShrink: 0 }}>{props.url}</div>
        {cta ? <Caption text={cta} size={56} color={color} enter={{ from: "up", at: 6, distance: 60 }} /> : null}
      </Stack>
      <AiLine color={aiColor} shade={aiShade} />
    </AbsoluteFill>
  );
}

/** Every narration line at its time (useFilm().times), and the music under it, ducked while a voice speaks. */
export function Narration({ musicVolume = 0.42, duckedVolume = 0.14 }: { musicVolume?: number; duckedVolume?: number }) {
  const { props } = useKit();
  const { fps } = useVideoConfig();
  const times = lineTimes(props.lines, fps);
  const speaking = (frame: number) => times.some((time: { from: number; frames: number }) => frame >= time.from - 4 && frame < time.from + time.frames + 4);
  return (
    <>
      {props.music ? <Audio src={staticFile(props.music)} loop volume={(frame) => (speaking(frame) ? duckedVolume : musicVolume)} /> : null}
      {props.lines.map((line, index) => (
        <Sequence key={line.file} from={times[index].from} durationInFrames={times[index].frames + 2} layout="none">
          <Audio src={staticFile(line.file)} />
        </Sequence>
      ))}
    </>
  );
}
