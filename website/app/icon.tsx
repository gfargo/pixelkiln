import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

const cells = [
  { left: 13, top: 0, color: "#ff6b35" },
  { left: 0, top: 13, color: "#ff6b35" },
  { left: 13, top: 13, color: "#f3ead6" },
  { left: 26, top: 13, color: "#ff6b35" },
  { left: 13, top: 26, color: "#ff6b35" },
];

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
          width: 36,
          height: 36,
          display: "flex",
          position: "relative",
          transform: "rotate(45deg)",
        }}
      >
        {cells.map((cell) => (
          <div
            key={`${cell.left}-${cell.top}`}
            style={{
              position: "absolute",
              left: cell.left,
              top: cell.top,
              width: 10,
              height: 10,
              display: "flex",
              background: cell.color,
            }}
          />
        ))}
      </div>
    </div>,
    size,
  );
}
