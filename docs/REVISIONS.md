# Controlled asset revisions

PixelKiln can declare a new asset as a controlled revision of another asset.
The parent may be committed art, a downloaded generation, or an approved
quality output. PixelKiln hashes the exact parent and mask bytes, blocks stale
dependencies before submission, and records the lineage in the lockfile.

The manifest and pipeline are provider-neutral. ComfyUI and PixelLab implement
it; PixelLab covers `image-to-image` and `inpaint`, not `outpaint` (its API
has no canvas-expansion endpoint). Retro Diffusion and Scenario reject
revision work during offline resolution instead of silently starting a fresh
text-to-image job.

## Image-to-image

Keep the parent as its own asset and point the child at its stable asset id:

```jsonc
{
  "assets": {
    "tower-rough": {
      "prompt": "rough stone watchtower",
      "source": "concepts/tower-rough.png"
    },
    "tower-snow": {
      "prompt": "preserve the tower silhouette; add snow, ice, and cold blue shadows",
      "width": 96,
      "height": 96,
      "revision": {
        "mode": "image-to-image",
        "from": "tower-rough",
        "strength": 0.3
      }
    }
  }
}
```

`from` names another asset in the same style. A source and its revision cannot
be the same asset, and revision chains cannot contain a cycle. `source` and
`revision` are mutually exclusive on one asset.

Revision edges do not cross styles or providers in this version. To use output
from another provider, commit or retain that PNG and declare it as a separate
`source` asset in the ComfyUI revision style. The child still records the exact
source hash, but the cross-provider handoff is a file boundary rather than one
automatic lock dependency.

Start with a low strength. Values around `0.2`–`0.4` give the workflow room to
change texture and lighting while retaining more of the source. Higher values
permit larger changes and make silhouette drift more likely. Strength is an
input to the provider workflow, not a cross-model quality guarantee.

## Inpainting

An inpaint revision also declares a manifest-relative mask:

```jsonc
{
  "revision": {
    "mode": "inpaint",
    "from": "tower-rough",
    "mask": "masks/tower-door.png",
    "strength": 0.45
  }
}
```

The mask must be a readable PNG. When the parent exists during planning, the
mask must have the same dimensions. The ComfyUI graph decides whether white or
black pixels mark edits, so test the graph in ComfyUI before running
it through PixelKiln. The mask bytes and parent bytes both participate in the
child spec hash.

`outpaint` is also part of the provider contract. It does not accept a separate
mask in the manifest; the workflow owns canvas expansion and masking. PixelKiln
does not ship a tested outpaint recipe yet.

## Dependency gate

`pixelkiln plan` reports a revision as `blocked` when its parent is not safe to
use. A blocked item is not actionable and contributes no generation cost.
PixelKiln requires one of these parent states:

- committed `source` bytes are present;
- generated output is downloaded, matches the current parent spec, and still
  has its recorded hash; or
- when the parent style declares `quality`, its refined PNG and named human
  approval are current.

The same check runs again immediately before submission. If the parent or mask
changes after planning, no provider request starts and no new lock entry is
written.

Generate or approve the parent first, then plan the child:

```bash
pixelkiln plan --only tower-snow
pixelkiln gen --only tower-rough --budget comfyui=0
pixelkiln refine --only tower-rough
pixelkiln refine approve \
  --from art/final/tower-rough.pixelkiln.json \
  --reviewer "Your Name"
pixelkiln plan --only tower-snow
pixelkiln gen --only tower-snow --budget comfyui=0
```

Skip the generation/refinement steps that do not apply to a committed source.
Selecting only the child still resolves its transitive parents for hashing and
readiness; it does not submit those parents implicitly.

## ComfyUI bindings

A revision workflow uses the normal prompt/output bindings plus these optional
bindings:

```jsonc
{
  "bindings": {
    "prompt": { "nodeId": "6", "input": "text" },
    "width": { "nodeId": "11", "input": "width" },
    "height": { "nodeId": "11", "input": "height" },
    "batchSize": { "nodeId": "15", "input": "amount" },
    "seed": { "nodeId": "3", "input": "seed" },
    "sourceImage": { "nodeId": "12", "input": "image" },
    "maskImage": { "nodeId": "13", "input": "image" },
    "strength": { "nodeId": "3", "input": "denoise" }
  }
}
```

`sourceImage` is required for every ComfyUI revision. `maskImage` is required
for inpainting. `strength` is required when the asset declares strength. Width
and height must be supplied together. If they are omitted, the requested output
must keep the source dimensions.

At submission, PixelKiln verifies each hash, uploads deterministic
`pixelkiln/<sha256>.png` or `.jpg` inputs to ComfyUI, binds a cloned workflow,
then queues it. It never changes the committed workflow file. A review with
multiple candidates shows the source beside the candidates, so preserving the
silhouette can be judged directly.

Install the first bundled revision workflow with:

```bash
pixelkiln recipe install comfyui/pixel-art-xl-img2img@1.0.0
```

