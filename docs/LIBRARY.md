# Library API

PixelKiln's public package entry point exposes the same provider-independent
primitives used by the CLI. Use these when a build tool, editor integration, or
game pipeline needs structured results instead of terminal output.

## Load, resolve, and plan

```ts
import {
  buildPlan,
  loadLock,
  loadManifest,
  resolveSpecs,
  summarize,
} from "pixelkiln"

const loaded = await loadManifest("pixelkiln.manifest.json")
const specs = await resolveSpecs(loaded)
const lock = await loadLock("pixelkiln.lock.json")
const plan = await buildPlan(specs, lock)

console.log(summarize(plan))
for (const group of plan.groups) {
  console.log(`${group.provider}: ${group.cost} ${group.costUnit}`)
}
```

Planning performs no provider calls and spends nothing. `resolveSpecs` uses each
style's provider or the manifest default, then lets that offline adapter's
`supports()` and `estimate()` methods determine cost unit and candidate count.
Passing `options.provider` deliberately overrides that routing for custom
orchestration and tests. A provider may also resolve local files before hashing.
The ComfyUI adapter uses that hook to parse and hash a workflow JSON file without
contacting the server. `Provider.resolveInputs` does the same for per-asset
provider values: it can keep an absolute file path in the runtime spec while
returning a content-only identity for hashing and provenance. A resolved spec
has the fully inherited style and asset settings plus its effective provider
and deterministic spec hash. Optional
quality settings resolve separately and do not affect provider identity or cost.
Revision settings resolve into `spec.revision`, including the nested parent
spec, absolute input paths for I/O, content hashes, measured dimensions, mode,
and optional strength. Paths are excluded from the hash; input bytes are not.

`plan.groups` is the authoritative cost view. Each group contains `provider`,
`costUnit`, `cost`, `candidates`, and its actionable items. For compatibility,
`plan.cost` and `plan.costUnit` retain the single-provider projection; both are
`null` when a plan spans providers or units.

For custom orchestration, inspect the dependency gate directly:

```ts
import { inspectRevisionReadiness, requireRevisionReady } from "pixelkiln"

const readiness = await inspectRevisionReadiness(spec, lock)
if (readiness && !readiness.ready) console.error(readiness.reason)

// Run again at the boundary where provider work would begin.
await requireRevisionReady(spec, lock)
```

`buildPlan` already does the first check and reports an unsafe child as
`blocked`. `submit` does the second check automatically. Providers advertise
accepted modes with optional `supportsRevision(mode)`. Omission means no
revision support and makes resolution fail offline.

## Audit and gate generated art

```ts
import { auditStyle, evaluateAudit } from "pixelkiln"

const audit = await auditStyle(loaded, specs, "neon", lock)
const result = evaluateAudit(audit, {
  maxDistance: 35,
  minTransparency: 0.1,
  maxColors: 128,
  sigma: 1.5,
})

if (!result.safe) console.error(result.violations)
```

Audits evaluate every structural output separately. Missing and unreadable
files make the result unsafe even when all measured assets pass. Standard
non-interlaced greyscale, indexed, RGB, greyscale-alpha, and RGBA PNGs are
normalized to RGBA before palette and transparency measurements.

Provider-neutral pixel refinement is also public. `refineFrameSet` accepts
ordered `{ role, path }` sources and writes one atomic multi-output record:

```ts
import { refineAsset, refineFrameSet, checkQualityRecord } from "pixelkiln"

await refineAsset({
  source: "candidates/mountain.png",
  output: "art/mountain-native.png",
  palette: ["#141b1e", "#23312a", "#709fcf", "#f1bb70"],
  fixerPython: ".pixelkiln/pixelfixer/bin/python",
})

const quality = await checkQualityRecord("art/mountain-native.pixelkiln.json")
if (!quality.safe) console.error(quality.reasons)

await refineFrameSet({
  sources: [
    { role: "frame-00", path: "raw/idle-00.png" },
    { role: "frame-01", path: "raw/idle-01.png" },
  ],
  output: "art/idle.png",
  fps: 12,
  palette: ["#161321", "#49374f", "#c16c5b", "#f3d6b3"],
})
```

