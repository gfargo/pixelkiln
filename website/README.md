# PixelKiln website

The public marketing and documentation site for PixelKiln. It is a standalone
Next.js app within the library repository so product, documentation, and
website changes can share one pull request without adding web dependencies to
the published npm package. Production is available at
[pixelkiln.griffen.codes](https://pixelkiln.griffen.codes).

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
public route.

## Documentation source

Routes under `/docs` read the Markdown in the repository's `docs/` directory
and the root project-policy files at build time. Add new canonical guides to
`app/lib/docs.ts`; do not duplicate their prose inside this directory.

## Vercel

Import the PixelKiln GitHub repository into Vercel and set the project Root
Directory to `website`. Keep **Include source files outside of the Root
Directory in the Build Step** enabled so the documentation renderer can read
the canonical repository Markdown.

Set `NEXT_PUBLIC_SITE_URL` to the final HTTPS origin once a custom domain is
assigned. Vercel's production-project URL is used automatically before then.
