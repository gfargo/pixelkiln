# Naming — unresolved

`pixelkiln` is a **working title only**. It cannot ship under that name:
[`pixelkiln`](https://www.npmjs.com/package/pixelkiln) is an established npm
package (v3.5.1, the CSS spritesheet builder) and `pixelsmith` is its engine.
`package.json` is marked `private: true` until this is settled.

## What the space already looks like

The "manifest-driven AI asset generation CLI" idea is not novel. Prior art found:

| Project | Overlap | Backend |
|---|---|---|
| [pickbitsai/sprite-generator](https://github.com/pickbitsai/sprite-generator) | Closest. JSON manifest, `assets[]` with id/category/description, `defaultStyle`, `--dry-run`, `--category`, `--concurrency` | OpenAI `gpt-image-1` |
| [mcp-tool-shop-org/sprite-foundry](https://github.com/mcp-tool-shop-org/sprite-foundry) | SQLite lifecycle tracking, review/accept/reject, provenance, deterministic export with manifest + checksums | ComfyUI (local GPU) |
| [lx-0/restyle-sprites](https://github.com/lx-0/restyle-sprites) | Restyle a whole pack from source + style reference | Gemini / OpenAI |
| [trebeljahr/sprite-tools](https://github.com/trebeljahr/sprite-tools) | Post-processing toolkit — atlas, collision, palette | n/a |
| [dt-pirate/openrender](https://github.com/dt-pirate/openrender) | Installs generated assets into engines, manifests, rollback | n/a |
| [freema/pixelforge-mcp](https://github.com/freema/pixelforge-mcp) | MCP server for pixel art | Gemini |
| [ralphy](https://ralphy.mintlify.app/advanced/asset-manifest) | `asset-manifest.json` slot pointers + `generations.jsonl` audit log | multi |

**Implication for naming:** the `sprite-*` namespace is crowded — `sprite-generator`,
`sprite-foundry`, `sprite-tools`, `restyle-sprites` all exist. Avoid it.

## What is actually differentiated here

Worth knowing before picking a name, because the name should point at it:

1. **PixelLab-native.** Everything above wraps a general image model and
   downscales. PixelLab generates on a real pixel grid. Nothing found targets it.
2. **Exploits the candidate economics.** Cost is fixed per call while candidates
   returned scale inversely with canvas size. Nothing found treats "generate
   small, pick from 16" as the core loop.
3. **`adopt`.** Retroactively reconciling an existing account and repo by image
   hash. Not found anywhere.
4. **A true lockfile.** `sprite-foundry` uses SQLite, `ralphy` uses a pointer
   table plus a log. A committed, sorted, hash-on-both-sides lockfile in the npm
   sense was not found.

## Shortlist

All verified free on npm, zero GitHub repos by that name, no web presence
(checked 2026-07-29).

| Candidate | Note |
|---|---|
| **pixelkiln** | Recommended. Firing/baking metaphor fits pixel art, avoids the crowded `sprite-*` space, no collisions anywhere. |
| pixelquarry | Extraction metaphor — you quarry many candidates and keep the good ones. |
| pixelcrate | Packaging/inventory feel; leans toward the lockfile idea. |
| dithermill | Most pixel-art-native word available; "mill" carries batch production. |
| spriteledger | Points hardest at provenance, but inherits the crowded `sprite-` prefix. |

Rejected after checking: `pixelwright` (three live businesses use it — an AI app
builder, an iOS audit firm, a UI developer's brand), `spritefoundry` (taken by a
real project), `pixelsmith`, `spritemill`, `pixelloom`, `bitforge`, `spritelab`.

## To rename

The name appears in `package.json` (`name`, `bin`), `bin/pixelkiln.js`, the
README, `scripts/gen-schema.ts` (schema title), and heybud-admin's `package.json`
badge scripts. Then drop `private: true`.
