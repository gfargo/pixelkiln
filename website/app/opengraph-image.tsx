import { ImageResponse } from "next/og";

export const alt = "PixelKiln — Fire once. Ship every sprite with receipts.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "68px 76px",
        background: "#17150f",
        color: "#f3ead6",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 24 }}>
        <div style={{ width: 25, height: 25, display: "flex", background: "#ff6b35", transform: "rotate(45deg)" }} />
        <span style={{ fontWeight: 700, letterSpacing: "-0.04em" }}>pixelkiln</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 72, lineHeight: 0.98, fontWeight: 700, letterSpacing: "-0.055em" }}>
          Fire once. Ship every sprite
        </span>
        <span style={{ color: "#ff6b35", fontSize: 72, lineHeight: 1.05, fontWeight: 700, letterSpacing: "-0.055em" }}>
          with receipts.
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", color: "#a49c8d", fontSize: 20 }}>
        <span>Deterministic pixel-art operations</span>
        <span style={{ color: "#b9f27c" }}>plan · review · recover · ship</span>
      </div>
    </div>,
    size,
  );
}
