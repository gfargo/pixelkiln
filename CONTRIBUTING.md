# Contributing

Thanks for improving pixelkiln. The project is deliberately conservative around
paid generation, file ownership, and provider state: a convenient failure must
never widen a paid run, overwrite hand-edited art, or lose the identity of work
that already cost money.

## Development setup

Requires Node.js 22 or newer. The repository defaults to the latest Node.js 24
release through `.nvmrc`.

```bash
npm ci
npm run test:release
npm run typecheck
npm run test:docs
npm test
npm run build
npm run test:package
```

The Next.js marketing/documentation site is isolated in `website/`:

```bash
npm ci --prefix website
npm run website:check
npm run website:lint
npm run website:build
npm run website:dev
```

The site reads canonical Markdown from `docs/` and the root policy files at
build time. Do not create a second documentation copy under `website/`.

Website sprites are generated from `website/art/pixelkiln.manifest.json`.
Treat those requests as paid work: run `plan` and `audit` first, use an explicit
hard budget, and commit the manifest, lockfile, and reviewed outputs together.
Capture the Review UI at 1280×720 only after every asset
loads. Give a replacement capture a new public filename and update the page
reference so deployed image caches cannot retain the old version.

Run the source CLI without a global install:

```bash
npm run pixelkiln -- help
npm run pixelkiln -- plan --manifest examples/minimal/pixelkiln.manifest.json
```

Tests must not require a live provider account or API key. Use `FakeProvider`
for pipeline behavior and mocked HTTP responses for PixelLab or Retro Diffusion
wire contracts.

## Change guidelines

- Start from `main` and keep one coherent change per pull request.
- Use conventional commit subjects (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`). Semantic Release derives versions from them.
- **Scope website-only work as `chore(website):`.** `website/` is not in the
  package `files` allowlist, so nothing under it can reach the published
  tarball. Semantic Release cannot see that, and a `feat(website):`
  subject cuts a minor release whose contents are byte-identical to the one
  before it. That happened once already: 0.2.0 is a favicon and an Open Graph
  image. Any `website` scope is also refused a release by `releaseRules` in
  `.releaserc.json`, so a slip is caught rather than published, but the right
  subject keeps the changelog honest.
- Add regression coverage for bug fixes and behavior coverage for new public
  options or exports.
- Update README/help text and focused docs in the same change as user-facing
  behavior.
- Keep README as the concise product landing page. Put durable reference and
  workflow detail in `docs/`, and link every guide from `docs/README.md`.
- Run `npm run test:docs` after changing Markdown or the CLI command/flag
  surface. It checks local links, the docs index, README size, and CLI coverage.
- Run the website lint and build checks when changing `website/` or the
  canonical Markdown it renders.
- Run the package smoke test when changing exports, build configuration, the
  executable, package metadata, or the `files` allowlist.

## Architectural boundaries

- Provider-specific URLs, authentication, response schemas, and quirks belong
  below `Provider`.
- Planning stays offline. Provider `supports()` and `estimate()` must perform no
  I/O and estimates must carry their cost unit.
- Provider responses are untrusted input and need runtime validation before
  entering the lockfile.
- Lockfile writes must remain atomic and resumable. Additive defaults should
  preserve valid v2 files when extending lock entries.
- Unknown flags and ambiguous output selection are errors. Silent widening is
  especially dangerous when a command can spend provider quota.
- Never overwrite a generated file whose current bytes differ from its recorded
  hash, and never make deletion an implicit side effect of recovery/triage.

## Pull requests

Describe the user-visible outcome, any compatibility impact, and the exact
checks run. Keep generated `dist/` files out of commits; packaging builds them
from source. If hosted CI is unavailable, include the local Node version and
full check results in the PR description.

Security-sensitive findings should follow [SECURITY.md](./SECURITY.md), not a
public issue with exploit details.

## Releases

Merging to `main` is the release. Semantic Release derives the version from the
conventional commit subjects in the range, publishes to npm, tags the commit,
writes the GitHub release, prepends to `CHANGELOG.md`, and commits the changelog
and version back to `main` with `[skip ci]`. Contributors do not run anything.

**There is no npm token.** Publishing authenticates over OIDC trusted
publishing: the workflow grants `id-token: write`, npm exchanges that for a
short-lived credential, and the npm CLI performs the exchange itself during
`npm publish`. A side effect worth keeping is that every release carries a
signed provenance attestation linking the tarball to its source commit and
workflow run.

The release job is serialized so two quick merges cannot publish concurrently,
and it times out after 20 minutes rather than holding publishing permission
indefinitely. `npm run test:release` checks the repository-side trust contract:
the OIDC permission, GitHub-hosted runner, registry configuration, full checkout
history, absence of an npm publishing token, and the expected release plugins.

The public `gfargo/skills` tap watches PixelKiln releases on an hourly schedule.
When a new tag appears, it mirrors the tagged `skills/pixelkiln/` directory,
bumps the games plugin, and publishes a games release. PixelKiln remains the
source of truth; the source repository needs no cross-repository write token.

Two conditions have to hold on the npm side, and neither lives in this
repository:

- the package must exist on the registry, and
- it must have a Trusted Publisher entry naming this repository and the
  `release.yml` workflow.

When one is missing, the token exchange reports `404 OIDC token exchange error
- package not found`, and Semantic Release then falls through to token auth and
fails with `EINVALIDNPMTOKEN`. **That 404 does not necessarily mean the package
is absent.** It reads identically when the package is published but has no
Trusted Publisher entry, which is the more likely cause once a release has ever
succeeded. Check the entry before doubting the publish.

Because the exchange cannot authenticate against a package that does not exist
yet, `0.1.0` was published by hand to bootstrap that trust, and its changelog
section was written by hand for the same reason. Every release from `0.2.0`
onward is automated.

A failed release opens an issue labelled `semantic-release`, which the next
successful run closes. That label must exist in the repository or the reporting
step itself fails with a validation error and hides the original failure.

See the website scoping rule under [change guidelines](#change-guidelines) for
the one commit convention that changes whether a release happens at all.
