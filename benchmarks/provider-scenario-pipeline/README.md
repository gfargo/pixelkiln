# Scenario pipeline: generate, pixelate, cut out, refine

How Scenario's models and tools chain inside a PixelKiln project, on
October 5, 2026: 41 CU in three phases, every quote matched its bill. Single
samples; this shows what works and what the manifest cannot express yet, not a
ranking.

## Phase 1: generate a character and sweep Pixelate (27 CU)

`knight`: "a knight in silver armour with a blue cape, full body, standing, front
view, isolated on a plain white background, pixel art", 512×512, seed 31415.

| Model | CU | Result |
|---|---:|---|
| `model_bfl-flux-2-klein-9b` | 1 | A solid, readable knight: armour, belt, cape, face slit. 22k colours. |
| `model_openai-gpt-image-2` | 11 | A richer knight with a gold-trimmed tabard, lion crest, and a shaded cape. 29k colours. |

Pixelate (5 CU each) on the bake-off's GPT Image 2 mountain keep, 24 colours,
then the free `pixelkiln refine` gate on each result:

| Requested `pixelGridSize` | Detected native grid | Confidence |
|---:|---:|---|
| 48 | 46×46 | high |
| 64 | 64×64 | high |
| 128 | 128×128 | high |

Every setting passed the gate, and the detected grid tracks the request, so
`pixelGridSize` is a reliable way to choose a sprite's native size.

## Phase 2: pixelate both knights to a shared palette (10 CU)

Pixelate at grid 64 with `colorPalette` set to DB32 (a 32-colour palette), the
same list used as `quality.palette`. Both results use only DB32 colours (19 and
21 of them, none outside the palette), and both pass the gate: 64×64, high
confidence.

**Passing the gate is not the same as good art.** DB32 has few blues, so the
bright blue cape turned dark navy, and a 64-pixel grid left noisy, speckled
shading on both knights. The GPT knight is still more detailed than the Klein
one. `removeNoise` was not tried.

## Phase 3: cut out the background (4 CU)

Birefnet on each pixelated knight. The subject kept its colours (19 and 21) at
alpha 254, as in the tool smoke. `pixelkiln refine` with `--min-transparency 0.5`
then produced 64×64 RGBA sprites with alpha exactly 0 or 255 (76% and 66%
transparent), so refinement is also what turns Birefnet's near-opaque matte into
a clean one.

| Path | CU | Final |
|---|---:|---|
| Klein knight, Pixelate, Birefnet, refine | 1 + 5 + 2 = **8** | 64×64 sprite, 19 colours, gate-passing |
| GPT Image 2 knight, Pixelate, Birefnet, refine | 11 + 5 + 2 = **18** | 64×64 sprite, 21 colours, gate-passing |

## What this showed about using Scenario in PixelKiln

1. **A revision cannot take a parent from another style.** `revision.from` is an
   asset in the same style, and a style has one Scenario model. A chain like
   generate then pixelate then cut out therefore needs the parent restated in
   each later style as a placed `source` pointing at the previous output file
   (`outputs/gen-klein/knight.png`). It works, but nothing orders the steps:
   each phase was a separate `gen --style` run, and the file had to exist
   before `plan` could see it.
2. **A `quality` profile gates every asset in its style, parents included.** Put
   on the Pixelate style, it made the raw parent (which cannot pass) block its
   own child. Keep generation and tools in styles without `quality`, and gate a
   separate style whose asset is the tool's output placed as a `source`.
3. **One palette can be declared twice.** Passing a palette to the model
   (`colorPalette`) and to `quality.palette` kept the output inside it, so
   refinement had nothing left to correct.
4. **Costs are small.** A gate-passing 64×64 sprite from a 1 CU generation was 8
   CU in total, against 20 or more generations for PixelLab's equivalent edits.
5. **Output size and format vary by model**, and the lockfile records the
   requested size, not the file's.

## Files

`pixelkiln.manifest.json` (all phases), `pixelkiln.lock.json`, `art/keep.png`,
`outputs/` (generations, the Pixelate sweep, `char-px`, `char-cut`), and
`refined/` (path-mode refine results, with their quality records).
