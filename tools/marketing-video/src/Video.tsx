import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { FPS, type Scene, type VideoProps } from "./schema";

// Brand colours from the Canva thumbnail template: near-black, white, violet.
const BG = "#090912";
const FG = "#fafafa";
const ACCENT = "#783cd8";
// A family per locale that has the script's glyphs: the Canva test showed a
// display face without Hangul falling back to a thin system font.
const FONT: Record<VideoProps["locale"], string> = {
  en: "Inter, 'Helvetica Neue', Arial, sans-serif",
  ko: "Pretendard, 'Noto Sans KR', 'Malgun Gothic', sans-serif",
  "zh-Hant": "'Noto Sans TC', 'Microsoft JhengHei', sans-serif",
};

/** Keep the writer's line breaks; break Korean between words, never inside one. */
const TEXT = { whiteSpace: "pre-line", wordBreak: "keep-all", overflowWrap: "break-word" } as const;

const isVideo = (src: string) => /\.(mp4|webm|mov)(\?|$)/i.test(src);
const source = (media: string) => (/^https?:\/\//.test(media) ? media : staticFile(media));

function Caption({ text, font, portrait }: { text: string; font: string; portrait: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        left: "6%",
        right: "6%",
        bottom: portrait ? "12%" : "6%",
        textAlign: "center",
        fontFamily: font,
        fontWeight: 700,
        fontSize: portrait ? 54 : 42,
        lineHeight: 1.3,
        color: FG,
        ...TEXT,
      }}
    >
      <span
        style={{
          background: "rgba(9,9,18,0.78)",
          padding: "6px 18px",
          borderRadius: 12,
          boxDecorationBreak: "clone",
          WebkitBoxDecorationBreak: "clone",
        }}
      >
        {text}
      </span>
    </div>
  );
}

function SceneView({ scene, font }: { scene: Scene; font: string }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const fadeIn = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  const rise = interpolate(frame, [0, 12], [24, 0], { extrapolateRight: "clamp" });

  if (scene.kind === "capture" && scene.media) {
    // Real product footage, framed like a screen on the brand background.
    const zoom = interpolate(frame, [0, scene.seconds * FPS], [1, 1.06]);
    const src = source(scene.media);
    return (
      <AbsoluteFill style={{ background: BG }}>
        <AbsoluteFill style={{ padding: portrait ? "16% 5% 36%" : "6% 12% 14%", opacity: fadeIn }}>
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: 28,
              overflow: "hidden",
              border: `3px solid ${ACCENT}`,
              boxShadow: `0 0 60px ${ACCENT}66`,
            }}
          >
            {isVideo(scene.media) ? (
              <OffthreadVideo src={src} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <Img
                src={src}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  objectPosition: "top",
                  transform: `scale(${zoom})`,
                }}
              />
            )}
          </div>
        </AbsoluteFill>
        {scene.headline ? (
          <div
            style={{
              position: "absolute",
              top: portrait ? "6%" : "1.2%",
              width: "100%",
              textAlign: "center",
              fontFamily: font,
              fontWeight: 800,
              fontSize: portrait ? 64 : 46,
              color: FG,
              opacity: fadeIn,
              ...TEXT,
            }}
          >
            {scene.headline}
          </div>
        ) : null}
        {scene.caption ? <Caption text={scene.caption} font={font} portrait={portrait} /> : null}
      </AbsoluteFill>
    );
  }

  // Title and CTA: words on the brand background.
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at 70% 30%, ${ACCENT}55, ${BG} 60%)`,
        justifyContent: "center",
        padding: portrait ? "0 8%" : "0 10%",
      }}
    >
      <div style={{ transform: `translateY(${rise}px)`, opacity: fadeIn }}>
        {scene.headline ? (
          <div style={{ fontFamily: font, fontWeight: 900, fontSize: portrait ? 120 : 108, lineHeight: 1.08, color: FG, ...TEXT }}>
            {scene.headline}
          </div>
        ) : null}
        {scene.subline ? (
          <div style={{ fontFamily: font, fontWeight: 700, fontSize: portrait ? 62 : 54, marginTop: 28, color: ACCENT, ...TEXT }}>
            {scene.subline}
          </div>
        ) : null}
        <div style={{ fontFamily: FONT.en, fontWeight: 800, fontSize: portrait ? 44 : 36, marginTop: 48, color: FG, opacity: 0.85 }}>
          Tomverse
        </div>
      </div>
      {scene.caption ? <Caption text={scene.caption} font={font} portrait={portrait} /> : null}
    </AbsoluteFill>
  );
}

export function MarketingVideo(props: VideoProps) {
  const font = FONT[props.locale];
  let from = 0;
  return (
    <AbsoluteFill style={{ background: BG }}>
      {props.scenes.map((scene, index) => {
        const duration = Math.round(scene.seconds * FPS);
        const start = from;
        from += duration;
        return (
          <Sequence key={index} from={start} durationInFrames={duration}>
            <SceneView scene={scene} font={font} />
          </Sequence>
        );
      })}
      {props.audio ? <Audio src={source(props.audio)} /> : null}
    </AbsoluteFill>
  );
}
