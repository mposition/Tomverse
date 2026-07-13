import { ImageResponse } from "next/og";

export const alt =
  "Tomverse AI — compare leading AI models in one workspace";
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
              fontSize: 68,
              lineHeight: 1.08,
              fontWeight: 900,
              letterSpacing: "-2px",
            }}
          >
            Compare leading AI models in one workspace
          </div>
          <div style={{ fontSize: 28, color: "#bfdbfe" }}>
            Side-by-side answers · File analysis · Organized conversations
          </div>
        </div>
      </div>
    ),
    size
  );
}
