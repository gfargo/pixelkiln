import type { MetadataRoute } from "next";
import { docs } from "@/app/lib/docs";
import { siteUrl } from "@/app/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      changeFrequency: "monthly",
      priority: 1,
      images: [
        `${siteUrl}/review-ui-showcase.jpg`,
        `${siteUrl}/benchmarks/provider-environments/pixellab/isolated/a/mountain-observatory.png`,
        `${siteUrl}/benchmarks/provider-environments/pixellab/background/a/alpine-valley.png`,
        `${siteUrl}/benchmarks/provider-environments/retrodiffusion/isolated/a/mountain-observatory.png`,
        `${siteUrl}/benchmarks/provider-environments/retrodiffusion/background/a/alpine-valley.png`,
      ],
    },
    { url: `${siteUrl}/docs`, changeFrequency: "weekly", priority: 0.9 },
    ...docs.map((doc) => ({
      url: `${siteUrl}/docs/${doc.slug}`,
      changeFrequency: "weekly" as const,
      priority: doc.group === "Start here" ? 0.8 : 0.7,
    })),
  ];
}