`refineAsset` reconstructs the native grid through a pinned Pixel Art Fixer
installation, applies the exact palette without dithering, audits the result,
and writes a managed `refine` artifact bundle. Human approval is a separate
`approveQualityRecord` call so automated generation cannot approve itself.

Manifest orchestration is public too:

```ts
import {
  inspectQualityProfile,
  refineQualityProfiles,
  requireApprovedQualitySources,
} from "pixelkiln"

await refineQualityProfiles(specs, lock, {
  fixerPython: ".pixelkiln/pixelfixer/bin/python",
})
const state = await inspectQualityProfile(specs[0], lock)
const approvedSources = await requireApprovedQualitySources(specs, lock)
```

Inspection is read-only. Batch refinement preserves current pending and approved
records unless `force` is explicit. `requireApprovedQualitySources` throws when
a selected profile is missing, stale, tied to another source, or not approved;
pass its result to `packStyle` as `sourceOverrides`.

For repository-wide image regression checks, snapshot and verify a portable
baseline:

```ts
import {
  checkQualityBaseline,
  resolveQualityInputs,
  snapshotQualityBaseline,
} from "pixelkiln"

const inputs = resolveQualityInputs([
  { id: "mountain", path: "../art/mountain-native.png" },
], "config/quality-inputs.json")

await snapshotQualityBaseline(inputs, "quality/pixelkiln.quality.json")
const regression = await checkQualityBaseline("quality/pixelkiln.quality.json")
if (!regression.safe) console.error(regression.cases)
```

`measureImageQuality` exposes the underlying PNG metrics. Baselines can also
bind a refinement record, which makes changed record bytes or stale source and
output hashes a hard failure. These APIs measure structural drift; they do not
replace the separate human review recorded by `approveQualityRecord`.

## Inspect and verify recipes

Recipe functions use the same offline path as the CLI:

```ts
import { installRecipe, listBundledRecipes, verifyRecipe } from "pixelkiln"

const available = await listBundledRecipes()
const installed = await installRecipe("comfyui/pixel-art-xl-environment@1.0.0")
const verification = await verifyRecipe(installed.destination, {
  modelRoot: "/path/to/ComfyUI/models",
})

if (!verification.ok) console.error(verification)
```

`RecipeSchema` validates the public v1 format. `recipeDigest` computes its
canonical metadata digest, and `resolveRecipe` accepts either a bundled selector
or local path. Installation is transactional and protects changed destination
files unless `force` is explicit. These calls never download dependencies or
contact a provider.

## Build sprite sheets

Use `packStyle` for one lockfile style or `packSprites` for an explicit list:

```ts
import { packSprites, packStyle } from "pixelkiln"

const sheet = packStyle(lock, "ground", loaded.root, {
  outputRoles: ["tile-00", "tile-01"],
})

const shared = packSprites([
  { id: "anvil", path: "/absolute/art/anvil.png" },
  { id: "hammer", path: "/absolute/art/hammer.png" },
])
```

Both return PNG bytes, a deterministic JSON-compatible atlas, and details for
skipped files plus source hashes for provenance. Common non-interlaced PNG color
modes and bit depths are accepted as inputs; packed output is always RGBA.
Corrupt and interlaced inputs are skipped with a specific reason. `mountStyle`
and `mountSprites` provide declared-cell placement when existing atlas
coordinates must remain stable.

The CLI adds a `.pixelkiln.json` companion, stages the three members together,
restores the previous bundle after ordinary write failures, and leaves
byte-identical members untouched. Library consumers can apply the same behavior
with `writeManagedArtifactBundle()`, then use `verifyArtifactBundle()` to detect
changed sources, outputs, or metadata without rendering again. The managed
writer adopts pre-companion files only when byte-identical, refuses to replace
unowned or manually modified output, and accepts `{ force: true }` as an
explicit takeover. `writeArtifactBundle()` remains the lower-level transactional
primitive for callers with their own ownership policy.

