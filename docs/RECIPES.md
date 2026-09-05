# Versioned recipes

A PixelKiln recipe pins a reusable provider setup without hiding its quality
limits. Each pack carries a semantic version, a ready-to-use style template,
workflow hashes, model hashes, license names, and the checks required before an
image is treated as finished art.

Recipes are local files. Listing, inspecting, installing, and verifying them
does not contact a provider or download a model.

## Start with the bundled ComfyUI recipe

List what ships with the installed PixelKiln version:

```bash
pixelkiln recipe list
pixelkiln recipe inspect comfyui/pixel-art-xl-environment
```

Install the latest bundled version into the current project:

```bash
pixelkiln recipe install comfyui/pixel-art-xl-environment
```

The default destination includes the exact recipe version:

```text
pixelkiln-recipes/comfyui/pixel-art-xl-environment/1.0.0/
```

The command prints a complete provider-qualified manifest style entry whose `workflowFile` points
to that directory. Add the entry under `styles`, set the manifest's provider to
`comfyui`, and add the assets you want to render. Use `--out <directory>` when
the project keeps workflows elsewhere.

The first recipe is the tested SDXL Base 1.0 plus Pixel Art XL environment
graph. It produces four candidates on a 1024×1024 working canvas and scales the
selected composition to the requested output size. Its declared stage is
`composition-source`, not production-ready art. Reject weak compositions, then
recover the native grid, apply the final palette, and complete the 1× human
review described in the [ComfyUI guide](COMFYUI.md#quality-first-workflow).

## Verify the recipe and workstation

Verify the metadata digest and every included workflow before using a pack:

```bash
pixelkiln recipe verify \
  pixelkiln-recipes/comfyui/pixel-art-xl-environment/1.0.0
```

That command proves the installed pack is intact. It reports external models as
`unchecked` because model locations belong to the workstation, not the project.
Pass the ComfyUI directory that contains `checkpoints/`, `loras/`, and the other
model folders to check the actual model bytes:

```bash
pixelkiln recipe verify \
  pixelkiln-recipes/comfyui/pixel-art-xl-environment/1.0.0 \
  --model-root /path/to/ComfyUI/models
```

Model hashing is streamed, so a large checkpoint is not loaded into memory.
Missing or mismatched workflow/model files make verification exit nonzero.
Omitting `--model-root` does not: the output states that the workstation models
were not checked.

Use `--json` for automation. It reports the resolved selector, metadata digest,
each file status, each model status, and the model root used. Recipe verification
is an appropriate CI gate for committed recipe files. Model verification usually
belongs in workstation setup or a self-hosted runner that owns those files.

## Version and update policy

Use an exact selector when reproducibility matters:

```bash
pixelkiln recipe install comfyui/pixel-art-xl-environment@1.0.0
```

An unversioned selector resolves to the newest bundled version. Installation
still writes the chosen version into the destination path, so installing a
newer recipe does not rewrite a project's existing workflow. Review the new
style template and quality contract, run the benchmark prompts, then update the
manifest deliberately.

Installation refuses to replace changed destination files. `--force` replaces
only files declared by the recipe; it does not delete extra files. Inspect the
local changes before using it.

## Recipe file contract

`pixelkiln.recipe.json` uses `schemaVersion: 1` and the published
[`recipe.schema.json`](../schema/recipe.schema.json). Its main fields are:

| Field | Meaning |
|---|---|
| `id`, `version`, `provider` | Stable recipe identity and provider. |
| `files` | Included workflow/reference paths and their SHA-256 digests. |
| `models` | Required model paths relative to `--model-root`, hashes, source links, and license names. Model files are never bundled. |
| `styleId`, `style` | Manifest style template. `{{recipeDir}}` is replaced with the installed path. |
| `workflow` | Output node, candidate count, and the inputs PixelKiln may bind. |
| `quality` | Working canvas, recommended native range, palette range, output stage, and required review checks. |
| `integrity` | Canonical SHA-256 digest of the recipe metadata. |

Included paths must be portable relative paths. Absolute paths, backslashes,
empty segments, `.` and `..` are rejected. The recipe file cannot include its
own hash; its metadata digest covers that document instead.

Recipes do not install models, custom nodes, credentials, or Python packages.
Follow each linked source and license, place dependencies yourself, verify them,
then run `pixelkiln doctor --dry-run` before connecting to ComfyUI.
