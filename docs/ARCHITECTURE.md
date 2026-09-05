# Architecture

PixelKiln separates provider mechanics from the project state machine:

```text
manifest + lock + planning + review + recovery + artifact pipelines
──────────────────── Provider interface ─────────────────────────
PixelLabProvider   RetroDiffusionProvider   ComfyUIProvider   ScenarioProvider   FakeProvider
```

Everything above the provider boundary is backend-neutral. URL shapes, auth
headers, request/response schemas, and optional account capabilities remain in
the adapter.

## Manifest and resolved specs

The committed manifest is intent. Resolution combines one style and one asset,
loads/reference-hashes style images, applies overrides, chooses a provider-
supported generator, and computes a deterministic spec hash. The hash excludes
project root, output location, and tags but includes every pixel-affecting
setting. A provider may resolve local files before hashing. ComfyUI uses this
hook to parse and hash workflow JSON without making a network request. The
runtime graph can then be submitted without putting a machine-specific path in
the stable identity.

See [manifest reference](./MANIFEST.md).

## Lockfile

`pixelkiln.lock.json` is the committed paid-work record. Version 2 entries
retain:

- style/asset identity and spec hash;
- provider and remote object/job ids;
- explicit lifecycle status and errors;
- durable provider source references, candidates, and selections;
- `outputs[]` with portable path, SHA-256, optional structural role, and
  optional PNG/GIF media type;
- provider-specific metadata under a provider-id namespace;
- successful submission cost and cost unit.

Lock keys are `styleId/assetId`. Output paths use manifest-relative `/`
separators so a clone or moved checkout remains valid. Legacy absolute v2 paths
are rebased in memory and rewritten portably on the next save. The current
manifest remains destination authority; a stale lock path cannot redirect
restore into an unrelated project file.

Cost units that differ are never summed. Built-in adapters currently use
`generations`, `usd`, `compute-units`, and `free`; custom adapters may register
another non-empty unit. Candidate count also belongs to the provider estimate
rather than being assumed globally.

## State machine

The provider pipeline is deliberately resumable:

```text
plan → submit → poll → pick (when needed) → fetch
                    └──────── structural/inline outputs ────────┘
```

Remote ids are saved immediately after submission. Generation and download
failures remain separate, so paid work with a temporary CDN failure is
recoverable at zero generation cost. Each stage can be rerun independently;
`gen` is only their everyday orchestration.

Provider responses are runtime-validated before entering lock state. A 2xx
response with a missing object id, malformed URL set, invalid estimate, or
changed field type becomes an explicit adapter error rather than corrupted
durable state.

Storage URLs whose query strings carry provider credentials are transient.
Adapters should replace them with refreshable provider references before
settled lock state; successful ingestion also strips sensitive, inline, and
local-file sources. This preserves recovery without turning the committed
lockfile into a credential store.

## Output identity

One manifest asset may produce multiple structural members. Roles such as
`tile-03` are load-bearing identity, not presentation. Audits, packs, mounts,
and exporters all use the same role model. A consumer must request a role when
there is no unambiguous primary output.

PNG ingestion validates signature, chunks, CRCs, palettes, compressed data,
scanlines, dimensions, and supported color modes. GIF ingestion walks the
logical screen, color tables, extensions, image-data blocks, and trailer. Both
formats are validated before bytes become durable output or recovery cache data.

## Concurrency and lock saves

Lock writes use a same-directory temporary file and rename. An advisory writer
lock serializes separate processes. In-process saves queue per path, and
field-level dirty patches merge separate snapshots so updates to different
assets, or to different fields of one asset, do not silently lose the earlier
write.
Stale advisory locks are recoverable after their safety window.

## Derived artifact transactions

Pack, mount, and export use a separate managed bundle writer:

1. Recover an interrupted prior transaction.
2. Validate provenance ownership and manual edits.
3. Compare every desired member and skip identical bytes.
4. Write an immutable transaction journal.
5. Stage all changing members beside their destinations.
6. Move existing members to unique backups.
7. Promote every stage.
8. Write a durable commit marker.
9. Remove backups, stages, journal, and marker.

Before the marker, recovery restores the old complete set. After the marker,
recovery keeps the new complete set and finishes cleanup. Journal paths are
validated against current destinations and reserved same-directory temp names.
See [derived artifacts](./ARTIFACTS.md).

## Caches

The project content cache is keyed by output SHA-256. The account cache maps
provider object ids to remote content hashes for adoption/salvage. Neither is
authoritative or committed; both can be deleted and rebuilt. Every recovery
byte is structurally validated before use.

## Provider capability boundary

Providers are selected from a registry by each style's `provider`, falling back
to the manifest default. Planning groups resolved work by provider and cost
unit. After submission, the provider recorded on each lock entry is authoritative
for polling, selection, download, restore, and tag routing. Required members
cover support/estimate, submit, poll, and download;
candidate selection is required only when an adapter can return alternatives.
Account-wide listing, tagging, deletion, and balance are optional. Commands
such as adopt or salvage report a capability gap rather than failing through
an undefined method.

`PixelLabProvider` is production and live-tested. `RetroDiffusionProvider` is
an experimental still, tileset, and animation adapter. Authenticated RD Fast
and RD Plus single-candidate still lifecycles have passed end to end. Its
multi-candidate, tileset, GIF, and spritesheet paths retain mocked coverage
pending paid live smokes. Its durable `retrodiffusion://` references refresh
temporary result URLs when recovery cannot use the local cache.
`ComfyUIProvider` is an experimental self-hosted
adapter. It resolves and hashes an API-format workflow offline, submits an
input-bound clone, polls local history, and stores portable `comfyui://` output
references so a lockfile does not retain a workstation hostname. It supports
one still-image output node today. A core-node Stable Diffusion 1.5 graph has
passed single-image generation, four-candidate queue detection, and cache-only
recovery on Apple MPS. `ScenarioProvider` is an experimental hosted still-image
adapter. It keeps offline planning conservative, records the provider's free
submit-time Compute Unit quote, and stores durable `scenario://` job and asset
references that refresh signed URLs. Authentication and CU preflight have
passed live, while paid generation and recovery remain mocked. `FakeProvider`
implements the same contract
in memory, which keeps the pipeline testable without credentials or network
access. See [library API](./LIBRARY.md) and
[provider comparison](../PROVIDERS.md).
