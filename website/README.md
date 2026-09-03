# PixelKiln website

The public marketing and documentation site for PixelKiln. It is a standalone
Next.js app within the library repository so product, documentation, and
website changes can share one pull request without adding web dependencies to
the published npm package. Production is available at
[pixelkiln.griffen.codes](https://pixelkiln.griffen.codes).

## Committing website changes

Scope website-only commits as **`chore(website):`**. This directory is outside
the package `files` allowlist, so nothing here reaches the published npm
tarball. Semantic Release reads subjects, not paths, and `feat(website):`
cuts a minor release of a package that did not change. `.releaserc.json`
also refuses a release to any `website`-scoped commit, so a wrong
subject is caught rather than published.

Use a normal `feat:`/`fix:` subject when a pull request touches both the
website and the library; the library change is the one being released.

## Local development

From the repository root:

```bash
npm ci --prefix website
npm run website:dev
```

The app runs at <http://localhost:3000>. Lint and production-build checks are:

```bash
npm run website:lint
npm run website:build
```

`npm run website:check` verifies that every canonical guide has exactly one
public route. The production build also checks analytics wiring, route-specific
canonicals, social metadata, structured data, and crawl files against the
generated HTML.

## Generated visual assets

The small brand sprites used by the site are managed by PixelKiln itself:

- `art/pixelkiln.manifest.json` declares the four sprites and their output;
- `art/pixelkiln.lock.json` records paid provider work and exact output hashes;
- `public/sprites/` contains the committed files served by the site.

From the repository root, validate and inspect the work before making any paid
request:

```bash
npm run pixelkiln -- doctor --dry-run --manifest website/art/pixelkiln.manifest.json
npm run pixelkiln -- plan --manifest website/art/pixelkiln.manifest.json
npm run pixelkiln -- audit --manifest website/art/pixelkiln.manifest.json --check
```

If every sprite genuinely needs generation, the complete set is at most four
PixelLab generations. Copy the plan's estimate into an explicit hard ceiling:

```bash
npm run pixelkiln -- gen --manifest website/art/pixelkiln.manifest.json --budget 4
```

Commit the manifest, lockfile, and reviewed sprites together. Never commit
`.env.local` or the `.pixelkiln/` cache.

The homepage workflow illustrations live separately in
`public/sprites/workflow/`. They are 64×64 transparent presentation assets,
normalized to the site palette with hard pixel edges and equal optical
padding. Keep them at that source size and let the workflow cards render them
without scaling transforms; this preserves consistent weight across Declare,
Plan, Review, and Ship.

## Review showcase capture

`public/review-ui-showcase.jpg` is a capture of the real local review renderer,
populated with the generated brand assets. Capture it at 1280×720 after every
candidate has loaded and with a selection visibly active. When replacing the
production image, use a new public filename and update its page reference; this
avoids stale images in the Next.js/Vercel image-optimization cache.

## Documentation source

Routes under `/docs` read the Markdown in the repository's `docs/` directory
and the root project-policy files at build time. Add new canonical guides to
`app/lib/docs.ts`; do not duplicate their prose inside this directory.

## Vercel

Import the PixelKiln GitHub repository into Vercel and set the project Root
Directory to `website`. Keep **Include source files outside of the Root
Directory in the Build Step** enabled so the documentation renderer can read
the canonical repository Markdown.

The canonical URL defaults to `https://pixelkiln.griffen.codes`. Set
`NEXT_PUBLIC_SITE_URL` only when an alternate deployment needs its own explicit
canonical origin.

### Analytics and performance

The root layout loads Vercel Web Analytics and Speed Insights. Vercel records
pageviews and client-side route changes automatically. The site also sends four
small, stable event families:

| Event | When it fires | Properties |
| --- | --- | --- |
| `CTA Click` | A tracked internal link outside the docs | `id`, `section`, `href` |
| `Documentation Link Clicked` | A tracked link into `/docs` | `id`, `slug`, `source` |
| `Outbound Click` | A tracked link to another site | `id`, `section`, `destination` hostname |
| `Install Command Copied` | The homepage skill command is copied successfully | `target`, `source` |

Keep event names and properties stable so dashboard reports remain comparable.
Use short, finite values and never send prompts, credentials, email addresses,
or other user-entered text. The pageview hook keeps campaign parameters but
replaces values for credential-like query keys before transmission.

Keep **Web Analytics** and **Speed Insights** enabled in the Vercel project
dashboard. After a production deployment, confirm pageviews under Analytics,
each event in the Events panel, and field performance under Speed Insights.
Custom-event availability and retained history depend on the Vercel plan.

### Search metadata

Every public route has its own canonical URL, title, description, Open Graph
URL, and social title. The root Open Graph image is shared across the site.
`robots.ts` and `sitemap.ts` publish the crawl policy, canonical route list, and
the homepage's provider comparison images. The homepage identifies the site and
source repository with JSON-LD; documentation pages add article and breadcrumb
data.
