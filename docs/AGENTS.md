# Agent workflows

PixelKiln includes an official agent skill for tools that support the open
`SKILL.md` format. It teaches the operational decisions that matter: plan before
spending, cap every paid run, restore before regenerating, keep selection human,
and preserve provenance through packaging.

## Install the skill

From any project directory:

```bash
npx skills add gfargo/pixelkiln@pixelkiln
```

Then ask your agent to use `$pixelkiln` while working with a PixelKiln manifest.
The skill is provider-neutral and does not contain credentials or make provider
calls by itself.

## What the skill changes

With the skill loaded, an agent should:

1. Find and validate `pixelkiln.manifest.json`.
2. Run `doctor --dry-run` and `plan` before paid work.
3. Report actionable, recoverable, and cost totals in the provider's unit.
4. Use `restore` instead of regenerating recoverable assets.
5. Pass an explicit `--budget` within the amount the user authorized.
6. Leave artwork selection in the local `pick` page unless the user gives a
   specific selection rule.
7. Commit the manifest, lockfile, generated output, and artifact companions, but
   never credentials or `.pixelkiln/` caches.

The skill guides the workflow; PixelKiln remains the deterministic execution
layer. This separation keeps agent reasoning out of polling, hashing, downloads,
state transitions, and output placement.

## Providers, PixelLab MCP, and PixelKiln

The [official PixelLab MCP server](https://github.com/pixellab-code/pixellab-mcp)
gives an agent direct PixelLab creation tools. It is complementary to PixelKiln,
not a replacement:

| Layer | Responsibility |
|---|---|
| PixelLab MCP | Agent-facing access to PixelLab generation capabilities. |
| PixelKiln skill | Agent guidance for safe project-level operations. |
| PixelKiln library/CLI | Budgets, state, provenance, review, recovery, audit, and packaging. |
| PixelLab adapter | The current production and live-tested generation backend. |
| Retro Diffusion adapter | Experimental backend; authenticated paid single-still lifecycle plus mocked advanced-workflow tests. |

PixelKiln's core is provider-neutral, but PixelLab remains the only production
and paid-generation-tested adapter. Retro Diffusion generation support is
experimental. Paid RD Fast and RD Plus single-candidate stills have passed from
quote through validated download and recovery. Multi-candidate, tileset, GIF,
and spritesheet workflows still need representative live smoke tests. See
[PixelLab vs. Retro Diffusion](../PROVIDERS.md) before choosing a provider for a
new project or a large environment asset. Once chosen, follow
[Set up PixelLab](./PIXELLAB.md) or
[Set up Retro Diffusion](./RETRO_DIFFUSION.md).

## Recommended first prompt

```text
Use $pixelkiln to inspect this project's manifest, run the free checks and plan,
then tell me the exact provider-unit budget required before generating anything.
```

For command details, continue with the [CLI reference](./CLI.md). For recovery
and account-level operations, read [Recovery and account safety](./RECOVERY.md)
before making changes.
