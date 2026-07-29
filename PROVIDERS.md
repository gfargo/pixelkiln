# Multi-provider — status and notes

**The seam is built.** `src/provider.ts` defines the interface;
`src/providers/pixellab.ts` is the reference implementation and
`src/providers/fake.ts` is the in-memory test double. Nothing above the
interface knows about PixelLab.

Both concerns this file previously flagged as blockers are resolved:

- **Cost is no longer assumed to be "generations."** `CostEstimate` carries a
  `unit` of `generations | usd | free`, `plan` prints it, and `--budget` is
  interpreted in it.
- **Free multi-candidate returns are no longer assumed universal.**
  `estimate().candidates` is a provider property; `candidateCount()` moved
  behind the interface.

What remains is writing a second adapter. This file records which one and why.

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

## Resolved: the two economic assumptions

Both were global assumptions baked into `plan`; both are now provider-owned.
Kept here as the rationale, since a second adapter has to honour them.

1. **Cost is not universally "generations".** `Plan.cost` used to be a bare
   number meaning PixelLab subscription generations. It now carries a unit —
   USD for OpenAI, generations for PixelLab, free for local — so `plan` prints
   an honest figure and `--budget` means something in every backend.

2. **Free candidates were a PixelLab quirk.** The core loop — generate small,
   get 16 candidates for one fixed price, pick the best — works because
   PixelLab charges per *call* and scales candidates inversely with canvas
   size. OpenAI charges per *image*, so 16 candidates costs 16×. The picker
   still works either way, but the strategy advice in the README does not
   generalise, which is why `candidateCount()` moved behind the interface.

See `src/provider.ts` for the shipped interface. Lock entries carry a
`provider` field, defaulted to `pixellab` so pre-provider lockfiles stay
readable.

## Done: the integration tests it unblocked

`FakeProvider` turned out to be exactly the better test double predicted here.
17 integration tests now cover `submit → poll → fetch`, `pushTags` and `adopt`
— the stages that spend money and previously had zero coverage, where four of
the five real bugs in this project lived. Verified non-vacuous by mutation:
breaking the output hashes, the budget check, or the v1 lock migration each
fails tests.

Still uncovered: the two contact-sheet HTTP servers (`pick`, `salvage`). Their
HTML generation is unit-tested; the request handling is not.
