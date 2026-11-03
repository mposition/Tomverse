import React from "react";
import { Composition } from "remotion";

import { FeedVideo, feedFrames, type FeedProps } from "./Feed";
import { MarketingVideo } from "./Video";
import { FPS, totalFrames, videoSchema, type VideoProps } from "./schema";

const sample: VideoProps = {
  locale: "en",
  scenes: [{ kind: "title", headline: "Three AIs, one question", subline: "Side by side", seconds: 3 }],
};

const calculateMetadata = ({ props }: { props: VideoProps }) => ({
  durationInFrames: totalFrames(videoSchema.parse(props)),
});

/** One scene list, two frames: short (9:16) and long (16:9); and the 4:5 feed version of a short. */
export function Root() {
  return (
    <>
      <Composition
        id="Short"
        component={MarketingVideo}
        width={1080}
        height={1920}
        fps={FPS}
        durationInFrames={FPS * 3}
        defaultProps={sample}
        calculateMetadata={calculateMetadata}
      />
      <Composition
        id="Long"
        component={MarketingVideo}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={FPS * 3}
        defaultProps={sample}
        calculateMetadata={calculateMetadata}
      />
      <Composition
        id="Feed"
        component={FeedVideo}
        width={1080}
        height={1350}
        fps={FPS}
        durationInFrames={FPS * 3}
        defaultProps={{ video: "short.mp4", seconds: 3 }}
        calculateMetadata={({ props }: { props: FeedProps }) => ({ durationInFrames: feedFrames(props) })}
      />
    </>
  );
}
