import type { Metadata } from "next";
import { alt as opengraphImageAlt } from "@/app/opengraph-image";
import { siteUrl } from "@/app/lib/site";

type PageMetadata = {
  title: string;
  description: string;
  path: string;
  type?: "website" | "article";
};

const socialImage = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: opengraphImageAlt,
};

export function absoluteUrl(path: string) {
  if (path === "/") return siteUrl;
  return new URL(path, `${siteUrl}/`).toString();
}

export function pageMetadata({
  title,
  description,
  path,
  type = "website",
}: PageMetadata): Metadata {
  const socialTitle = `${title} · PixelKiln`;

  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type,
      title: socialTitle,
      description,
      url: path,
      siteName: "PixelKiln",
      images: [socialImage],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: [socialImage],
    },
  };
}
