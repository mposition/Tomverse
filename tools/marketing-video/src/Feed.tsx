import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { z } from "zod";

import { FPS } from "./schema";

/**
 * The 4:5 feed version of an approved 9:16 short (owner decision 2026-11-04):
 * the short itself, whole and unchanged with its sound, on a 1080x1350 frame in
 * the brand's light grey (#f7f8fa) with a #e4e4e7 rule, so a feed that crops
 * 9:16 shows all of it. Nothing is drawn over the picture.
 */
export const feedSchema = z.object({
  /** The short, as a file beside the props (served as a static file). */
  video: z.string().min(1),
  seconds: z.number().positive().max(600),
});
export type FeedProps = z.infer<typeof feedSchema>;

export const feedFrames = (props: FeedProps) => Math.ceil(feedSchema.parse(props).seconds * FPS);

const HEIGHT = 1270;
const WIDTH = Math.round((HEIGHT * 9) / 16);

export function FeedVideo({ video }: FeedProps) {
  return (
    <AbsoluteFill style={{ backgroundColor: "#f7f8fa", alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          width: WIDTH,
          height: HEIGHT,
          borderRadius: 28,
          overflow: "hidden",
          outline: "2px solid #e4e4e7",
          boxShadow: "0 18px 48px rgba(24, 24, 27, 0.16)",
        }}
      >
        <OffthreadVideo src={staticFile(video)} style={{ width: WIDTH, height: HEIGHT }} />
      </div>
    </AbsoluteFill>
  );
}
