import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { siteUrl } from "@/app/lib/site";
import { SiteAnalytics } from "@/app/ui/site-analytics";
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
  applicationName: "PixelKiln",
  title: {
    default: "PixelKiln: A build pipeline for generated pixel art",
    template: "%s · PixelKiln",
  },
  description:
    "Plan provider costs, review candidates and frame sets, recover paid work, and package pixel art from PixelLab, Retro Diffusion, ComfyUI, or Scenario.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: "PixelKiln: A build pipeline for generated pixel art",
    description:
      "Plan provider costs, review candidates, recover paid work, and package generated pixel art with recorded hashes.",
    url: "/",
    siteName: "PixelKiln",
  },
  twitter: {
    card: "summary_large_image",
    title: "PixelKiln: A build pipeline for generated pixel art",
    description:
      "Plan provider costs, review candidates, recover paid work, and package generated pixel art.",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      data-scroll-behavior="smooth"
    >
      <body>
        {children}
        <SiteAnalytics />
      </body>
    </html>
  );
}