It uses SDXL Base 1.0 and Pixel Art XL on a square 1024×1024 working canvas,
then writes the requested final dimensions with nearest-exact scaling. Use it
only for square sources. Its workflow integrity and bindings are tested, and a
live Apple MPS smoke completed at strengths `0.25`, `0.4`, and `0.6`. All three
preserved the broad fortress footprint but missed the requested snow treatment,
lost transparency, and expanded a 15-color source into 4,208–5,224 colors. That
is transport evidence, not a quality recommendation. Treat every result as a
composition candidate and use the normal native-grid, palette, alpha, and human
approval gate before shipping. See the
[committed smoke](../benchmarks/provider-revisions/comfyui/README.md).

## PixelLab

PixelLab needs no bindings: `image-to-image` calls `/edit-images-v2`,
`inpaint` calls `/inpaint-v3`, both as a plain background job polled the same
way as every other PixelLab submission.

- The mask convention is fixed, not graph-defined like ComfyUI's: white marks
  the area to generate, black the area to preserve. There is no way to flip it.
- `strength` has nowhere to go on `image-to-image`. PixelLab's edit endpoint
  applies the instruction in full; declaring a strength fails the submission
  rather than silently ignoring it.
- The source image is sent at its own actual dimensions (`revision.sourceWidth`
  / `sourceHeight`), not the child asset's declared `width`/`height`. Neither
  endpoint resizes; they edit the pixels that exist.
- `/inpaint-v3` takes 32 to 512 pixels per side; a smaller or larger source
  is refused before any request is sent. There is no chunking built in for a
  source over that ceiling: PixelLab's own Aseprite-plugin tutorial hits the
  same wall on a full-canvas edit and works around it by selecting and
  submitting a sub-region instead of the whole image, one that still
  includes some existing content (not just blank space) so the model has
  context. A revision over 512px on a side needs the same treatment — a
  separate, smaller revision asset targeting a sub-region — until this
  adapter does that automatically.
- **The borrowed `1dir`/`create-tiles-pro` tiering (20/25/40 by canvas area,
  breakpoints at 1024px² and 2048px²) does not describe `inpaint-v3`'s real
  pricing, only bounds it from above.** Six live `inpaint` calls, bisecting
  toward the real breakpoint: 32×32 (1024px², the floor) billed 20; 40×40
  (1600px², inside the borrowed tiering's 25-generation band) billed **20,
  not 25**; 128×128 (16384px²) and 256×256 (65536px²) both billed **20
  again**; 384×384 (147456px²) billed **40**, the first point to cross to
  the top tier; 512×512 (262144px², the ceiling) also billed 40. The real
  breakpoint between the 20- and 40-generation tiers for `inpaint-v3` has
  been bisected to somewhere in (65536px², 147456px²] — a 2.25x range, down
  from an initial >250x range. The `25` tier as currently coded in
  `generationCost` is not wrong to output (it never underestimates a
  confirmed point), but it is confirmed *inexact* everywhere measured so
  far below the real breakpoint: at 1600px², 16384px², and 65536px²,
  pixelkiln's `plan`/`--budget` would reserve 25 generations against work
  that actually bills 20. Every size at or above 2048px² already falls into
  `generationCost`'s `else` branch and returns 40 regardless, which is why
  384×384 and 512×512 both estimate correctly today despite the imprecise
  middle tier. `image-to-image` is separately confirmed only at its own
  32×32 floor (also 20 generations); its curve above that, including
  whether it shares `inpaint`'s breakpoint, is unmeasured.
  PixelLab's own tutorial reports its Pro edit tool at roughly 40 generations
  for a typical (larger) edit, consistent with `image-to-image` reaching the
  same ceiling `inpaint` measurably does, without saying where.
- A completed job's response shape is confirmed live for both, and **the two
  do not match**: `inpaint-v3`'s `last_response.image` is a single object,
  `{type: "base64", width, height, base64}`; `edit-images-v2`'s is
  `last_response.images`, an *array* of that same object shape (`edit_images`
  in the request is also an array — the endpoint supports editing several
  images with one instruction, and the response shape mirrors that even
  though pixelkiln always sends and expects exactly one). `pollRevision`
  checks the singular `image` key first and only then falls back to an
  `images` array, so both were matched correctly without any code change on
  either live run. Both responses also carry `billing_usage` (duplicating
  the top-level `usage`, the same pattern already documented for map objects
  and character bases below), a `seed`, `generation_mode` (`"inpainting_v3"`
  vs. `"edit_images"`), and an automatically color-reduced copy of the result
  pixelkiln does not read (`quantized_image` singular for inpaint,
  `quantized_images` plural for edit — the same singular/plural split as the
  main result). `pollRevision` in
  `src/providers/pixellab.ts` reads all of this defensively and fails the job
  with a named error rather than crash or guess wrong, for whatever shape
  still isn't covered.

## Provenance and invalidation

The lock entry records revision mode, parent id, parent hash, optional mask
hash, and strength. ComfyUI provider metadata also retains the same lineage
beside the workflow hash.

Changing the prompt, workflow, mode, strength, parent bytes, or mask bytes makes
the child stale. Moving an unchanged parent or mask file does not. When a child
has a quality profile, the new raw output hash also invalidates its old quality
record, so a revised image cannot inherit approval from an earlier generation.

Commit the parent art or parent lock entry, masks, child output, child lock
entry, and any quality companion. Do not commit ComfyUI input-cache files; they
can be recreated from the hashed project inputs.
