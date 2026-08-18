# Naming — resolved: `pixelkiln`

**The name is settled.** The project ships as `pixelkiln`. `package.json` is
no longer `private`.

## The original blocker was a factual error

The prior version of this file claimed `pixelkiln` "is an established npm
package (v3.5.1, the CSS spritesheet builder) and `pixelsmith` is its
engine," and blocked the name on that basis. Re-verified directly against
the npm registry (2026-08-18):

```
GET https://registry.npmjs.org/pixelkiln    → 404 "Not found"
GET https://registry.npmjs.org/spritesmith  → 200, latest 3.5.1, "Utility that
                                                takes images and creates a
                                                spritesheet with JSON sprite data"
GET https://registry.npmjs.org/pixelsmith   → 200, latest 2.6.0, "Node based
                                                engine for spritesmith"
```

`pixelkiln` was never published. The "v3.5.1 CSS spritesheet builder" is
**`spritesmith`**, a real and long-established package — `pixelsmith` really
is its engine, exactly as claimed, but neither of them is `pixelkiln`. The
original research conflated the two real packages into a collision that
didn't exist. (`pixelsmith` also appears, separately and correctly, in the
rejected-candidates list below — a real name in a different, adjacent
project — which should have been the tell.)

A GitHub search for `pixelkiln` returns nothing but this repository, and a
general web search turns up no product, tool, or project by that name
anywhere. Nothing else needs to change: `bin/pixelkiln.js`, `package.json`'s
`name`/`bin`, the README, `scripts/gen-schema.ts`'s schema title, and
heybud-admin's `package.json` badge scripts already all say `pixelkiln` —
there is no rename to do, only the `private: true` flag to drop, which is
done.

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

Worth knowing, because the name should point at it:

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

## Shortlist (historical — kept for context, decision is above)

All verified free on npm, zero GitHub repos by that name, no web presence
(checked 2026-07-29 for the alternates; `pixelkiln` itself re-verified
2026-08-18 per the resolution above).

| Candidate | Note |
|---|---|
| **pixelkiln** ✅ **chosen** | Firing/baking metaphor fits pixel art, avoids the crowded `sprite-*` space. The npm collision this was shelved for turned out not to exist — see Resolution. |
| pixelquarry | Extraction metaphor — you quarry many candidates and keep the good ones. Still free, not needed. |
| pixelcrate | Packaging/inventory feel; leans toward the lockfile idea. Still free, not needed. |
| dithermill | Most pixel-art-native word available; "mill" carries batch production. Still free, not needed. |
| spriteledger | Points hardest at provenance, but inherits the crowded `sprite-` prefix. Still free, not needed. |

Rejected after checking: `pixelwright` (three live businesses use it — an AI app
builder, an iOS audit firm, a UI developer's brand), `spritefoundry` (taken by a
real project), `pixelsmith` (real package, `spritesmith`'s engine — see
Resolution), `spritemill`, `pixelloom`, `bitforge`, `spritelab`.
