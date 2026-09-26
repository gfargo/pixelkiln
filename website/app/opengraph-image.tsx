import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt =
  "PixelKiln plans costs, records review, and tracks every generated pixel-art file.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const markDataUrl = `data:image/png;base64,${readFileSync(
  join(process.cwd(), "public/brand/kiln-mark-v3.png"),
).toString("base64")}`;

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          backgroundColor: "#14120d",
          color: "#f3ead6",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div
          style={{
            width: 420,
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#1c1912",
            borderRight: "1px solid #4a4539",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={markDataUrl} width={200} height={200} alt="" />
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "0 60px",
            backgroundImage:
              "linear-gradient(rgba(243,234,214,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(243,234,214,0.035) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        >
          <span
            style={{
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              marginBottom: 18,
              color: "#a49c8d",
            }}
          >
            pixelkiln
          </span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 56,
              lineHeight: 1.0,
              fontWeight: 700,
              letterSpacing: "-0.045em",
            }}
          >
            <span>Generate pixels.</span>
            <span style={{ color: "#ff6b35" }}>Keep the receipts.</span>
          </div>
          <span
            style={{
              marginTop: 24,
              color: "#a49c8d",
              fontSize: 19,
              lineHeight: 1.4,
              width: 520,
            }}
          >
            Plan cost, review candidates, recover paid work, and export
            reviewed assets with recorded hashes.
          </span>
        </div>
      </div>
    ),
    size,
  );
}
