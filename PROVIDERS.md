# Multi-provider status and notes

PixelKiln now selects providers through a registry. The manifest's top-level
`provider` id chooses the adapter for planning and execution, while
`providerOptions` keeps adapter-specific settings in a namespaced style field.
PixelLab remains the default, so existing manifests and spec hashes stay
compatible.

## Support level

| Provider | Status | Current scope | Credential | Cost unit |
|---|---|---|---|---|
| PixelLab | Production, live-tested | `map`, `1dir`, `pixflux`, and `tiles` | `PIXELLAB_API_KEY` | generations |
| Retro Diffusion | Experimental, mock-tested | Stills, candidate batches, tileset sheets, GIF animations, and PNG spritesheets | `RD_API_KEY` | USD |
| FakeProvider | Test-only | Deterministic in-memory lifecycle | none | free |

The Retro Diffusion adapter is implemented, but it must pass an authenticated
smoke test before being described as production-ready. Outputs carry explicit
PNG/GIF media types through polling, lockfiles, destination naming, validation,
and the content-addressed recovery cache.

## Provider-owned behavior

The provider boundary owns the assumptions that differ between services:

- supported generators and provider-specific validation;
- offline cost estimates, arbitrary non-empty cost units, and candidate count;
- submit/poll response schemas and candidate selection when applicable;
- downloads and optional account capabilities such as balance, listing,
  tagging, and deletion.

Planning groups costs by unit instead of adding incompatible values. A budget
is interpreted in the active provider's unit. Providers without a balance
endpoint can still generate safely because the offline estimate and hard budget
remain enforced.

## Retro Diffusion adapter

[Retro Diffusion](https://retrodiffusion.ai/) is the first additional adapter
because it exposes a documented API and is purpose-built for pixel art. The
experimental implementation currently supports:

- async still, tileset, and animation submission and polling;
- one to sixteen candidates with PixelKiln's local human-review flow;
- dimensions from 12 to 512 pixels;
- up to nine reference images;
- seed, transparent-background behavior, and palette swatches;
- hosted output URLs with inline base64 fallback;
- validated animated GIF output or PNG spritesheets;
- offline USD estimates, a free authoritative cost preflight before every paid
  request, and balance reporting.

Configure it in the manifest rather than with a CLI-only switch:

```jsonc
{
  "provider": "retrodiffusion",
  "styles": {
    "base": {
      "generator": "map",
      "outDir": "assets/generated/base",
      "providerOptions": {
        "retrodiffusion": {
          "promptStyle": "rd_plus__default",
          "numImages": 4,
          "removeBg": true
        }
      }
    }
  }
}
```

Use a selector that matches the manifest generator: ordinary styles for
`map`/`pixflux`, `rd_tile__*` for `tiles`, and `rd_animation__*` or
`rd_advanced_animation__*` for `animation`. Reference images require an RD Pro
or user still style; advanced animations require one input image.

## Recommended expansion order

1. Run authenticated Retro Diffusion `doctor`, balance, still, tileset, GIF,
   spritesheet, and multi-candidate smoke tests without logging credentials.
2. Add Scenario as the next hosted game-asset provider, reusing the registry,
   USD accounting, and optional capability model.
3. Add a local ComfyUI adapter for users who prefer GPU-backed, no-per-call-cost
   generation.
4. Consider general raster providers only with an explicit pixel-art
   post-processing pipeline (nearest-neighbor scaling, palette quantization,
   transparency, and reproducibility checks).

Midjourney is not an adapter target without an official public API. Automating
its consumer UI would be fragile and could violate provider terms.

## Test coverage

`FakeProvider` covers the paid lifecycle without network access. The Retro
Diffusion suite mocks HTTP responses for USD estimates, async submit/poll,
candidate review and selection, GIF and PNG structural outputs, recovery
caching, and balance parsing. PixelLab remains the only adapter exercised
against a live account today.
