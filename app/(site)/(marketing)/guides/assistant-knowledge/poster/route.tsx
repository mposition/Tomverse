import { ImageResponse } from "next/og";

export const dynamic = "force-static";

const imageSize = { width: 1200, height: 630 };

export function GET() {
  const steps = [
    { number: "01", title: "ASSISTANT", detail: "NAME + INSTRUCTIONS" },
    { number: "02", title: "KNOWLEDGE", detail: "ADD + SELECT" },
    { number: "03", title: "CHAT", detail: "CHOOSE + ASK" },
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "58px 64px",
          color: "#f8fafc",
          background:
            "linear-gradient(135deg, #09090b 0%, #18181b 55%, #0f3d3a 100%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 58,
              height: 58,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 18,
              background: "#14b8a6",
              color: "#042f2e",
              fontSize: 30,
              fontWeight: 900,
            }}
          >
            T
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 28, fontWeight: 900 }}>Tomverse</div>
            <div
              style={{
                marginTop: 3,
                color: "#99f6e4",
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: 2.4,
              }}
            >
              MY AI ASSISTANT + KNOWLEDGE
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 30 }}>
          <div
            style={{
              maxWidth: 940,
              fontSize: 58,
              lineHeight: 1.05,
              fontWeight: 900,
              letterSpacing: -2,
            }}
          >
            Your way of working. Your source material. One assistant.
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            {steps.map((step) => (
              <div
                key={step.number}
                style={{
                  width: 338,
                  display: "flex",
                  alignItems: "center",
                  gap: 15,
                  padding: "17px 18px",
                  border: "1px solid rgba(153,246,228,0.28)",
                  borderRadius: 18,
                  background: "rgba(9,9,11,0.58)",
                }}
              >
                <div
                  style={{
                    width: 48,
                    height: 48,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 14,
                    background: "#ccfbf1",
                    color: "#115e59",
                    fontSize: 17,
                    fontWeight: 900,
                  }}
                >
                  {step.number}
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <div style={{ fontSize: 18, fontWeight: 900 }}>{step.title}</div>
                  <div
                    style={{
                      marginTop: 4,
                      color: "#a1a1aa",
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: 1.2,
                    }}
                  >
                    {step.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    imageSize
  );
}
