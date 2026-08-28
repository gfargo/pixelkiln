import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
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
      <div
        style={{
          width: 28,
          height: 28,
          display: "flex",
          border: "7px solid #ff6b35",
          background: "#f3ead6",
          transform: "rotate(45deg)",
        }}
      />
    </div>,
    size,
  );
}
