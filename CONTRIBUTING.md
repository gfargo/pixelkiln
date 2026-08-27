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
npm test
npm run build
npm run test:package
```

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
- Add regression coverage for bug fixes and behavior coverage for new public
  options or exports.
- Update README/help text and focused docs in the same change as user-facing
  behavior.
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
