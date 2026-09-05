# Mixed-provider projects

Use more than one provider in a single manifest when each provider has a clear
job. A common split is PixelLab for prompt-sensitive props, Retro Diffusion for
cutouts or animation, and ComfyUI for private model experiments.

The top-level `provider` is the default. A style can override it:

```jsonc
{
  "name": "my-game",
  "provider": "pixellab",
  "styles": {
    "props": {
      "generator": "map",
      "outDir": "assets/generated/props"
    },
    "backdrops": {
      "provider": "retrodiffusion",
      "generator": "pixflux",
      "outDir": "assets/generated/backdrops",
      "providerOptions": {
        "retrodiffusion": {
          "promptStyle": "rd_plus__environment",
          "numImages": 2
        }
      }
    },
    "local-studies": {
      "provider": "comfyui",
      "generator": "map",
      "outDir": "assets/generated/local-studies",
      "providerOptions": {
        "comfyui": {
          "workflowFile": "workflows/environment-api.json",
          "outputNodeId": "9",
          "numImages": 4,
          "bindings": {
            "prompt": { "nodeId": "6", "input": "text" },
            "width": { "nodeId": "11", "input": "width" },
            "height": { "nodeId": "11", "input": "height" },
            "batchSize": { "nodeId": "5", "input": "batch_size" }
          }
        }
      }
    }
  },
  "assets": {
    "watchtower": {
      "prompt": "a fortified mountain watchtower",
      "styles": ["props"]
    },
    "alpine-valley": {
      "prompt": "an alpine valley at dusk",
      "styles": ["backdrops"]
    },
    "forest-study": {
      "prompt": "a layered forest clearing",
      "styles": ["local-studies"]
    }
  }
}
```

Provider choice belongs to a style, not an asset. Use an asset's `styles` list
to restrict it to the intended styles. That keeps every resolved
`styleId/assetId` on one backend and makes provider-specific settings easy to
audit. Keep each style's output directory distinct.

## Plan and budget

`plan` reports a separate group for every provider and cost unit. It never adds
PixelLab generations, Retro Diffusion dollars, and ComfyUI's `free` unit into a
fictional total.

```bash
pixelkiln doctor --dry-run
pixelkiln plan
pixelkiln gen \
  --budget pixellab=12 \
  --budget retrodiffusion=0.20 \
  --budget comfyui=0
```

Copy each paid estimate into its matching `provider=amount` ceiling. A mixed
run rejects an unkeyed budget, a missing paid-provider ceiling, an unknown
provider, or a repeated provider. A `free` group may be written explicitly as
zero. PixelKiln validates every ceiling before it submits any work.
Single-provider manifests keep the shorter `--budget 12` form.

Filtering can reduce the run to one style, but the command still prints the
provider group it will use. A single-group run may also use the unkeyed form:

```bash
pixelkiln gen --style backdrops --budget 0.08
```

## Resume and recover

One lockfile can safely contain work from several providers. Every entry records
the provider that accepted it. Poll, review, fetch, restore, and tag route each
entry back to that recorded provider, which is authoritative for in-flight and
recoverable work.

Changing a style's provider changes its spec identity and makes existing work
stale. PixelKiln will not silently relabel old provider work with `accept`.
Review the plan and generate a replacement under the new provider instead.

## Account-wide commands

An account operation must name its provider when the manifest uses more than
one:

```bash
pixelkiln balance --provider pixellab
pixelkiln adopt --provider pixellab
pixelkiln salvage --provider retrodiffusion --dry-run
pixelkiln purge --provider retrodiffusion --dry-run
```

`adopt`, `salvage`, and `purge` only consider styles and lock entries assigned
to the selected provider. Cross-project workspace claims are provider-qualified,
so identical remote IDs from two services do not collide.

## When separate manifests are better

Separate manifests remain useful when different teams own each provider, their
release schedules differ, or their credentials must never share one runtime.
Register those manifests in a workspace catalog for aggregate status and safe
claim checks. Do not merge lockfiles by hand.

Whatever layout you choose, test one representative asset before expanding a
batch. Provider benchmarks show tendencies, not guarantees, and ComfyUI output
still needs native-grid, palette, prompt-coverage, and human art review.
