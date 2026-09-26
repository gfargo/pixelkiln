/** The help text. docs/CLI.md is the long form; scripts/check-docs.mjs keeps the two in step. */


export const HELP = `pixelkiln: manifest-driven pixel art generation

  pixelkiln <command> [options]

Commands
  init      Scaffold a manifest from an existing tree of PNGs.
  plan      Diff manifest against lockfile and disk. Costs nothing. Start here.
  doctor    Validate project state, recovery paths, and provider connectivity.
  gen       Full run: submit → poll → pick → fetch. The everyday command.
  submit    Queue generation jobs only.
  poll      Advance in-flight jobs to their settled state.
  pick      Open the contact sheet to choose among candidates.
  fetch     Download selected objects to their manifest paths.
  restore   Re-download missing generated files without generating new art;
            --generation <n|hash> brings a previous generation back instead.
  history   List the generations each asset has replaced and can restore.
  adopt     Match existing account objects to files already in the repo.
  accept    Keep existing art after a style reword. Re-baseline, do not regenerate.
  salvage   Triage account objects no lockfile claims. Recovers usable art.
            One session per matching style unless --style forces a single one.
  audit     Measure how consistently a style's assets hold together. Offline.
  refine    Build/check manifest quality profiles, or refine one --from PNG.
            Native grid, fixed palette, audit, and human approval. Offline.
  recipe    List, inspect, install, or verify versioned workflow packs. Offline.
  quality   Snapshot or check measurable image regressions. Offline.
  cache     Inspect local recovery/object-hash caches; optionally verify or prune.
  pack      Composite sprites into a PNG/atlas/provenance bundle. Offline.
  mount     Write a style's sprites into their declared cells of an existing
            sheet, leaving every other pixel untouched. Offline.
  export    Build a tile atlas, engine metadata, and offline provenance record.
  purge     Delete objects previously tagged discard. Irreversible; asks first.
  prune     Drop lock entries the manifest no longer declares. Offline; asks
            first. Local art is untouched.
  tag       Push manifest tags to the objects upstream (free).
  balance   Show the provider's remaining balance.
  estimate-skeleton <image> [--out <file>] [--frames <n>] [--force]
            PixelLab only: derive an 18-joint skeleton from a square 16-256px
            image, direct and un-budgeted (like balance, not a generation).
            Prints, or writes with --out, a ready keypoints file for an
            animate-skeleton revision: the estimated pose plus --frames copies
            (default 4) to edit. --out refuses to replace a file without --force.
  skeleton-preview <keypoints.json | asset> [--from <image>] [--out <file>]
            Draw every pose of a keypoints file over its source image as one
            PNG, locally and free. Given an animate-skeleton asset id, reads
            its keypointsFile and source from the manifest.
  status    Summarise the lockfile.
  edit      Hand-edit an asset in your own editor: copies the generated PNG to
            <outDir>/edits/, declares it as the asset's source, and opens it.
            edit detach places the generated art again (the file is kept).
  gallery   Open a local read-only gallery of every generation and its
            provenance: prompt, provider, cost, outputs, lineage, quality.
            --workspace <catalog> shows every registered project at once;
            --edit lets the page change prompts, sizes, tags, and add assets,
            and offers the in-browser pixel editor (--no-editor hides it);
            --budget enables Generate, Regenerate, and review under that ceiling.
  tools     status/install editor: the in-browser editor (Pixelorama) is a
            46 MB web build fetched once per release into a user cache and
            verified against pinned hashes. Offline once installed.
  workspace Register sibling projects and derive account-wide claims/status.
            add/remove/list/status/claims. Offline.
  unzoom    PixelLab: shrink an upscaled image (--from) back to its native
            pixel grid before using it as a style or reference image.
  font      PixelLab: generate a pixel font (--description, --out); writes a
            .ttf and a glyph atlas PNG. 25 generations; asks first.

Options
  --columns <n>       pack/export: sprites or tiles per row (default: near-square)
  --port <n>          Local review/gallery server port (default: choose a free port)
  --inputs <path>     pack/quality snapshot: JSON input list; needs --out
  --format <format>   export: generic (default), tiled, or godot (TileSet)
                      pack/mount: generic (default), aseprite, or godot (SpriteFrames)
  --output-role <r>   pack: include only this output role (repeatable)
  --primary-only      pack: include only unambiguous primary/single outputs
  --max-distance <n>  audit: maximum palette distance
  --min-transparency <0..1>  audit: minimum transparent canvas share
  --max-colors <n>    audit: maximum distinct opaque colors
  --sigma <n>         audit: relative outlier cutoff (default: 1.5)
  --palette <hexes>   refine: final comma-separated #rrggbb colors (repeatable)
  --fixer-python <path>  refine: override Python with Pixel Art Fixer installed
  --fixer-revision <sha>  refine: Pixel Art Fixer revision to record
  --min-grid-confidence <level>  refine: high (default), medium, or low
  --reviewer <name>   refine approve: human reviewer recorded in provenance
  --note <text>       refine approve: optional review note
  --model-root <dir>  recipe verify: also hash required local model files
  --generation <n|hash>  restore: the previous generation to bring back (1 = newest)
  --quantize <n>      unzoom: 0 auto palette (default), -1 keep all colors, 2-256 exact
  --description <text>  font: the style to draw, e.g. "warm orange arcade font"
  --weight <w>        font: Bold or Regular (default)
  --glyph-px <n>      font: native glyph size, 8, 16 (default), 32, or 64
  --prune             cache: remove invalid/unreferenced local cache data
  --manifest <path>   Default: pixelkiln.manifest.json
  --lock <path>       Default: pixelkiln.lock.json beside the manifest
  --style a,b         Restrict to these styles
  --only id1,id2      Restrict to these asset ids
  --budget <n|provider=n>  Refuse to exceed one provider ceiling; repeat keyed budgets
                           for a mixed-provider run. For gallery: the session ceiling
                           that enables generation from the page
  --provider <id>     Choose the account for balance/adopt/salvage/purge in a mixed manifest
  --force             Regenerate, replace a fetch destination, or rebuild managed output
  --dry-run           Never spend; doctor also skips provider connectivity
  --all               salvage --dry-run: list every unclaimed object, not just the first 30
  --json              Machine-readable output where supported, including quality checks
                      and the gallery snapshot (no server)
  --check             plan/audit/cache: exit nonzero when the selected state is unsafe
  --yes, -y           Skip the confirmation prompt
  --no-open           Do not auto-open the browser (pick, salvage, gallery) or editor (edit)
  --edit              gallery: allow manifest edits from the page (never spends)
  --no-editor         gallery: do not offer or serve the in-browser editor
  --tag               Also push tags upstream after fetch
  --refresh           fetch: re-download and replace files whose object changed
                      upstream (e.g. edited in PixelLab's editor); no generation
  --claims a.json,b   Other projects' lockfiles (salvage; required if account is shared)
  --workspace <path>  Workspace catalog (default: pixelkiln.workspace.json). Also
                       derives salvage's claim set instead of repeated --claims,
                       and switches gallery to every registered project.
  --from <path>       Source for init/path-mode refine, or baseline for quality check
  --write-prompts     adopt: recover prompts into the manifest

Examples
  pixelkiln plan
  pixelkiln gen --style heybud-premium --budget 400
  pixelkiln gen --only first_review --force
  pixelkiln gallery --style heybud-premium
  pixelkiln gallery --workspace pixelkiln.workspace.json
  pixelkiln gallery --edit --budget 80
  pixelkiln edit --style base --only anvil
  pixelkiln tools install editor
  PIXELKILN_EDITOR="open -a Aseprite" pixelkiln edit --only anvil --style base
  pixelkiln adopt --tag
  pixelkiln pack --style heybud-premium
  pixelkiln pack --inputs sprites.json --out dist/sheet   # no manifest needed
  pixelkiln pack --style hero --format aseprite         # sheet JSON engines load
  pixelkiln mount --style ground
  pixelkiln export --style ground --only terrain --format tiled
  pixelkiln refine --style environment
  pixelkiln refine check --style environment
  pixelkiln refine --from source.png --out final.png --palette "#101820,#f2aa4c"
  pixelkiln refine approve --from final.pixelkiln.json --reviewer "Your Name"
  pixelkiln refine check --from final.pixelkiln.json
  pixelkiln recipe list
  pixelkiln recipe install comfyui/pixel-art-xl-environment
  pixelkiln recipe verify pixelkiln-recipes/comfyui/pixel-art-xl-environment/1.0.0 --model-root /path/to/ComfyUI/models
  pixelkiln quality snapshot --inputs quality-inputs.json --out pixelkiln.quality.json
  pixelkiln quality check --from pixelkiln.quality.json
  pixelkiln unzoom --from refs/knight-512.png --out refs/knight.png
  pixelkiln font --description "warm orange arcade font" --weight Bold --out fonts/arcade
  pixelkiln workspace add ../other-game/pixelkiln.manifest.json
  pixelkiln workspace status --json
  pixelkiln salvage --workspace pixelkiln.workspace.json
`
