import { ImageResponse } from "next/og";

export const alt = "Wild Hearts Health: every clinic, gently gathered into you.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const HEADLINE = "Every clinic, gently gathered into you.";
const BRAND = "Wild Hearts Health";

const orb =
  "radial-gradient(circle at 36% 30%, #fffdfb 0%, #f7f1ec 45%, #e9e0da 80%, #dcd1ca 100%)";

// Fetch only the glyphs the card uses. If Google Fonts is unreachable at
// build time, fall back to the default font rather than failing the build.
async function loadBrandFont(): Promise<ArrayBuffer | null> {
  try {
    const text = encodeURIComponent(HEADLINE + BRAND);
    const css = await fetch(
      `https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@800&text=${text}`,
    ).then((res) => res.text());
    const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
    if (!url) return null;
    return await fetch(url).then((res) => res.arrayBuffer());
  } catch {
    return null;
  }
}

export default async function OpengraphImage() {
  const font = await loadBrandFont();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 96px",
          background: "#1b1619",
          color: "#f4edef",
          fontFamily: font ? "Rounded" : undefined,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 640 }}>
          <div style={{ display: "flex", fontSize: 30, color: "#ec6e96" }}>{BRAND}</div>
          <div
            style={{
              display: "flex",
              marginTop: 24,
              fontSize: 72,
              lineHeight: 1.08,
              letterSpacing: "-0.02em",
            }}
          >
            {HEADLINE}
          </div>
        </div>
        <div
          style={{
            width: 300,
            height: 300,
            borderRadius: 300,
            background: orb,
            boxShadow: "0 0 120px 20px rgba(255, 214, 196, 0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 58,
          }}
        >
          <div style={{ width: 24, height: 24, borderRadius: 24, background: "#221c20" }} />
          <div style={{ width: 24, height: 24, borderRadius: 24, background: "#221c20" }} />
        </div>
      </div>
    ),
    {
      ...size,
      fonts: font ? [{ name: "Rounded", data: font, weight: 800, style: "normal" }] : undefined,
    },
  );
}
