# Controlled asset revisions

PixelKiln can declare a new asset as a controlled revision of another asset.
The parent may be committed art, a downloaded generation, or an approved
quality output. PixelKiln hashes the exact parent and mask bytes, blocks stale
dependencies before submission, and records the lineage in the lockfile.

The manifest and pipeline are provider-neutral. The current ComfyUI adapter is
the first implementation. PixelLab, Retro Diffusion, and Scenario reject
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
