import { ImageResponse } from "next/og";

export const alt =
  "PixelKiln plans costs, records review, and tracks every generated pixel-art file.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const markCells = [
  { left: 11, top: 0, color: "#ff6b35" },
  { left: 0, top: 11, color: "#ff6b35" },
  { left: 11, top: 11, color: "#f3ead6" },
  { left: 22, top: 11, color: "#ff6b35" },
  { left: 11, top: 22, color: "#ff6b35" },
];

const candidates = [
  { label: "01", accent: "#ff6b35", selected: false },
  { label: "02", accent: "#b9f27c", selected: true },
  { label: "03", accent: "#ff9c5f", selected: false },
];

function KilnMark() {
  return (
    <div
      style={{
        width: 30,
        height: 30,
        display: "flex",
        position: "relative",
        transform: "rotate(45deg)",
      }}
    >
      {markCells.map((cell) => (
        <div
          key={`${cell.left}-${cell.top}`}
          style={{
            position: "absolute",
            left: cell.left,
            top: cell.top,
            width: 8,
            height: 8,
            display: "flex",
            background: cell.color,
          }}
        />
      ))}
    </div>
  );
}

function Candidate({
  label,
  accent,
  selected,
}: {
  label: string;
  accent: string;
  selected: boolean;
}) {
  return (
    <div
      style={{
        width: 92,
        height: 112,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "13px 10px 9px",
        border: `1px solid ${selected ? "#b9f27c" : "#4a4539"}`,
        background: selected ? "#22251a" : "#17150f",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          background: "#211e17",
        }}
      >
        <div
          style={{
            width: 26,
            height: 10,
            display: "flex",
            background: accent,
            position: "absolute",
            top: 18,
          }}
        />
        <div
          style={{
            width: 10,
            height: 24,
            display: "flex",
            background: "#f3ead6",
            position: "absolute",
            top: 12,
          }}
        />
        <div
          style={{
            width: 6,
            height: 6,
            display: "flex",
            background: accent,
            position: "absolute",
            top: 8,
            right: 8,
          }}
        />
      </div>
      <div
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          color: selected ? "#b9f27c" : "#827b6e",
          fontSize: 12,
          fontFamily: "monospace",
        }}
      >
        <span>{label}</span>
        <span>{selected ? "PICK" : "·"}</span>
      </div>
    </div>
  );
}

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "46px 54px 42px",
        backgroundColor: "#14120d",
        backgroundImage:
          "linear-gradient(rgba(243,234,214,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(243,234,214,0.035) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
        color: "#f3ead6",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          height: 54,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingBottom: 22,
          borderBottom: "1px solid #4a4539",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 17 }}>
          <KilnMark />
          <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.04em" }}>
            pixelkiln
          </span>
        </div>
        <span style={{ color: "#827b6e", fontSize: 15, fontFamily: "monospace" }}>
          PIXELKILN.GRIFFEN.CODES
        </span>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 52,
        }}
      >
        <div
          style={{
            width: 620,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
          }}
        >
          <span
            style={{
              marginBottom: 21,
              color: "#ff9c5f",
              fontSize: 16,
              fontFamily: "monospace",
              letterSpacing: "0.12em",
            }}
          >
            GENERATIVE PIXEL ART · BUILT LIKE SOFTWARE
          </span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 65,
              lineHeight: 0.98,
              fontWeight: 700,
              letterSpacing: "-0.055em",
            }}
          >
            <span>Generate pixels.</span>
            <span style={{ color: "#ff6b35" }}>Keep the receipts.</span>
          </div>
          <span
            style={{
              width: 570,
              marginTop: 27,
              color: "#a49c8d",
              fontSize: 21,
              lineHeight: 1.4,
            }}
          >
            Plan cost, review candidates, recover paid work, and export
            reviewed assets with recorded source and output hashes.
          </span>
        </div>

        <div
          style={{
            width: 396,
            height: 330,
            display: "flex",
            flexDirection: "column",
            border: "1px solid #5a5345",
            background: "#1a1812",
          }}
        >
          <div
            style={{
              height: 50,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 18px",
              borderBottom: "1px solid #4a4539",
              fontFamily: "monospace",
              fontSize: 12,
            }}
          >
            <span style={{ color: "#a49c8d" }}>LOCALHOST · PIXELKILN PICK</span>
            <span style={{ color: "#b9f27c" }}>HUMAN REVIEW</span>
          </div>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              padding: "20px 22px 18px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 16,
                fontSize: 14,
              }}
            >
              <span>brand / forge-mark</span>
              <span style={{ color: "#827b6e", fontFamily: "monospace" }}>1 OF 3</span>
            </div>
            <div style={{ display: "flex", gap: 13 }}>
              {candidates.map((candidate) => (
                <Candidate key={candidate.label} {...candidate} />
              ))}
            </div>
            <div
              style={{
                marginTop: 17,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontFamily: "monospace",
                fontSize: 12,
              }}
            >
              <span style={{ color: "#827b6e" }}>NO MODEL SELECTS FOR YOU</span>
              <span
                style={{
                  display: "flex",
                  padding: "7px 10px",
                  background: "#ff6b35",
                  color: "#17150f",
                  fontWeight: 700,
                }}
              >
                APPLY 1
              </span>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          height: 48,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          paddingTop: 18,
          borderTop: "1px solid #4a4539",
          color: "#a49c8d",
          fontFamily: "monospace",
          fontSize: 14,
          letterSpacing: "0.04em",
        }}
      >
        <span>MANIFEST → PLAN → REVIEW → SHIP</span>
        <div style={{ display: "flex", gap: 25 }}>
          <span>HARD BUDGETS</span>
          <span style={{ color: "#b9f27c" }}>EXACT PROVENANCE</span>
        </div>
      </div>
    </div>,
    size,
  );
}
