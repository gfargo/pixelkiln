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
        `${siteUrl}/benchmarks/provider-environments/pixellab/isolated/a/cliffside-fortress.png`,
        `${siteUrl}/benchmarks/provider-environments/pixellab/background/a/volcanic-pass.png`,
        `${siteUrl}/benchmarks/provider-environments/retrodiffusion/isolated/a/cliffside-fortress.png`,
        `${siteUrl}/benchmarks/provider-environments/retrodiffusion/background/a/volcanic-pass.png`,
        `${siteUrl}/benchmarks/provider-environments/comfyui/isolated/a/mountain-observatory.png`,
        `${siteUrl}/benchmarks/provider-environments/comfyui/isolated/a/cliffside-fortress.png`,
        `${siteUrl}/benchmarks/provider-environments/comfyui/background/a/alpine-valley.png`,
        `${siteUrl}/benchmarks/provider-environments/comfyui/background/a/volcanic-pass.png`,
        `${siteUrl}/benchmarks/provider-postprocessing/comfyui/isolated/mountain-observatory.png`,
        `${siteUrl}/benchmarks/provider-postprocessing/comfyui/isolated/cliffside-fortress.png`,
        `${siteUrl}/benchmarks/provider-postprocessing/comfyui/background/alpine-valley.png`,
        `${siteUrl}/benchmarks/provider-postprocessing/comfyui/background/volcanic-pass.png`,
        `${siteUrl}/benchmarks/provider-hires/comfyui/baseline-64/alpine-valley.png`,
        `${siteUrl}/benchmarks/provider-hires/comfyui/native-wide-64/alpine-valley-wide.png`,
        `${siteUrl}/benchmarks/provider-hires/comfyui/native-grid/cliffside-fortress-128x128.png`,
        `${siteUrl}/benchmarks/provider-hires/comfyui/native-grid/alpine-valley-128x128.png`,
        `${siteUrl}/benchmarks/provider-hires/comfyui/native-grid/alpine-valley-wide-168x96.png`,
        `${siteUrl}/benchmarks/provider-hires/comfyui/refined/cliffside-fortress-128x128.png`,
        `${siteUrl}/benchmarks/provider-hires/comfyui/refined/alpine-valley-128x128.png`,
        `${siteUrl}/benchmarks/provider-hires/comfyui/refined/alpine-valley-wide-168x96.png`,
        `${siteUrl}/benchmarks/provider-scenario-smoke/mountain-keep.png`,
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
