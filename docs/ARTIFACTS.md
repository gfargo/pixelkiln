# Derived artifacts

PixelKiln turns validated source PNGs into application-ready bundles without a
provider call:

- `pack`: deterministic grid sheet plus frame atlas;
- `mount`: declared stable cells in a new or existing sheet;
- `export`: structural tile atlas plus generic, Tiled, or Godot metadata.

Every CLI bundle includes generated output, metadata, and a
`<base>.pixelkiln.json` provenance companion.

## Pack

```bash
pixelkiln pack --style neon
pixelkiln pack --style ground --output-role tile-00 --output-role tile-01
pixelkiln pack --style mixed --primary-only
```

Manifest mode reads exactly the outputs recorded by the lockfile. Frames sort
by asset id for byte-stable layouts. Structural sets preserve provider order
and qualify ids by role (`terrain/tile-03`). The grid cell is the largest source
sprite; smaller frames retain their real dimensions at the cell's top-left.

All standard non-interlaced PNG color modes and bit depths are decoded and
normalized to RGBA. Corrupt/interlaced inputs are reported as skipped. If no
input is readable, packing fails rather than emitting an empty sheet.

Explicit mode packs sources from any project and requires no manifest:

```bash
pixelkiln pack --inputs sprites.json --out dist/sheet
```

```json
[
  { "id": "effect_euphoric", "path": "art/effect_euphoric.png" },
  { "id": "aura_golden", "path": "../shared/aura_golden.png" }
]
```

Paths resolve from the inputs JSON directory. Duplicate ids fail before file
decoding because consumers must have one unambiguous frame per id.

## Mount

`pack` moves cells when the sorted input set changes. `mount` is for sheets
whose cell coordinates are already load-bearing in scene files, saved data, or
engine configuration.

Declare `style.mount` and per-asset `cell` values in the manifest. A base sheet
is optional and may equal the output. Only declared cells are cleared/replaced;
all other base pixels survive byte-for-byte. A sprite larger than its cell is
reported and skipped rather than cropped. Two assets cannot own one cell.

Use asset `source` when mounting a palette-remapped, aligned, hand-touched, or
otherwise post-processed file instead of the raw lock output. Use `outputRole`
to choose one member of a structural set. See [manifest reference](./MANIFEST.md).

## Export

```bash
pixelkiln export --style ground --only terrain --format generic
pixelkiln export --style ground --only terrain --format tiled
pixelkiln export --style ground --only terrain --format godot
```

Generic JSON retains all provider rules and normalized masks. Tiled and Godot
translate recognized four-edge/four-corner semantics and reject unknown or
lossy mappings. See [TILES.md](./TILES.md) for the format contracts.

## Provenance companion

The companion is engine-neutral and versioned:

```jsonc
{
  "format": "pixelkiln-artifact-bundle",
  "version": 1,
  "kind": "pack",
  "fingerprint": "…",
  "sources": [
    { "id": "anvil", "path": "../art/anvil.png", "sha256": "…", "included": true }
  ],
  "options": { "columns": 8, "order": "id", "style": "base" },
  "outputs": [
    { "path": "sheet.png", "sha256": "…" },
    { "path": "sheet.json", "sha256": "…" }
  ]
}
```

Source paths are relative to the companion. Options are recursively key-sorted
before hashing. The fingerprint covers sources, options, and output hashes.
Manifest-driven bundles conservatively include the project manifest and
lockfile, so newly declared or recorded sources make an older artifact stale.

Verify without rebuilding:

```ts
import { verifyArtifactBundle } from "pixelkiln"

const verification = await verifyArtifactBundle("dist/sheet.pixelkiln.json")
if (!verification.current) {
  console.error(verification.changedSources, verification.changedOutputs)
}
```

## Ownership and manual edits

PixelKiln never silently claims a differing existing destination:

- No companion + identical desired bytes: adopt it, preserve its mtime, and
  add provenance.
- No companion + differing bytes: refuse the entire bundle.
- Valid companion + matching recorded output: update normally.
- Valid companion + manually changed output: refuse the entire bundle.
- Invalid or altered companion: refuse takeover.

After reviewing the difference, `--force` explicitly replaces and takes
ownership of every changing member:

```bash
pixelkiln pack --style neon --force
```

Library consumers get the same policy from
`writeManagedArtifactBundle(..., { force: true })`.

## Transactional writes

Changed members are compared first, staged beside their destinations, and only
then promoted. Duplicate normalized destinations fail before mutation.
Byte-identical members are not rewritten. If an ordinary write/promotion error
occurs, newly promoted files are removed and previous backups are restored.
Any recovery failure retains the backup and reports its exact path.

## Abrupt termination recovery

Managed writes create an immutable `<companion>.transaction` journal before
staging. After every member is promoted, a separate durable commit marker is
created before cleanup.

On the next invocation:

- journal without marker: restore the prior complete bundle and remove stages;
- journal with marker: retain the fully committed new bundle and finish cleanup;
- live owning process: refuse concurrent recovery;
- destination or temp path outside the current bundle: refuse unsafe recovery
  and retain the journal for inspection.

The journal is short-lived and should not normally appear in Git status. A
hard-exit integration test covers both sides of the commit boundary.

## Library persistence

`packSprites`, `packStyle`, `mountSprites`, `mountStyle`, and `exportTileset`
return bytes, metadata, skipped-input details, and source hashes. Use
`writeManagedArtifactBundle` for the CLI's ownership, provenance, transaction,
and recovery policy. `writeArtifactBundle` is the lower-level staged/rollback
primitive for callers that supply their own ownership policy.
