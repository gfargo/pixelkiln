# Controlled asset revisions

PixelKiln can declare a new asset as a controlled revision of another asset.
The parent may be committed art, a downloaded generation, or an approved
quality output. PixelKiln hashes the exact parent and mask bytes, blocks stale
dependencies before submission, and records the lineage in the lockfile.

The manifest and pipeline are provider-neutral. ComfyUI and PixelLab implement
it; PixelLab covers `image-to-image`, `inpaint`, `reduce-colors`,
`correct-pixelart`, `animate`, and `animate-pixminimax`, not `outpaint` (its
API has no canvas-expansion endpoint). ComfyUI covers every mode generically
except `animate`/`animate-pixminimax`, which need an ordered frame set its
revision path cannot produce. Retro Diffusion and Scenario reject revision
work during offline resolution instead of silently starting a fresh
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

**From the gallery** (`pixelkiln gallery --edit`): open a completed or
committed asset's drawer and use "+ New revision" under "Revisions from this
asset" to create an `image-to-image` child of it — an edit instruction, an
optional strength, and a new asset id are all it asks for. The button only
appears once the parent has usable pixels (committed `source`, a current
downloaded generation, or a current approved quality output); the plan still
reports `blocked` with the real reason if that turns out wrong once the asset
exists. `inpaint` needs a mask upload the gallery does not offer yet, so it
still has to be added by hand.

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

## Cleanup: reduce-colors and correct-pixelart

