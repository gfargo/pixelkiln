# Agent workflows

PixelKiln includes an agent skill for tools that support the open `SKILL.md`
format. It tells an agent to plan before spending, cap every paid run, restore
before regenerating, stop for human selection, and keep provenance through
packaging.

## Install the skill

From any project directory:

```bash
npx skills add gfargo/pixelkiln@pixelkiln
```

Then ask your agent to use `$pixelkiln` while working with a PixelKiln manifest.
The skill is provider-neutral and does not contain credentials or make provider
calls by itself.

## What the skill tells an agent to do

With the skill loaded, an agent should:

1. Find and validate `pixelkiln.manifest.json`.
2. Run `doctor --dry-run` and `plan` before paid work.
3. Report actionable, recoverable, and cost totals for each provider and unit.
4. Follow the plan's exact resume command for recoverable paid work: `poll`,
   `pick`, `fetch`, or `restore`. Do not submit it again.
5. Pass an explicit `--budget` within the amount the user authorized; use one
   `provider=amount` ceiling for every paid provider in a mixed run.
6. Leave artwork selection in the local `pick` page unless the user gives a
   specific selection rule.
7. When a style declares `quality`, run manifest-mode `pixelkiln refine`; its
   `fixerPython` can pin the project-local interpreter. Leave
   approval to a named human reviewing the exact PNG, and require `refine check`
   before packaging. The rule is provider-neutral; ComfyUI still needs its extra
   prompt-coverage and composition review.
8. Commit the manifest, lockfile, generated output, and artifact companions, but
   never credentials or `.pixelkiln/` caches.
9. Prefer a version-pinned recipe when one matches the provider and task. Verify
   the installed workflow, and verify models when their local root is known.
10. When an asset declares `revision`, treat a blocked parent or mask as a hard
    dependency. Generate, fetch, refine, and approve the parent explicitly;
    never bypass the gate or approve it for the user.

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
| ComfyUI adapter | Experimental self-hosted still, controlled-revision, and atomic frame-set backend; PixelKiln automates lineage and mechanical quality checks while a person retains visual approval. |
| Scenario adapter | Experimental hosted still-image backend; BFL Flux 2 Dev quote, paid single/two-output generation, human review, and durable recovery live-tested. |

PixelKiln's core is provider-neutral, but PixelLab remains the only production
adapter. Retro Diffusion generation support is experimental. Paid RD Fast and
RD Plus single-candidate stills have passed from
quote through validated download and recovery. Multi-candidate, tileset, GIF,
and spritesheet workflows still need representative live smoke tests. Scenario
has one live-tested BFL Flux 2 Dev profile plus mocked edge coverage; other
model schemas and broader batches remain unverified. See
[provider comparison](../PROVIDERS.md) before choosing a provider for a
new project or a large environment asset. Once chosen, follow
[Set up PixelLab](./PIXELLAB.md),
[Set up Retro Diffusion](./RETRO_DIFFUSION.md),
[Set up ComfyUI](./COMFYUI.md), or
[Set up Scenario](./SCENARIO.md).

The installed skill keeps the shared safety workflow in `SKILL.md` and loads a
focused reference only when needed: PixelLab, Retro Diffusion, ComfyUI,
Scenario, or a project that uses more than one. In a mixed manifest, the
top-level provider is the default and each style may override it. Plans,
confirmations, and budgets stay separate by provider and unit. See
[Mixed-provider projects](./MIXED_PROVIDERS.md) for the complete contract.

## Recommended first prompt

```text
Use $pixelkiln to inspect this project's manifest, run the free checks and plan,
then tell me the exact budget required for each provider before generating anything.
```

For command details, continue with the [CLI reference](./CLI.md). For recovery
and account-level operations, read [Recovery and account safety](./RECOVERY.md)
before making changes.
