# Contributing

Thanks for improving pixelkiln. The project is deliberately conservative around
paid generation, file ownership, and provider state: a convenient failure must
never widen a paid run, overwrite hand-edited art, or lose the identity of work
that already cost money.

## Development setup

Requires Node.js 20 or newer.

```bash
npm ci
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
The Review UI showcase should be captured at 1280×720 only after every asset
loads. Give a replacement capture a new public filename and update the page
reference so deployed image caches cannot retain the old version.

Run the source CLI without a global install:

```bash
npm run pixelkiln -- help
npm run pixelkiln -- plan --manifest examples/minimal/pixelkiln.manifest.json
```

Tests must not require a live provider account or API key. Use `FakeProvider`
for pipeline behavior and mocked HTTP responses for PixelLab wire contracts.

## Change guidelines

- Start from `main` and keep one coherent change per pull request.
- Use conventional commit subjects (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`). Semantic Release derives versions from them.
- **Scope website-only work as `chore(website):`.** `website/` is not in the
  package `files` allowlist, so nothing under it can reach the published
  tarball — but Semantic Release cannot see that, and a `feat(website):`
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