Managed writes also keep a short-lived transaction journal beside the companion.
The next invocation rolls back an interrupted pre-commit promotion or completes
post-commit cleanup before checking ownership. Journal recovery is restricted to
the current bundle's exact destinations and same-directory PixelKiln temp names;
an unsafe journal or live concurrent writer is refused.

## Export generated tiles

```ts
import { exportTileset } from "pixelkiln"

const exported = exportTileset(lockEntry, spec, {
  format: "tiled",
  manifestDir: loaded.root,
  imageName: "terrain.png",
  columns: 8,
})
```

The generic format preserves the complete provider rule object. Tiled and
Godot exporters translate supported 4-edge and 4-corner rule sets and reject
unknown semantics rather than emitting plausible but incorrect adjacency.
See [TILES.md](./TILES.md) for file contracts and engine details.

## Provider integrations

`Provider` is the capability boundary. Generation pipelines accept that
interface rather than importing PixelLab directly. `PixelLabProvider`,
`RetroDiffusionProvider`, `ComfyUIProvider`, and `ScenarioProvider` are built in;
`FakeProvider` implements it in memory for deterministic tests.

```ts
import { FakeProvider, fetchAssets, poll, submit } from "pixelkiln"

const provider = new FakeProvider({ candidates: 4 })
const lockPath = "pixelkiln.lock.json"
await submit(provider, loaded, plan.actionable, lock, lockPath)
await poll(provider, lock, lockPath, { specs })
await fetchAssets(provider, specs, lock, lockPath)
```

Provider-backed operations mutate the supplied lock object; persist at the
workflow boundary with `saveLock`. See
[provider comparison](../PROVIDERS.md) before selecting or implementing
another backend, especially its optional capabilities and cost units.

Custom providers may implement `resolveInputs(inputs, context)` when assets can
supply provider-owned values. Return `inputs` for runtime validation/submission
and an optional JSON-safe `identity` for `specHash`. The identity must include
every byte or scalar that can change provider output and must exclude
machine-local paths or credentials. Providers that omit the hook fail closed
when an asset declares non-empty `providerInputs`.

These low-level operations intentionally accept one provider. A mixed-provider
caller should partition specs and plan items by `spec.provider`, instantiate
each adapter independently, and preserve the provider recorded on a lock entry
when resuming work. The CLI is the reference orchestration and validates every
provider-keyed budget before the first submission.

`isSensitiveSourceUrl` detects credential-bearing provider URLs, while
`shouldPersistSourceUrl` applies the lockfile rule: keep durable public or
provider-specific references, but drop signed URLs, inline data, and local file
URLs after successful ingestion. Adapters should prefer refreshable references
such as `retrodiffusion://` and `comfyui://` over temporary download URLs.
Scenario uses the same rule with `scenario://` asset references.

`submit` validates adapter estimates again at the spending boundary and returns
`{ spent, unit }` for successful submissions. Lock entries retain fractional
costs with their unit; use `spendByUnit(lock)` for history. Use
`measureBalanceChange(before, after)` when the provider exposes authoritative
balance readings and keep that observed delta distinct from the estimate.

## Stability and file paths

- Public imports come from `pixelkiln`; internal `src/` paths are not part of
  the package contract.
- Manifest-relative outputs resolve from `loaded.root`, not the process's
  current working directory.
- New lock outputs are portable manifest-relative paths. `resolveOutputPath`
  resolves one for file I/O; `normalizeLockOutputPaths` rebases absolute paths
  from earlier v2 locks and marks them for persistence on the next `saveLock`.
  Spec-aware operations derive the current destination from the manifest, so a
  stale lock path cannot redirect a restore.
- Lock keys use `styleId/assetId`. Structural members use stable output roles
  such as `assetId/tile-03` in audits and atlases.
- The lockfile is a paid-work record. Use its exported load/save/upsert helpers
  instead of rewriting it piecemeal.
