# Set up PixelLab

PixelLab is PixelKiln's default provider and the production choice for current
projects. Its generation and account-management paths have been exercised
against a live account.

## Add the credential

Create `.env.local` beside `pixelkiln.manifest.json`:

```dotenv
PIXELLAB_API_KEY=...
```

Keep this file out of Git. PixelKiln also reads the variable from the current
process environment.

## Select PixelLab

The `provider` field is optional because `pixellab` is the default. Declaring it
makes the choice clear:

```jsonc
{
  "name": "my-game",
  "provider": "pixellab",
  "styles": {
    "props": {
      "generator": "map",
      "outDir": "assets/generated/props",
      "promptSuffix": ", isolated pixel-art game asset"
    }
  },
  "assets": {
    "anvil": {
      "prompt": "a compact blacksmith anvil",
      "width": 64,
      "height": 64
    }
  }
}
```

Run the free checks before a paid request:

```bash
pixelkiln doctor --dry-run
pixelkiln plan
pixelkiln gen --budget 1
```

Copy the exact estimate from `plan` into `--budget`. PixelLab budgets use
subscription generations.

## Choose a generator

| Generator | Start here when | Measured cost |
|---|---|---:|
| `map` | You need one prop, icon, building, or landmark at arbitrary dimensions | 1 generation |
| `pixflux` | You need a closed palette or a full-bleed background | 1 generation |
| `1dir` | You need references or several candidates for human review | 20 to 40 generations |
| `tiles` | You need ground variations or a connected structural set | 20 to 40 generations |

`map` accepts these values:

- `view`: `low top-down`, `high top-down`, or `side`
- `outline`: `single color outline`, `selective outline`, or `lineless`
- `shading`: `flat shading`, `basic shading`, `medium shading`, or `detailed shading`
- `detail`: `low detail`, `medium detail`, or `high detail`

PixelLab describes map objects as transparent, but the 256px map objects in our
[environment benchmark](./PROVIDER_BENCHMARK.md) were opaque. Check the alpha
channel before building a production batch. For a scenic background, use
`pixflux` with `noBackground: false`.

Read [Generator selection](./GENERATORS.md) for the full constraints and
measured economics.

## Account workflows

The PixelLab adapter supports `balance`, `adopt`, `salvage`, `tag`, and the
separate confirmed `purge` flow. These are useful when several projects share
one provider account or when existing local art needs its original provenance.
Read [Recovery and account safety](./RECOVERY.md) before changing remote
objects.

PixelLab's official
[MCP server](https://github.com/pixellab-code/pixellab-mcp) gives agents direct
access to PixelLab generation tools. It complements PixelKiln: the MCP handles
creation, while PixelKiln owns project state, budgets, review, recovery, and
packaging.

## What is outside this adapter

PixelLab offers more than PixelKiln currently exposes. Character generation,
multi-direction rotation, and animation are not part of this adapter. Use the
[manifest reference](./MANIFEST.md) for the fields PixelKiln supports today.

