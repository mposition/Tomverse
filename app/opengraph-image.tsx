import { ImageResponse } from "next/og";

export const alt =
  "Tomverse Insight by Tomverse — compare GPT, Claude, and Gemini side by side";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          color: "white",
          background:
            "linear-gradient(135deg, #050816 0%, #111827 52%, #172554 100%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 72,
              height: 72,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 22,
              background: "linear-gradient(135deg, #38bdf8, #6366f1)",
              fontSize: 38,
              fontWeight: 900,
            }}
          >
            T
          </div>
          <div style={{ fontSize: 34, fontWeight: 800 }}>Tomverse AI</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              maxWidth: 980,
              fontSize: 60,
              lineHeight: 1.08,
              fontWeight: 900,
              letterSpacing: "-2px",
            }}
          >
            Tomverse Insight · Multi-AI Comparison & Review
          </div>
          <div style={{ fontSize: 28, color: "#bfdbfe" }}>
            Compare GPT, Claude, and Gemini side by side, then use AI Review to catch what&apos;s missing
          </div>
        </div>
      </div>
    ),
    size
  );
}
