import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

const markDataUrl = `data:image/png;base64,${readFileSync(
  join(process.cwd(), "public/brand/kiln-mark-v2.png"),
).toString("base64")}`;

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#17150f",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={markDataUrl}
          width={64}
          height={64}
          alt=""
          style={{ imageRendering: "pixelated" }}
        />
      </div>
    ),
    size,
  );
}
