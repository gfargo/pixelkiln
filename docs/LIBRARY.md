# Library API

Pixelkiln's public package entry point exposes the same provider-independent
primitives used by the CLI. Use these when a build tool, editor integration, or
game pipeline needs structured results instead of terminal output.

## Load, resolve, and plan

```ts
import {
  buildPlan,
  loadLock,
  loadManifest,
  PixelLabProvider,
  resolveSpecs,
  summarize,
} from "pixelkiln"

const loaded = await loadManifest("pixelkiln.manifest.json")
const provider = PixelLabProvider.forOffline()
const specs = await resolveSpecs(loaded, { provider })
const lock = await loadLock("pixelkiln.lock.json")
const plan = await buildPlan(specs, lock)

console.log(summarize(plan))
if (plan.actionable.length) {
  console.log(`${plan.cost} ${plan.costUnit} for ${plan.actionable.length} assets`)
}
```

Planning performs no provider calls and spends nothing. Passing a provider lets
its synchronous `supports()` and `estimate()` methods determine cost unit and
candidate count; no credentials are required for those methods. A resolved
spec has the fully inherited style and asset settings plus its deterministic
spec hash.

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
skipped files. Common non-interlaced PNG color modes and bit depths are accepted
as inputs; packed output is always RGBA. Corrupt and interlaced inputs are
skipped with a specific reason. `mountStyle` and `mountSprites` provide
declared-cell placement when existing atlas coordinates must remain stable.

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
interface rather than importing PixelLab directly; `FakeProvider` implements it
in memory for deterministic tests.

```ts
import { FakeProvider, fetchAssets, poll, submit } from "pixelkiln"

const provider = new FakeProvider({ candidates: 4 })
const lockPath = "pixelkiln.lock.json"
await submit(provider, loaded, plan.actionable, lock, lockPath)
await poll(provider, lock, lockPath, { specs })
await fetchAssets(provider, specs, lock, lockPath)
```

Provider-backed operations mutate the supplied lock object; persist at the
workflow boundary with `saveLock`. See [PROVIDERS.md](../PROVIDERS.md) before
implementing another backend, especially its optional capabilities and cost
units.

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
- Lock keys use `styleId/assetId`. Structural members use stable output roles
  such as `assetId/tile-03` in audits and atlases.
- The lockfile is a paid-work record. Use its exported load/save/upsert helpers
  instead of rewriting it piecemeal.