Two more revision modes exist for cleaning up an existing asset's own pixels
mechanically, rather than describing an edit: no prompt is sent to the
provider for either (the asset's `prompt` stays a manifest-only label,
searchable in the gallery like any other asset's).

`reduce-colors` quantizes the source onto a smaller palette, either an
explicit count or lifted from a reference image:

```jsonc
{
  "revision": {
    "mode": "reduce-colors",
    "from": "hero-walk-east",
    "numColors": 16,
    "dithering": "4x4",
    "ditheringStrength": 6
  }
}
```

`numColors` (2–256) and `paletteImage` (a manifest-relative image whose colors
become the palette, lifted the same way a mask is) are mutually exclusive;
omit both to let PixelLab auto-detect a palette size. Unlike a mask,
`paletteImage` has no size relationship to the source — it only lends colors —
so it can be any shape. `dithering` (`none`, `2x2`, `4x4`, `8x8`) and
`ditheringStrength` (0–10) apply only to `reduce-colors`; setting them, or
`strength`, on the wrong mode is rejected at manifest load, same as a mask on
`image-to-image`.

`correct-pixelart` sharpens edges and drops stray/anti-aliased pixels without
resizing — the reprocessing case
[`image-to-pixelart`'s own docs](./ENDPOINTS.md) explicitly exclude ("for
photographs and 3-D renders, not for reprocessing" pixel art):

```jsonc
{
  "revision": {
    "mode": "correct-pixelart",
    "from": "hero-walk-east",
    "strength": 0.1
  }
}
```

`strength` (0–1, PixelLab's own default 0.1) is how far the model may move
from the source; start low and only raise it for real repair.

Neither mode supports the source being a frame set (a character animation, an
`objectPro` loop) yet — each processes exactly one image per revision, the
same as `image-to-image`. PixelLab's own `/reduce-colors` and
`/correct-pixelart` endpoints are built to take several frames in one call
specifically so an animation's frames (or a character's eight directions)
share one consistent palette/cleanup pass instead of drifting frame by frame;
pixelkiln does not expose that yet — revise each frame as its own asset for
now, and expect some frame-to-frame drift from doing so independently.

## Animation and interpolation

Two more modes animate any existing asset from a text description — a prop, a
scene, a portrait, not just a `character`/`objectPro` family member. Neither
needs a PixelLab character or object resource; both read the source's own
pixels the same way `image-to-image` does:

```jsonc
{
  "assets": {
    "chest-open-wobble": {
      "prompt": "the open chest wobbling gently",
      "revision": {
        "mode": "animate",
        "from": "chest-open",
        "frames": 8,
        "fps": 8
      }
    }
  }
}
```

`animate` calls `/animate-with-text-v3` (4–16 frames, even). `animate-pixminimax`
calls `/animate-pixminimax` — PixelLab's MiniMax-powered engine, beta and
gated to a tier 1 subscription or higher — for 4 to 40 frames and two extra
knobs: `direction` (the sprite's facing, used only alongside `enhancePrompt`
to aim motion the right way on screen) and the same `enhancePrompt`. Both
reject a declared `strength` (there is no denoise knob here, same as
`image-to-image`) and both send the asset's own `prompt` as the motion
description — `action` for `animate`, `description` for `animate-pixminimax`.

`lastFrame` pins where the motion ends — a manifest-relative image the same
size as the source — turning an open-ended animation into an interpolation
between two known poses, PixelLab's own "Animate Between 2 Frames" tool.
Unlike a mask, no size relationship to the source is required at the manifest
layer; PixelLab's own API is where a mismatch is caught.

`direction` + `enhancePrompt` together have a real gotcha, demonstrated by
PixelLab's own tutorial rather than inferred from the schema: `enhancePrompt`
can expand the motion description with camera-relative language ("towards
the camera") that fights the requested world-facing `direction`. The failure
is direction-specific — cardinal directions generated fine in the same batch
an off-cardinal one (north-east) did not — so a multi-directional
`animate-pixminimax` set that breaks at one or two directions but not others
is more likely the enhanced prompt's own wording than the model or the
`direction` value itself. The same tutorial states PixMiniMax "allows up to
40 frames," a second, independent (though still not live-billed)
confirmation of the 40-frame ceiling below.

The result is an **ordered frame set**, not a single image — the source's own
`frames` PNGs, `<asset>-frame-00.png` onward, exactly the naming a `character`
loop already uses. Like any generative animation, it lands in **candidate
review** first (`pixelkiln pick`), not straight to downloadable output; there
is no per-candidate choice to make (it is one ordered set, previewed as a
loop), just accept or reject the whole thing.

**Neither endpoint's completed-job response shape has been exercised against
a live account.** The request fields above come from PixelLab's live OpenAPI
document; the shape of a *finished* job (which key holds the frame list, and
whether it's hosted URLs or inline base64) is an informed guess checked
against several plausible shapes (see `pollAnimateRevision` in
`src/providers/pixellab.ts`), the same defensive posture `pollRevision`
already takes for `image-to-image`/`inpaint`. Cost is likewise unmeasured:
`estimate()` borrows `character`'s own measured v3-loop formula
(`ceil(width × height × frames / 65536)`, since the request shapes are
near-identical) as a placeholder, plus `enhancePrompt`'s own documented
+0.05-generation surcharge, which is a real schema number rather than a guess.

ComfyUI does not support either mode: its revision path always writes a
single output image, and an animation is a frame set — a structural gap
rather than a missing binding, so `supportsRevision` refuses it up front
rather than failing partway through submission.

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
way as every other PixelLab submission. `reduce-colors` calls `/reduce-colors`
and `correct-pixelart` calls `/correct-pixelart` — PixelLab's "Cleanup" tier —
and neither is a background job at all: both endpoints answer synchronously,
the whole result already in the POST response, the same as `pixflux`'s own
`/create-image-pixflux`. `submitRevision` caches the decoded PNG to a local
file under a fresh id immediately, exactly like `pixflux` does, and `poll`
just confirms the file is still there rather than asking PixelLab anything
further — there is nothing to ask.

- **Cost is confirmed live: a flat 0.1 generations for both, on a 32×32
  source, on a Tier 2 subscription account.** The live OpenAPI schema's own
  response examples are dollar-denominated (`usage: {type: "usd", usd:
  0.005}` for `reduce-colors`, `0.01` for `correct-pixelart`), and — exactly
  as this codebase has repeatedly found for other endpoints (`isometricTile`,
  `objectPro`) — that example does not predict real subscription billing.
  The account's balance moved by exactly 0.1 generations for each call
  (`pixellab balance change: 0.1000000000003638 generations consumed`,
  floating-point noise aside), matching PixelLab's own MCP tool descriptions
  rather than the OpenAPI example. Only confirmed at this one size so far;
  whether it stays flat at larger canvases (unlike `inpaint`'s canvas-tiered
  cost) is not yet known. The live response's own `usage` field is read and
  recorded as `billed` on every call regardless
  (`context.metadata.revisionUsage`, since there is no later background job
  to ask the way `billedForJob` asks for every other adapter call).
- `reduce-colors`'s total size limit is 512×512 worth of pixels (262144px²);
  `correct-pixelart`'s is 1024 pixels per side. Both are checked before a
  request is sent, the same as `inpaint`'s 32–512px floor/ceiling.
- `animate` calls `/animate-with-text-v3`, `animate-pixminimax` calls
  `/animate-pixminimax` — both real async background jobs, unlike the two
  Cleanup-tier modes above, since they generate new frames rather than
  transform the source. Both take at most 256 pixels per side; `animate`
  additionally caps at 16 frames (`animate-pixminimax` allows up to 40). See
  [Animation and interpolation](#animation-and-interpolation) above for the
  full field list, the frame-set output shape, and its own (still unmeasured)
  cost caveat — unlike the Cleanup tier above, neither `animate` nor
  `animate-pixminimax` has been exercised against a live account yet, and the
  request/response shapes come from PixelLab's live OpenAPI document, not an
  observed call. Treat the exact field names as provisional until a real
  call confirms them.

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
- **`inpaint-v3` genuinely has a 20/25/40 three-tier structure, but not at
  the `1dir`/`create-tiles-pro` breakpoints (1024px², 2048px²) this adapter
  borrows.** Nine live `inpaint` calls, bisecting toward the real
  breakpoints: 32×32 (1024px²) through 256×256 (65536px²) — 1024px²,
  1600px², 16384px², 65536px² — all billed **20**; 288×288 (82944px²) and
  320×320 (102400px²) both billed **25**; 352×352 (123904px²), 384×384
  (147456px²), and 512×512 (262144px², the ceiling) all billed **40**. Both
  breakpoints are now tightly bracketed: 20→25 sits somewhere in
  (65536px², 82944px²] — a 1.27x range — and 25→40 somewhere in
  (102400px², 123904px²] — a 1.21x range. `generationCost`'s existing
  1024px²/2048px² breakpoints are demonstrably wrong throughout this range:
  they charge 25 far too early (anything in (2048px², 65536px²] is really
  still 20) and reach 40 far too early too (anything in
  (2048px², 102400px²] that is not yet confirmed 25 is really 20, not 40).
  The `25` tier is real, not a fiction — just positioned far higher than
  assumed. Every size at or above 2048px² falls into `generationCost`'s
  `else` branch and returns 40 regardless: correct for 352×352, 384×384,
  and 512×512, but a full-tier overestimate for 288×288 and 320×320, whose
  confirmed real cost is 25, not 40. Every miss measured so far is still in
  the safe direction (never bills more than predicted). `image-to-image`
  is separately confirmed only at its own 32×32 floor (20 generations);
  its curve above that, including whether it shares any of `inpaint`'s
  breakpoints, is unmeasured.
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
hash, strength, and — for `reduce-colors` — `numColors`, the palette image's
hash, and the dithering settings, or — for `animate`/`animate-pixminimax` —
`frames`, `fps`, the last frame's hash, `direction`, and `enhancePrompt`.
ComfyUI provider metadata also retains the same lineage beside the workflow
hash.

Changing the prompt, workflow, mode, strength, parent bytes, mask bytes, color
count, palette image bytes, dithering settings, frame count, last frame
bytes, direction, or enhancePrompt makes the child stale. Moving an unchanged
parent, mask, palette image, or last frame file does not. When a child
has a quality profile, the new raw output hash also invalidates its old quality
record, so a revised image cannot inherit approval from an earlier generation.

Commit the parent art or parent lock entry, masks, child output, child lock
entry, and any quality companion. Do not commit ComfyUI input-cache files; they
can be recreated from the hashed project inputs.
