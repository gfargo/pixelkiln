# Multi-provider — design notes

Today `pixelkiln` talks only to PixelLab, through `src/client.ts`. Supporting a
second backend is the next structural change. This file records what that costs
and which provider to reach for first.

## Midjourney is the wrong first target

Verified 2026-07-29: **Midjourney has no public developer API.** API keys are
restricted to the Enterprise dashboard and require applying for access. Every
third-party "Midjourney API" works by automating the Discord or web interface,
which violates Midjourney's terms of service and risks the underlying account
being banned.

Building that adapter would mean shipping something fragile, unsupported, and
capable of getting a user's account terminated. Not worth it.

## The right first target: Retro Diffusion

[Retro Diffusion](https://retrodiffusion.ai/) is PixelLab's closest competitor
and the natural second provider:

- A real, documented developer API, with
  [published examples](https://github.com/Retro-Diffusion/api-examples).
- Purpose-built for pixel art — grid-aligned output, no blur or anti-aliasing —
  so it shares this tool's domain model rather than needing a downscale and
  quantize pass bolted on.
- Supports seamless tiles, sprite-sheet animation, and free cost estimates,
  which map onto `plan` almost directly.

Other candidates, in rough order of fit:

| Provider | API | Pixel-native | Notes |
|---|---|---|---|
| Retro Diffusion | yes | yes | Recommended first adapter |
| [Scenario](https://www.scenario.com/) | yes | partly | Game-asset focused, hosts Retro Diffusion models |
| OpenAI `gpt-image-1` | yes | no | Raster; needs downscale + palette quantization |
| Google Gemini image | yes | no | Same caveat |
| Local ComfyUI + pixel LoRA | n/a | yes | No per-call cost, but a GPU dependency |
| Midjourney | **no** | no | See above |

## What has to change

The current design assumes PixelLab's economics in two places, and both need to
become provider-owned rather than global:

1. **Cost is not universally "generations".** `Plan.cost` is a bare number that
   means PixelLab subscription generations. It needs a unit — USD for OpenAI,
   generations for PixelLab, zero for local — so `plan` can keep printing an
   honest number and `--budget` can keep meaning something.

2. **Free candidates are a PixelLab quirk.** The core loop here — generate
   small, get 16 candidates for one fixed price, pick the best — exists because
   PixelLab charges per call and scales candidates inversely with canvas size.
   OpenAI charges per image, so "16 candidates" costs 16×. The picker still
   works, but the strategy advice in the README does not generalise, and
   `candidateCount()` has to move behind the provider interface.

Sketch:

```ts
interface Provider {
  id: string
  supports(generator: Generator): boolean
  estimate(spec: ResolvedSpec): { unit: "generations" | "usd" | "free"; amount: number; candidates: number }
  submit(spec: ResolvedSpec): Promise<{ jobId: string }>
  poll(jobId: string): Promise<{ status: JobStatus; candidateUrls?: string[]; resultUrl?: string }>
  select(jobId: string, index: number): Promise<{ objectId: string; url: string }>
  balance(): Promise<{ unit: string; remaining: number }>
}
```

The lockfile already has room for this — it records `generator` and `cost` per
entry, so adding a `provider` field is additive and old lockfiles stay readable.

## This also unblocks the integration tests

A `FakeProvider` implementing the interface above is a far better test double
than an HTTP mock: it exercises the real `submit → poll → pick → fetch` state
machine, including the review/candidate path and the 8-hour map-object
expiry, without a network or an API key. Doing the provider seam first and the
integration tests second is the cheaper order.
