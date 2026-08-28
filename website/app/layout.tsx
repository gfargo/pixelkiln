import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { siteUrl } from "@/app/lib/site";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "PixelKiln — Pixel-art generation with receipts",
    template: "%s · PixelKiln",
  },
  description:
    "A provider-neutral, PixelLab-proven pipeline to plan, review, recover, and package generative pixel art with exact provenance.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: "PixelKiln — Pixel-art generation with receipts",
    description:
      "A provider-neutral pipeline for planned costs, human review, exact provenance, resilient recovery, and engine-ready pixel art.",
    url: "/",
    siteName: "PixelKiln",
  },
  twitter: {
    card: "summary_large_image",
    title: "PixelKiln — Pixel-art generation with receipts",
    description:
      "A deterministic pipeline for generative pixel art, from planned cost to engine-ready output.",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
