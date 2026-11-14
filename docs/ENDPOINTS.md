# Measured PixelLab API reference

Every cost here was **measured against a live Tier 2 account**, not read from
documentation. Where a figure came from docs rather than a meter, it says so.

Source of truth for shapes: `https://api.pixellab.ai/v2/openapi.json`
(139 paths, 95 of them POST, as of 14 November 2026; 79 and 56 when this file
was first written). A concise index lives at `GET /v2/llms.txt`.

Auth is one long-term key for everything: `Authorization: Bearer $PIXELLAB_API_KEY`.

---

## Endpoint families

| Family | Paths | What it covers |
|---|---|---|
| characters | 23 | 4/8-direction characters, portraits, outfit transfer, lip-sync |
| single images | 14 | one-off images, inpaint, resize, rotate, background removal |
| tiles / tilesets | 12 | top-down and sidescroller tilesets, isometric tiles |
| objects | 10 | 1- and 8-direction objects, states, animations |
| animation | 9 | skeleton and text-driven animation, interpolation |
| ui / fonts | 6 | UI panels, pixel fonts |
| account | 5 | balance, listing, tags, background jobs |
| audio | 9 | music (two takes, loops, style and lyrics helpers) and sound effects |

pixelkiln uses the **single images** and **objects** families. The rest are
listed so it is obvious what exists. The per-family counts above date from the
79-path spec and were not recounted when the audio family was added.

---

## Validation ledger

Which PixelLab endpoints PixelKiln calls, and how much is actually known about
each, so live spending can be chosen by risk. Audited 5 November 2026 from
`src/client.ts`, `src/pixellab-vfx.ts`, this file, the other docs, the skill
references, the benchmark and showcase lockfiles, and git history. No PixelLab
call was made for it. Each row is one endpoint (or one tightly coupled family
of paths: a `POST` and the `GET` that polls it). The Evidence is the section
named in the "What is known" cell.

**Status**

- **Measured live**: a real call was billed and the completed response shape
  was seen. The cell says what was measured.
- **Run live, not measured**: it ran against the account, but the bill or a
  variant was not recorded.
- **Mock only**: wrapped and unit-tested against mocked HTTP, with no live run
  in the docs.
- **Schema only**: wrapped from PixelLab's OpenAPI or MCP schema, with no live
  run, and the docs call the completed-job shape or the price a guess.
- **Not wrapped**: PixelLab has it and PixelKiln does not call it.
- **Unknown**: the repo does not establish a status. See [Needs a human
  look](#needs-a-human-look).

**Money at risk** is how much a wrong estimate or an unreadable response could
cost in one call: **Low** up to 3 generations, **Medium** 4 to 15, **High**
over 15, or billed per direction or per batch. Failed requests are not billed,
so a rejected body costs nothing; the exposure is an accepted job that bills
more than planned or finishes in a shape PixelKiln cannot read.

`target_palette` is sent on 17 routes since 0.92.0. Only `imagePro`,
`imageProFlash` and `tiles` ran live with it (each matched the plan); the other
14 are mock only (`objectPro` base, state and `pro` animation, `1dir`, Pro
`terrain`, `uiAsset`, `uiElement`, Pro and Pro Flash character bases, states,
portraits, outfit transfer, `interpolate`, `edit-animation`), and their rows
say so. Since then `objectPro` base, `uiElement`, `interpolate` and
`edit-animation` have each run live (November 2026), but without a palette, so
the palette claim on them is still mock only.

**Free acceptance probe** (November 2026): for 13 of those 14 routes, a request
carrying only a valid four-colour `target_palette` and none of the required
fields was answered with `422`s that named the missing fields and nothing about
`target_palette`, while the same request with an invalid palette (a non-hex
colour, `max_colors` 999) was answered with two `target_palette` errors. So
PixelLab's validator knows the field and its shape on those routes, which a
mocked test cannot show. The probe cannot show that the palette is obeyed or what
the call costs, and a failed validation bills nothing. The 14th route,
`/objects/{id}/animations` (the `objectPro` `pro` animation), has no required
fields, so a palette-only request could have been accepted and billed; it was
not probed.

| Endpoint | PixelKiln feature | Status | What is known (cost / sizes / shape) | Gaps (never seen) | Money at risk |
|---|---|---|---|---|---|
| `GET /balance` | `doctor`, `gen` balance reads, gallery | Measured live | Free. Count is at `subscription.generations` ([Reproducing these numbers](#reproducing-these-numbers)). | Only the subscription shape is documented; a credit-only account's reply is not recorded. | Low |
| `GET /pro-flash/cost` | Pro Flash estimates for `character` and `imageProFlash` | Measured live | Free quote. For `operation=character`: image 5 up to 96px, 6 to 208px, 9 above, plus rotations; two live jobs (7 and 2) billed exactly the quote ([Characters, measured](#characters-measured)). | Quotes for `create`, `edit` and `inpaint` are recorded from PixelLab's MCP `get_pro_flash_capabilities`, not from this route (roadmap, "Pro Flash for plain image create, edit, and inpaint"). | Low |
| `GET /background-jobs/{id}` | every job poll; where the billed amount is read | Measured live | `usage` at the top level and again at `last_response.billing_usage`; confirmed for a `map` object (1), a standard character base (1) and the skeleton jobs ([Limits and billing](#limits-and-billing)). | Jobs are deleted 8 hours after finishing, so a bill not read in time is lost (the v3 base bill was). | Low |
| `POST /create-image-pixflux` | `pixflux` | Measured live | 1 generation, PNG inline, about 10 s; `color_image` is a hard palette lock (130 badges, 65 of 65 in each set) ([Single-image generators, measured](#single-image-generators-measured)). Ran in `benchmarks/provider-environments/pixellab`. | None recorded. | Low |
| `POST /map-objects` (+ `GET /map-objects/{id}`, falling back to `GET /objects`) | `map` | Measured live | 1 generation, job about 30 s; the job record expires after 8 hours but the image survives ([Object lifecycle](#object-lifecycle)). `color_image` returns 500. | The `scene` field (`background_image` + inpainting): "Unverified until a real call is billed" ([GENERATORS.md](./GENERATORS.md), `map`). | Low |
| `POST /generate-image-v2` | `imagePro` | Measured live | A 64×64 call billed 10 (40 before the cut) and 10 again with `target_palette`; the completed job was read and a candidate downloaded through `gen` ([October 2026 Pro price cut](#october-2026-pro-price-cut), [Target palette](#target-palette-target_palette)). | Canvases above 65536px² (15 and 25 tiers) are priced from the shared Pro ladder, not measured here; `reference_images` and `style_image` are unmodeled. | High |
| `POST /create-image-pro-flash` | `imageProFlash` | Measured live | A 32×32 still with a four-colour `target_palette` billed 5, in only those colours (November 2026; [GENERATORS.md](./GENERATORS.md#target-palette)). | Larger canvases (quote 9 at 256px) and the style-image path were never billed. | Medium |
| `POST /edit-image-pro-flash` | revision `engine: "pro-flash"`, `image-to-image` | Mock only | Quote 5 at 64px, provisional, from MCP (roadmap, "Pro Flash for plain image create, edit, and inpaint"). | Never billed; completed-job shape never read live; the `reference` edit method is unmodeled. | Medium |
| `POST /inpaint-image-pro-flash` | revision `engine: "pro-flash"`, `inpaint` | Mock only | Quotes 5 at 64px and 6 at 128px, provisional, from MCP (same roadmap entry). | Never billed; completed-job shape never read live; `context_image` and `output_methods` unmodeled. | Medium |
| `POST /image-to-pixelart-pro-flash` | `pixelkiln pixelate` | Measured live | A 256×256 and a 384×384 render each billed 6; the image is `last_response.images[0]`; the result is opaque on a near-white field ([Image to Pixel Art Pro Flash, measured](#image-to-pixel-art-pro-flash-measured)). | Whether 6 is flat above 384px or with a larger source. | Medium |
| `POST /inpaint-v3` | revision `inpaint` | Measured live | Nine pre-cut points from 32×32 to 512×512 (20 / 25 / 40); after the cut 256, 288, 352 and 384px billed 10, 15, 25, 25. `last_response.image` is a single object ([Limits and billing](#limits-and-billing), [October 2026 Pro price cut](#october-2026-pro-price-cut)). | The 20-to-25 break sits in (65536px², 82944px²] and 25-to-40 in (102400px², 123904px²]; 32px to 128px and 512px were not re-measured after the cut. | High |
| `POST /edit-images-v2` | revision `image-to-image` | Measured live | One 32×32 call billed 20 (before the cut); `images` is an array of `{type, base64, width, height}` ([Limits and billing](#limits-and-billing)). | Nothing above 32×32 and nothing after the cut; the plan borrows `proTierCost`. | High |
| `POST /remove-background` | revision `remove-background` | Measured live | 1 generation, synchronous `{usage, image}`; keeps the palette ([Post-processing utilities, measured](#post-processing-utilities-measured)). Measured as a loose call in the July 2026 reference. | The `complex` task and the foreground text hint (roadmap, "Remove background"). | Low |
| `POST /reduce-colors` | revision `reduce-colors` | Measured live | 0.1 generations at 32×32, balance diff and `usage` agree ([Cleanup tier, measured](#cleanup-tier-measured), September 2026). | Larger canvases; the price of a multi-frame set call is unmeasured. | Low |
| `POST /correct-pixelart` | revision `correct-pixelart` | Measured live | 0.1 generations at 32×32 ([Cleanup tier, measured](#cleanup-tier-measured)). | Larger canvases and multi-frame sets, as above. | Low |
| `POST /unzoom` | `pixelkiln unzoom` | Unknown | "Cost unmeasured; PixelLab's MCP tool description claims 0.1" ([Cleanup tier, measured](#cleanup-tier-measured)). Nothing records a live run. | Everything. | Low |
| `POST /normal-map` | revision `normal-map`, `pixelkiln normal-map` | Measured live | An 8-frame 1304×26 strip and a 64×64 revision each billed 0.5; the map comes back the input's size with matching alpha ([Normal map](#normal-map-post-normal-map-measured-once), October 2026). | The `directx` convention; strips near the 32-frame limit. | Low |
| `POST /generate-ui-v2` | `uiElement` | Measured live | A 32×32 call billed 10 and the review page showed 64 candidates at 32×32 (November 2026, Tier 3; the plan said 1 candidate and now follows `uiElementCandidateCount`). Planned on the 10/15/25 ladder ([GENERATORS.md](./GENERATORS.md#uielement)). `target_palette` sent, mock only. | Other sizes (the 15 and 25 tiers and the other candidate bands, which come from PixelLab's published grid), and the concept-image path. | High |
| `POST /create-1-direction-object` (+ `GET /objects/{id}`) | `1dir` | Measured live | A 32px, 3-description `batch` billed 20 (the pre-cut floor) and `item_descriptions[0]` owned slot 0 ([Candidates](#candidates)); candidate counts follow size. `target_palette` sent, mock only. | No bill since the October 2026 cut (10 / 15 / 25 is PixelLab's published ladder); tiers above the floor under `item_descriptions`. | High |
| `POST /objects/{id}/select-frames` | `1dir` and `batch` pick | Run live, not measured | Promoted three candidates in the live batch run ([Candidates](#candidates)); `indices` is plural. | Its cost was not recorded. | Low |
| `GET /objects?limit=&offset=` | `adopt`, `salvage` | Measured live | Free; a March 2026 sprite still resolved four months on ([Object lifecycle](#object-lifecycle)). | None recorded. | Low |
| `POST /create-object-pro-flash` | `objectPro` base | Measured live | A 32px base billed 6 and returned 8 files at 32×32 (the rotations), matching the plan, which prices it like `character` pro-flash (November 2026, Tier 3; [GENERATORS.md](./GENERATORS.md#objectpro)). `target_palette` sent, mock only. | Other sizes and the 1-generation `reference` path. | Medium |
| `POST /objects/{id}/states` | `objectPro` state | Mock only | Assumed to price like `character` pro-flash; the base ran live, this route did not. `target_palette` sent, mock only. | Price and shape. | Medium |
| `POST /objects/{id}/animations` | `objectPro` animation (`v3`, `pro`) | Mock only | Same assumption as the state row; `pro` mode is documented 10 to 25 per direction. `target_palette` sent on `pro` only, mock only. | Price, shape, per-direction billing. | High |
| `PATCH /objects/{id}/tags`, `PATCH /characters/{id}/tags` | tagging in `fetch`, `adopt`, `salvage` | Unknown | Only the negative is documented: pixflux, pixen and bitforge results "cannot be tagged" ([Object lifecycle](#object-lifecycle)). | A recorded live call. | Low |
| `DELETE /objects/{id}`, `POST /objects/{id}/dismiss-review`, `DELETE /characters/{id}` | `salvage`, account cleanup | Unknown | Not discussed in the docs. | A recorded live call. | Low |
| `DELETE /characters/{id}/animations` | replacing a loop's direction | Unknown | "Deleting one direction of a shared group has not been run live" ([Skeleton-driven motion, measured](#skeleton-driven-motion-measured)). | Whether the rest of the group keeps its motion. | Low |
| `POST /create-tiles-pro` (+ `GET /tiles-pro/{id}`) | `tiles` | Measured live | One numbered description, 4 tiles at 16px, with a Game Boy `target_palette`, billed 10, every candidate in the palette (November 2026). `GET` has no `status`: 423 while drawing ([Tilesets: measured once per kind](#tilesets-measured-once-per-kind)). | `tile_feature` sets (`roads`, `tileset`, `building`) and `tile_rules`; large tile-size × variation canvases that reach the top tier. | High |
| `POST /create-tileset` (+ `GET /tilesets/{id}`) | `terrain`, top-down | Measured live | Pro 32px billed 15 (three sets, one connected through `lower_base_tile_id`, one with edge slope); Pro 64px billed 25 and returned 25 tiles at transition 0.5; standard sets billed 3 each (planned 4), one connected through `upper_base_tile_id` ([Tilesets: measured once per kind](#tilesets-measured-once-per-kind), October 2026). `target_palette` on Pro, mock only. | Pro below 32px; standard above 32px; a standard set cannot connect to a Pro set. | High |
| `POST /create-tileset-sidescroller` | `terrain`, `terrainOrientation: "sidescroller"` | Measured live | One 16px set at transition 0.25 billed 3; 16 tiles; `usage` is null on the `GET`, so the bill comes from the job ([Tilesets: measured once per kind](#tilesets-measured-once-per-kind)). | 32px tiles and other transition sizes (tile counts assumed 16); the call returned `metadata.transition_size: 0.0` for 0.25. | Low |
| `POST /create-isometric-tile` (+ `GET /isometric-tiles/{id}`) | `isometricTile` | Measured live | One 32px `block` billed 1 generation, not the schema's `usd: 0.02` example ([Standalone isometric tile](#standalone-isometric-tile-schema-documented-cost-measured-once)). | Other sizes and shapes; flat pricing across 16 to 64px is an assumption. | Low |
| `POST /create-ui-asset` (+ `GET /ui-assets/{id}`) | `uiAsset` | Measured live | One 256×192 call billed 20, the low end of the quoted 20 to 40; the plan prices 40 ([UI panels](#ui-panels-one-endpoint-schema-documented-cost-unverified), September 2026). | A second size; `pixelkiln plan` over-reads. | High |
| `POST /ui-assets/{id}/split` | `pixelkiln ui split` | Measured live | Free; a 256×192 template split into the 3 elements its `split_preview` listed. A second split is refused client-side ([UI split, states and 9-slice](#ui-split-states-and-9-slice-measured)). | Custom `boxes` are mock only. | Low |
| `POST /ui-assets/states` | `pixelkiln ui states` | Measured live | One 86×38 element in 2 states quoted and billed 10; about a minute. State images differ in size from their element. | The 15 and 25 tiers, several elements in one call, and `target_palette` are mock only. | High |
| `PATCH /ui-assets/{id}` | `pixelkiln ui nine-slice` | Measured live | Free; insets set on an element and returned on the next `GET`. | `clear_nine_slice` and rename are mock only. | Low |
| `POST /generate-font-pro` (+ `GET /generate-font-pro/{id}`) | `pixelkiln font` | Unknown | Documented at 15 since the cut; "its cost is not yet measured" ([Not yet explored](#not-yet-explored)). Nothing records a live run. | Price and the non-`{usage, image}` response shape. | Medium |
| `POST /music` (+ `GET /music/{id}`) | `pixelkiln music` | Measured live | Two instrumental requests billed 10 each, as quoted; two MP3 takes per request, a 60 s request returning 60.6 s and 61.2 s ([Music and sound effects](#music-and-sound-effects-measured)). | Vocals (`lyrics`, `auto_lyrics`), `restyle_song_id`, and lengths above 60 s are mock only. | Medium |
| `POST /music/{id}/loop` | `pixelkiln music --loop`, `--loop-of` | Measured live | One loop billed 4, as quoted; two takes with `loop_start_s`/`loop_end_s`. A 30 s song was refused with a 422 (a loop needs 36 s between intro and ending), unbilled. | The shortest song that loops is bracketed only as above 30 s and at most 60 s. | Medium |
| `POST /music/improve-style`, `POST /music/lyrics` | `pixelkiln music style`, `music lyrics`, `--improve` | Measured live | Each billed 0.05; synchronous. | None known. | Low |
| `POST /sound-effects` (+ `GET /sound-effects/{id}`) | `pixelkiln sfx` | Measured live | A 1 s clip billed 1 and a 3 s clip billed 2, matching 0.614 per second rounded up; 16-bit stereo 44.1 kHz WAV. | The 6 s, 10 s and 30 s steps are PixelLab's published figures, not measured. | Medium |
| `POST /create-character-with-8-directions`, `/create-character-with-4-directions` | `character` base, `mode: standard` | Measured live | 1 generation (read from the job's `usage`); canvas 28px larger than `image_size` ([Limits and billing](#limits-and-billing), [Characters, measured](#characters-measured), September 2026). | The 4-direction body and quadruped templates are not recorded. | Low |
| `POST /create-character-v3` | `character` base, `mode: v3` | Run live, not measured | A base once recorded `billed: {amount: 0, unit: "usd"}` against an estimate of 2 while the submit reported 1 generation; the job had expired, so the real bill is unseen ([Limits and billing](#limits-and-billing)). | The real bill at any size. | Low (Medium at 256px, 9) |
| `POST /create-character-pro` | `character` base, `mode: pro` | Unknown | Planned 10 to 25 by canvas ([GENERATORS.md](./GENERATORS.md)). No bill recorded in the docs. `target_palette` sent, mock only. | Everything. | High |
| `POST /create-character-pro-flash` | `character` base, `mode: pro-flash` | Measured live | Two live jobs (7 and 2, the second from a `reference`) billed exactly the estimate; returns exactly the requested canvas ([Characters, measured](#characters-measured), September 2026). `target_palette` sent, mock only. | Sizes beyond 96px; `source_image_id` and the style-image path. | High |
| `POST /create-character-state` | `character` state | Run live, not measured | A 64px state "moved the balance by about 22 against the 20 to 40 tier", with other jobs running ([Characters, measured](#characters-measured)). `target_palette` sent, mock only. | A clean bill, and any bill since the cut. | High |
| `POST /animate-character`, `mode` template or v3 | `character` loops without skeleton-v3 | Run live, not measured | A v3 text loop on a 96px pro-flash base came back 108×108; template loops need a skeleton template ([Characters, measured](#characters-measured)). Plan: template 1, v3 `ceil(size² × frames / 65536)`. | Billed amounts were not recorded; billed per direction. | High |
| `POST /animate-character`, `mode: pro` | `character` loops, `mode: pro` | Unknown | Planned 10 to 25 by canvas ([GENERATORS.md](./GENERATORS.md)). Nothing records a live run. | Everything. | High |
| `POST /characters/animations`, `mode: skeleton-v3` | `character` loops, `mode: "skeleton-v3"` (template or sentence) | Measured live | On a v3 character: a template loop billed 3; a sentence loop (no template) billed 3, 8 frames at 96×96 from a 64px character; `west` added with `animation_group_id` billed 3 and joined the group. A standard-engine character is refused with a 500 "no stored 3D skeleton" ([Skeleton-driven motion, measured](#skeleton-driven-motion-measured), October 2026). | `pro` and `pro-flash` bases; other frame counts; the price per direction across 8 directions is untested. | High |
| `POST /portrait-character-pro` (+ `GET /portrait-character-pro/{job_id}`) | `character` portrait | Measured live | A 16px `character_to_portrait` billed 20 (before the cut); the `GET` reports `usage: null`, so read the job ([Characters, measured](#characters-measured)). `target_palette` sent, mock only. | The price after the cut (10 to 25); larger sizes. | High |
| `POST /characters/{id}/portrait` | `character` portrait attach | Measured live | Free (`usage.generations: 0`); the reply holds the only copy of the stored URL ([Characters, measured](#characters-measured)). | None recorded. | Low |
| `POST /transfer-outfit-v2` | `character` outfit | Measured live | A 2-frame 92×92 job billed 20 (before the cut); frames return inline in `last_response.quantized_images` ([Characters, measured](#characters-measured)). `target_palette` sent, mock only. | Other frame counts (2 to 16) and canvases; the price after the cut. | High |
| `GET /characters/{id}`, `GET /characters?limit=&offset=` | `adopt`, `fetch --refresh`, `salvage` | Measured live | Free; carries no `usage`; image URLs carry `?t=<updated_at>` ([Object lifecycle](#object-lifecycle)). | None recorded. | Low |
| `POST /animate-with-text-v3` | revision `animate` | Measured live | A 64×64, 4-frame call billed 1 and returned 5 frames at 64×64 (the input frame plus 4); the plan, which borrows `character`'s v3 formula, said 1 (November 2026, Tier 3; [REVISIONS.md](./REVISIONS.md#animation-and-interpolation)). | Other sizes and frame counts (up to 16 frames at 256px reads 16 by the borrowed formula). | Medium |
| `POST /animate-pixminimax` | revision `animate-pixminimax` | Measured live | 64×64 at 8 frames billed 1 and returned 9 frames at 64×64 (the input frame plus 8); at 16 frames billed 2 and returned 17. The plan said 1 for the 16-frame call because its old placeholder under-read; it now follows PixelLab's published table (64×64 at 4 / 8 / 16 / 40 frames: 1 / 1 / 2 / 6), see `pixMiniMaxCost` (November 2026, Tier 3; [roadmap](../skills/pixelkiln/references/pixellab-roadmap.md), "Generated effects with PixMiniMax"). | 40 frames and other sizes are unbilled (the table is PixelLab's, not a bill); `enhance_prompt`'s 0.05 is the schema's number. | Medium |
| `POST /animate-with-skeleton-v3` | revision `animate-skeleton` | Measured live | 8 frames at 64×64 billed 3 and returned 8 frames at 64×64; `description` and `action` are both required, and sent with neither the endpoint returns 422 ([Skeleton-driven motion, measured](#skeleton-driven-motion-measured), October 2026). | Other frame counts (3 = 2 and 15 = 4 are PixelLab's anchors, unbilled). | Low |
| `POST /estimate-skeleton` | `pixelkiln estimate-skeleton`, gallery pose helper | Run live, not measured | Ran on a 64×64 sprite before the 8-frame revision ([REVISIONS.md](./REVISIONS.md#skeleton-driven-animation)). | Its cost; the reply's `usage` is typed `unknown`. | Low |
| `POST /interpolation-v2` | revision `interpolate` | Measured live | A 64×64 start sprite with a `lastFrame` keyframe and the default frame count billed 10 and returned 14 frames at 64×64 (November 2026, Tier 3; [REVISIONS.md](./REVISIONS.md#interpolate-between-two-keyframes)). The planner said 25, a 2.5× over-read, and now prices the canvas on the 10/15/25 ladder. `target_palette` sent, mock only. | Canvases above 65536px² (15 and 25 tiers, unbilled) and other frame counts. | High |
| `POST /edit-animation-v2` | revision `edit-animation` | Measured live | One text edit of a 9-frame 64×64 set billed 10 and the edited set was accepted into review (November 2026, Tier 3). The planner said 25 and now prices the packed grid (nine 64×64 frames: 192×192) on the same ladder. `target_palette` sent, mock only. | Larger sets and canvases, where the packed grid crosses 65536px² (unbilled, assumed to follow the ladder). | High |
| `POST /vfx`, lite artist, no sprite | `pixelkiln vfx --description`, `vfx` block `description` | Measured live | One effect billed 1 (balance 5104 to 5103); 163×26, 8 frames, sheet and atlas cut into 8 correct frames ([VFX artist](#vfx-artist-post-vfx-measured-once), October 2026). | The `files` shape (list or map) is undocumented; PixelKiln reads three. | Low |
| `POST /vfx`, sprite, pro artist, `effect_id` change or `game_pack` | same | Mock only | Quoted from the OpenAPI table: pro 6 (8 with a sprite), 14 and 28 for larger sprites; plans count twice the quote ([VFX artist](#vfx-artist-post-vfx-measured-once)). | Every variant above. | High |
| MCP `tools/call` `vfx_workbench` at `api.pixellab.ai/mcp` | `pixelkiln vfx`, `vfx` block `preset` or `recipe` | Measured live | Free on a subscription; same recipe re-rendered byte-identical; exports a sheet, GIF, atlas and optional game pack ([VFX workbench (MCP only), measured](#vfx-workbench-mcp-only-measured), October 2026). | "Busy, retry" is the only recorded error; sprites by asset are not wired. | Low |
| `POST /create-image-pixen`, `/create-image-bitforge` | none | Not wrapped | Each 1 generation; bitforge returned blobs for a simple prompt ([Single-image generators, measured](#single-image-generators-measured)). | n/a | n/a |
| `POST /rotate`, `/resize`, `/image-to-pixelart` | none | Not wrapped | Each 1 generation; all three break a locked palette ([Post-processing utilities, measured](#post-processing-utilities-measured)). | n/a | n/a |
| `POST /inpaint`, `/edit-image` (not v2 or v3) | none | Not wrapped | "Untouched by any of this" ([Not yet explored](#not-yet-explored)). | n/a | n/a |
| `POST /generate-with-style-v2`, `/image-to-pixelart-pro`, `/create-8-direction-object` | none | Not wrapped | Style transfer at 20 before the cut, not re-measured; `objectPro` covers the 8-direction object. | n/a | n/a |
| `POST /animate-with-text-v2`, `/generate-8-rotations-v2`, `/tilesets`, `/tilesets-sidescroller`, legacy `/animate-with-skeleton` | none | Not wrapped | PixelKiln calls the `/create-tileset*` aliases, not `/tilesets*`; the legacy skeleton route takes exactly 3 frames (roadmap, "The legacy `/animate-with-skeleton`"). | n/a | n/a |
| Character lip-sync, vocal animation, talking GIF, `portrait_to_character` | none | Not wrapped | Named out of scope in [PIXELLAB.md](./PIXELLAB.md). | n/a | n/a |

### Where a wrong guess costs money

The High and Medium rows that are Mock only, Schema only or Run live, not
measured, most exposed first. A live run of the top ones also settles the most
uncertainty per generation.

1. **`/objects/{id}/animations`, `/objects/{id}/states`** (Mock only).
   `objectPro` assumes `character` pro-flash prices; the base ran live and
   matched (6 at 32px), but its `pro` animations are 10 to 25 per direction.
2. **`/animate-character` template and v3** (Run live, not measured). One job
   per direction, so an 8-direction loop is eight bills no one has recorded.
3. **`/create-character-state`** (Run live, not measured). One rough bill
   (about 22) taken beside other jobs and before the cut.
4. **`/vfx` with a sprite, the pro artist, a change or a game pack** (Mock
   only). Up to 28 generations a call, and plans reserve twice the quote.
5. **`/edit-image-pro-flash`, `/inpaint-image-pro-flash`** (Mock only). 5 to 6
   per call on provisional quotes, no completed response seen.
6. **`/create-character-v3`** (Run live, not measured). 2 at 64px, up to 9 at
   256px, and the one recorded bill was an unreadable zero.

Measured in November 2026 and no longer on this list: `/animate-pixminimax`,
`/animate-with-text-v3`, `/interpolation-v2`, `/edit-animation-v2`,
`/generate-ui-v2` and the `objectPro` base. Their remaining exposure is the
sizes and frame counts the row says were not billed. Two of the planners were
wrong: `interpolate` and `edit-animation` over-read 2.5× (25 planned, 10 billed)
and `animate-pixminimax` under-read a 16-frame clip (1 planned, 2 billed). Both
are now calibrated to those bills, and the PixMiniMax planner follows PixelLab's
published points at 4, 8, 16 and 40 frames, which the 40-frame point has not
been billed against.

Also worth a second look because they are measured on an old price list: the
`1dir`, `/portrait-character-pro`, `/transfer-outfit-v2` and `/edit-images-v2`
bills all predate the October 2026 cut, and `/inpaint-v3` was only re-measured
from 256px to 384px.

### Needs a human look

The repo does not establish whether or how these ran live:

- `POST /create-character-pro` and `POST /animate-character` with
  `mode: "pro"`: the docs plan 10 to 25 and record no bill.
- `POST /generate-font-pro`: documented price only (`pixelkiln font`).
- `POST /unzoom`: documented price only (`pixelkiln unzoom`).
- `PATCH` tags on objects and characters, `DELETE /objects/{id}`,
  `DELETE /characters/{id}`, `POST /objects/{id}/dismiss-review`: used by
  `fetch`, `adopt` and `salvage`, and no doc records a live call.
- `DELETE /characters/{id}/animations`: only the one-direction-of-a-shared-group
  case is called out as not run.

### Keeping the ledger current

Update the row in the same change that records a live call. When a call is
billed, take the amount from the finished job's `usage` (or
`last_response.billing_usage`), not from a balance diff taken straight after,
since billing lags; read it before the job record expires 8 hours later. Move
the row's status, write the measurement and its month into "What is known",
and remove the gap it closes. If a call ran but the bill was not captured,
set the row to Run live, not measured rather than leaving it Mock only.

---

## Single-image generators, measured

The endpoints that produce one standalone image. This is the decision that
matters most for icon and prop work.

| Endpoint | Cost | Sync? | Palette | Style ref | Verdict |
|---|---|---|---|---|---|
| `create-image-pixflux` | **1** | sync (~10s) | **yes** | no | **Default for a fixed palette** |
| `create-image-pixen` | **1** | sync (~40s) | no | no | Best raw detail at 1 generation |
| `create-image-bitforge` | **1** | sync (~20s) | yes | yes | Best on paper, poor in practice |
| `map-objects` | **1** | job (~30s) | rejected | no | Fine when the prompt carries the style |
| `create-1-direction-object` | **10–25** | job | no | yes | Only when you need rotations |
| `generate-with-style-v2` (Pro) | **20** | job (~150s) | no | yes | Real style transfer |
| `generate-image-v2` (Pro) | **10–25** | job (~150s) | no | yes | Real style transfer |

`1dir` prices by canvas area: ≤1024 px = 10, ≤2048 px = 15, larger = 25. A
64×64 icon therefore costs 25. These are October 2026 prices; see [the Pro
price cut](#october-2026-pro-price-cut) below for what changed and what was
re-measured. `generate-with-style-v2`'s 20 predates the cut and has not been
re-measured.

`generate-image-v2` was a flat 40 at any size until the cut. It now tiers by
canvas like the other Pro tools: a 64×64 call billed exactly 10.

`generate-image-v2` is wrapped by pixelkiln's `imagePro` generator
(skills/pixelkiln/references/pixellab.md): non-square and larger canvases
than `pixflux` allows, at the 10–25 above. Its `reference_images` and
`style_image` are not modeled. Its completed job was read live (a 64×64
call, October 2026, ran through `gen` and downloaded a picked candidate);
`pollImagePro` in `src/providers/pixellab.ts` still reads it defensively.
`generate-with-style-v2` is not wrapped at all.

### What the measurements actually showed

**`pixflux` is the workhorse.** 1 generation, returns the PNG inline, and its
`color_image` parameter is a genuine constraint. A two-colour palette produced
130 badges containing **only** `#000000` and `#ffffff`, verified 65/65 in each
of two sets. Prose asking for the same thing gave a yellow star and a brown
chocolate bar.

**`bitforge` disappoints.** It is the only single-image endpoint with palette
*and* style reference *and* synchronous delivery, all for 1 generation, which
should make it ideal. In practice it returned unrecognisable blobs for a simple
"blacksmith anvil" prompt at `style_strength` 0, 10, 25 and 50. The first
failure looked like the style reference overwhelming the prompt; sweeping the
strength proved otherwise. Possibly tuned for a different kind of subject (docs
call it "Create S-M image", max area 200×200). **Do not reach for it on this
evidence alone.**

**`pixen` gave the best unconstrained detail** of anything at 1 generation, a
properly rendered anvil with sparks where others produced flat shapes. It has no
palette parameter, so it suits styles carried entirely by the prompt.

**The Pro v2 endpoints do real style transfer**, taking labelled reference
images and matching them convincingly. At 20–40 generations and ~150s they are
for cases where that matters more than throughput.

**`color_image` is not universal.** `map-objects` accepts the parameter in its
schema but returns `500 cannot identify image file` for every payload shape
tried. The palette lock works on `pixflux` and `bitforge` only.

### Payload shapes differ between generations of endpoint

Three incompatible conventions, which is a common source of 422s:

```jsonc
// pixflux / bitforge / map-objects
{ "color_image": { "type": "base64", "base64": "...", "format": "png" } }

// generate-image-v2 (Pro)
{ "style_image": { "image": {...}, "size": {"width":64,"height":64},
                   "usage_description": "art style to match" } }

// generate-with-style-v2 (Pro)
{ "style_images": [ { "image": {...}, "width": 64, "height": 64 } ] }
```

A palette swatch must also be **chunky**: a 4×1 image was rejected outright with
"cannot identify image file", a 64×64 block swatch was accepted.

---

## Post-processing utilities, measured

Five endpoints take an image in and give one back. All are **synchronous**, all
return `{usage, image}` inline, and all cost **1 generation**, including the
ones that sound like pure image manipulation.

| Endpoint | Cost | Palette survives? | What it actually does |
|---|---|---|---|
| `remove-background` | 1 | **yes** | Genuine cleanup, the only safe one |
| `rotate` | 1 | no | Re-renders from a new angle |
| `resize` | 1 | no | **Re-generates**, does not resample |
| `image-to-pixelart` | 1 | no | Destroys alpha too |
| `inpaint` / `edit-image` | 1 | untested | Targeted edits |

Measured on one 64×64 riso badge with an exact 4-colour palette
(`#f4ecd8 #1c1a17 #c1553a #6b7f5e`, 57% transparent):

| | colours out | transparency | result |
|---|---|---|---|
| source | 4 | 0.57 | n/a |
| `remove-background` | **3** | 0.60 | dropped a stray fringe, kept the rest |
| `rotate` | 30 | 0.58 | anti-aliased new angle |
| `resize` → 32px | 38 | 0.57 | cream+rust came back **gold** |
| `image-to-pixelart` → 32px | **455** | **0.00** | opaque grey background |

**`remove-background` also de-fringes.** It removed the
scattered sage-green speckles around the badge outline and left the three real
inks untouched. Colour count went *down*, transparency went *up*. It is the one
utility safe to run on palette-locked art.

**`resize` is generative, not a resampler.** The name is misleading: it takes a
`description` as a *required* field, and it re-renders. A 4-colour cream-and-rust
badge came back as 38 colours of gold.

**`color_image` does not rescue it.** `resize` accepts the parameter in its
schema; passing the exact same swatch that `pixflux` honours changed nothing.
56 colours, still gold. The forced palette works on **`pixflux` and `bitforge`
only**, and being in another endpoint's schema is not evidence it is wired up.

> **Never round-trip palette-locked art through `resize` or `rotate`.**
> Regenerating at the target size with `pixflux` costs the same 1 generation and
> the palette holds exactly.

**`image-to-pixelart` is for photographs and 3-D renders**, not for reprocessing
pixel art. It returned 455 colours on a 4-colour input and flattened the alpha
channel to an opaque grey field. There is no `no_background` parameter to
prevent that.

---

## Cleanup tier, measured

`/reduce-colors` and `/correct-pixelart` are a separate tier from the five
utilities above (PixelLab's own OpenAPI tag: `Cleanup`), synchronous, and
**confirmed at a flat 0.1 generations each** on a 32×32 source, live against a
Tier 2 subscription account (`pixellab balance change: 0.1000000000003638
generations consumed`, floating-point noise aside — same for both calls). The
OpenAPI schema's own response examples are dollar-denominated (`usage:
{type: "usd", usd: 0.005}` for `reduce-colors`, `0.01` for `correct-pixelart`)
and, as with `isometricTile` and `objectPro`, that did not predict real
billing; PixelLab's own MCP tool descriptions claiming a flat 0.1 generations
were the correct source instead. Wired up as the `revision` asset shape's
`reduce-colors`/`correct-pixelart` modes; see [Controlled asset
revisions](./REVISIONS.md#cleanup-reduce-colors-and-correct-pixelart). Only
confirmed at this one size — whether it stays flat at larger canvases (unlike
`inpaint`'s canvas-tiered cost) is not yet known. Multi-frame input (both
endpoints quantize/clean several same-size frames in one call, onto one
shared palette) is now modeled: a revision whose parent is a set sends every
member together; see [Revising a whole set at
once](./REVISIONS.md#revising-a-whole-set-at-once). Its price per call is
unmeasured.

`/unzoom` (same `Cleanup` tag, also synchronous) recovers native-resolution
pixel art from an upscaled image: at least 256×256 in, at most 2048×2048 in
area, and the result is opaque (transparency is composited onto white before
grid detection). PixelLab's own API overview tells integrators to run it on
any user-supplied reference art first. Wired up as `pixelkiln unzoom`, a
standalone command on a loose file rather than a revision mode, since the
art it is for (a reference pulled from outside) is not a manifest asset; see
[the CLI reference](./CLI.md#unzoom). Cost unmeasured; PixelLab's MCP tool
description claims 0.1 generations, the same as the rest of the tier.

---

## Image to Pixel Art Pro Flash, measured

`POST /image-to-pixelart-pro-flash` (added in PixelLab 0.4.128, October
2026) converts a photo, painting, or render into pixel art. Unlike
`image-to-pixelart` above, it takes no size: PixelLab detects the source's
pixel scale and picks the output size. The only other fields are an optional
`description` that steers the style and a `seed`. Sources over 2048px on the
longer side are scaled down upstream.

Measured live, October 2026:

| Source | Description | Output | Billed |
|---|---|---|---|
| 256×256 opaque render (a knight) | none | 108×109, opaque, near-white background | **6** |
| 384×384 opaque render (a mountain keep) | "light dithering" | 84×110, opaque, near-white background | **6** |

- It is a background job. The submit response carries `estimated_generations:
  6`, `pricing_provisional: true`, and `image_id`/`source_image_id` (the result
  is also saved to the PixelLab gallery). `usage` on the submit is null.
- The completed job has `usage: {type: "generations", generations: 6}` and the
  image at `last_response.images[0]` as `{type, base64, width, height}`.
  `last_response.original_images[0]` is the same size, before PixelLab's
  final "touching up pixels" pass. pixelkiln reads `images[0]`.
- **The result is opaque.** Both outputs have every pixel at alpha 255, the
  subject on a near-white field (`#fefefe`). PixelLab's MCP tool for the same
  conversion says transparent source areas become white too. Run
  `remove-background` (1 generation) on the result when you need a cut-out.

Wired up as `pixelkiln pixelate`, a standalone command on a loose file like
`unzoom`; see [the CLI reference](./CLI.md#pixelate). Use `unzoom` instead
for art that is already pixel art and was only upscaled.

---

## October 2026 Pro price cut

PixelLab 0.4.128 (October 2026) cut every Pro tool's price ladder from
20/25/40 to **10/15/25** generations. The release notes give the new tiers
by side: 16–256px is 10, 256–384px is 15, 384–512px is 25. PixelLab's
OpenAPI now quotes "10–25 generations" for 1- and 8-direction objects, Pro
characters, and Pro object animations, and 15 for `generate-font-pro`
(previously 25).

**Only the prices moved, not the breakpoints.** The release notes put
352px and 384px in the middle tier, but both billed the top tier (25) when
re-measured on `inpaint-v3` after the cut, exactly where the old bisection
below put the boundary. pixelkiln's estimates use the new prices on those
measured breakpoints. Every historical measurement on this page that says
20, 25, or 40 predates the cut and is kept as a record.

Re-measured after the cut:

| Endpoint | Canvas | Before | After |
|---|---|---|---|
| `generate-image-v2` | 64×64 | 40 (flat at any size) | **10** |
| `inpaint-v3` | 256×256 | 20 | **10** |
| `inpaint-v3` | 288×288 | 25 | **15** |
| `inpaint-v3` | 352×352 | 40 | **25** |
| `inpaint-v3` | 384×384 | 40 | **25** |

`generate-image-v2` is no longer flat; pixelkiln now prices it with
`proTierCost` (≤65536px² is 10, ≤102400px² is 15, larger is 25), the same
function `inpaint-v3` and `edit-images-v2` revisions use.

---

## Target palette (`target_palette`)

PixelLab 0.4.130 added a beta `target_palette` body field, then gave it to 27
POST endpoints: `{ colors?: 2-256 hex, name?: string (≤100), max_colors?: 2-64,
smart?: boolean }`. With `colors` every pixel is one of them; `max_colors` caps
each image. The schema is documentation only so far: **cost with a palette is
measured for three routes**: `generate-image-v2` (a 64×64 call billed 10, the
same as without), `create-image-pro-flash` (a 32×32 still billed 5) and
`create-tiles-pro` (4 tiles at 16px billed 10), each matching the plan. The
other 14 routes PixelKiln sends it to are mock only. PixelKiln never sends `smart` (beta,
"single images only", needs `colors`, adds 15 to 60 s).

| Endpoint | PixelKiln wrapper | Sent |
|---|---|---|
| `/generate-image-v2` | `imagePro` | yes |
| `/create-image-pro-flash` | `imageProFlash` | yes; the style image's colours give way to it |
| `/create-object-pro-flash` | `objectPro` base | yes |
| `/objects/{id}/states` | `objectPro` state | yes |
| `/objects/{id}/animations` | `objectPro` animation | `pro` mode only (the field is documented for `mode='pro'`) |
| `/create-1-direction-object` | `1dir` | yes |
| `/create-tiles-pro` | `tiles` | yes |
| `/create-tileset` | `terrain` top-down | `terrainMode: "pro"` only ("mode='pro' only"; `color_image` is documented as no effect on standard) |
| `/create-ui-asset`, `/generate-ui-v2` | `uiAsset`, `uiElement` | yes |
| `/create-character-pro`, `/create-character-pro-flash` | `character` Pro and Pro Flash bases | yes |
| `/create-character-state`, `/portrait-character-pro`, `/transfer-outfit-v2` | `character` states, portraits, outfits | yes |
| `/create-character-with-8-directions` | `character` standard base | no: keeps `color_image` + `force_colors`; the field is "mode='pro' only" and this wrapper sends standard |
| `/animate-character`, `/characters/animations` | `character` animations | no: keep the same swatch on every mode; the schema does not say the two combine |
| `/interpolation-v2`, `/edit-animation-v2` | `interpolate`, `edit-animation` revisions | yes |
| `/create-8-direction-object`, `/generate-with-style-v2`, `/image-to-pixelart-pro`, `/animate-with-text-v2`, `/generate-8-rotations-v2`, `/tilesets` | not wrapped | no |
| `/image-to-pixelart-pro-flash` | `pixelkiln pixelate` | no: a loose-file utility with no style, so no palette |

`/create-tileset-sidescroller`, `/create-character-v3`, `/animate-with-text-v3`
and `/animate-pixminimax` have no such field. Every request body is built by
one helper (`targetPaletteBody` in `src/client.ts`), so the field is spelled
once.

---

## UI split, states and 9-slice, measured

Wrapped as the standalone `pixelkiln ui` command ([CLI reference](./CLI.md#ui)).
Measured on 14 November 2026 (Tier 3) against a 256×192 template the
`uiAsset` generator made in September.

| Call | Request | Quoted | Billed | Result |
|---|---|---|---|---|
| `GET /ui-assets/{id}` | an unsplit template | free | 0 | `kind: "template"`, empty `elements`, and a 3-box `split_preview` |
| `POST /ui-assets/{id}/split` | no `boxes` | free | 0 | 3 elements: 166×19, 86×38, 38×38 |
| `PATCH /ui-assets/{id}` | `nine_slice` 8,8,6,6 on the 86×38 element | free | 0 | the asset, with the insets |
| `POST /ui-assets/states` | that element, 2 states | 10 | 10 | 2 state images, 62 s |

What the measurements showed:

- **A split names what the template left unnamed.** `split_preview` labelled
  one box `Button` and left two blank; the elements came back named
  `element 1`, `Button`, `element 3`, with the label moved into `name` and
  `template_box.label` empty on all three.
- **A state is not the size of its element.** The 86×38 element's `hover`
  state is 85×46 and its `pressed` state 82×42. PixelLab draws the states on
  one labelled grid and crops each to its own outline, so a glow grows the
  image and a darker, tighter face shrinks it. A game must anchor states by
  their centre and read each size; `pixelkiln ui pull` records them.
- **The price is on the submit reply, not before it.** `generations` (here 10)
  and `count` arrive with the 202, and the job's `usage` matched. The grid's
  side decides the tier (10 up to 256 px, 15 up to 341, 25 above; each element
  plus an 18 px margin and a 24 px label per state, by PixelLab's description).
  PixelKiln does not reproduce that layout, so `ui states` asks against the 25
  ceiling and prints the quote once it has it.
- A template splits once. PixelKiln checks `elements` first and refuses a
  second split itself, so the API's own answer to one was not observed.
- Split and 9-slice never touched the balance.

Not measured: custom split `boxes`, the 15 and 25 states tiers, several
elements in one states call, `target_palette` on states, clearing a 9-slice,
renaming, and `GET /ui-assets/{id}/zip` (PixelKiln downloads each image from
its own URL instead of the ZIP).

---

## Music and sound effects, measured

Wrapped as the standalone `pixelkiln music` and `pixelkiln sfx` commands
([CLI reference](./CLI.md#music)), outside the manifest: PixelKiln's lockfile
outputs are images. All figures below were billed on a Tier 3 account on 14
November 2026 and read from each finished job's `usage`.

| Call | Request | Quoted | Billed | Result |
|---|---|---|---|---|
| `POST /sound-effects` | 1 s | 1 | 1 | WAV, 1022 ms, 176 KB, about 10 s to make |
| `POST /sound-effects` | 3 s | 2 | 2 | WAV, 2972 ms |
| `POST /music/improve-style` | a three-word idea, `bpm` 96 | none | 0.05 | one paragraph of style text, synchronous |
| `POST /music/lyrics` | one topic | none | 0.05 | two drafts with section tags, synchronous |
| `POST /music` | instrumental, `length_s` 30, `bpm` 100 | 10 | 10 | two MP3 takes (709 KB, 678 KB), 37 s to make |
| `POST /music` | instrumental, `length_s` 60, `bpm` 140 | 10 | 10 | two MP3 takes, 60.6 s and 61.2 s |
| `POST /music/{id}/loop` | the 30 s song | none | 0 | **422**, see below |
| `POST /music/{id}/loop` | the 60 s song | 4 | 4 | two loop takes, 122.2 s and 135.6 s, about 2 minutes to make |

What the measurements showed that PixelLab's docs do not say:

- **A loop needs 36 seconds between the intro and the ending.** Looping the
  30 s song was refused: `422 {"detail": "A loop needs at least 36 seconds of
  music between the intro and the ending; this song has 30. Make a longer song
  to loop."}`. The refusal is free. The shortest song that does loop is
  somewhere above 30 s and no more than 60 s; `music --loop` refuses a
  `--seconds` of 36 or less up front and the docs recommend 60.
- **A loop take is a longer file than its song.** Both loop takes of the 60 s
  song ran about two minutes, with `loop_start_s` 31.65 on both and
  `loop_end_s` 93.23 and 106.60, so the looped region is 62 to 75 s.
- **The submit reply already carries the takes.** `songs` (or `sound_effect`)
  arrives pending with its final id, so each is polled by its own `GET` and
  the background job is read once, at the end, only for the bill.
- **Billing follows the quote.** `quoted_generations` matched the bill on every
  call, and both submit replies and the job agree. Unlike `POST /vfx`, nothing
  here billed above its quote.
- MP3s are 64 kbps, 48 kHz stereo with an ID3v2.4 tag; WAVs are 16-bit stereo
  PCM at 44.1 kHz. Both URLs are no-auth, like every other PixelLab storage
  URL.

Not measured: songs with vocals (`lyrics`, `auto_lyrics`, `voice`),
`restyle_song_id`, `style_weight`, `exclude`, lengths above 60 s, and sound
effects longer than 3 s. Those requests are built from the OpenAPI schema and
covered by mocked tests only. The MCP also exposes rename, delete and list
calls for both libraries (`PATCH`/`DELETE /music/{id}`, `GET /music`, and the
same for `/sound-effects`); PixelKiln does not wrap them.

---

## VFX workbench (MCP only), measured

Create VFX shipped in PixelLab 0.4.128 as a web tool
(`pixellab.ai/create-vfx`). Since October 2026 it is also the
`vfx_workbench` tool on PixelLab's MCP server. The workbench still has **no
REST endpoint**. 0.4.130 added only the paid artist to REST, as `POST /vfx`
([below](#vfx-artist-post-vfx-measured-once)).

**It is a renderer, not a model.** An effect is a JSON recipe of layers
(glows, rings, rays, particles, noise, and more), most of them dropped in as
tuned "parts" with their own sliders. PixelLab renders the recipe to
pixel-art frames, generates nothing, and bills nothing on a subscription.
Rendering is deterministic: the same recipe re-rendered gave a byte-identical
sheet and GIF.

**Calling it.** `POST https://api.pixellab.ai/mcp` with the REST API's own key
as a bearer token, one JSON-RPC `tools/call` per request. No `initialize`
handshake or session id is needed (the server issues none). The reply is a
short server-sent-event stream whose `data:` line holds the JSON-RPC
response; its `content` is plain text plus PNG contact sheets of the frames.

The tool takes one `argv` list per call:

- `start [--preset <name> | --effect <saved id>] [--sprite <image>] [--fps N]`
  returns a step id. `--preset` and `--effect` also print the working recipe
  as one JSON line. `--sprite` accepts base64, a `data:` URL, a URL, or
  `character:<id>:<direction>` / `object:<id>` / `gallery:<id>`.
- `<step> add_part '{"parts": [...]}'`, `set_part`, `remove_part`, `throw`, and
  `render '{"recipe": {...}}'` or `'{"patch": [...]}'` each return a **new**
  step id. Steps are immutable, so an older id is a way back.
- `<step> export --name <n> [--replace <saved id>] [--game-pack]` saves to
  the account's My effects and replies with the effect id, an edit link,
  `<w>x<h>, <n> frames @ <fps> fps, plays once|loops`, the anchor, and a
  download folder listing `<slug>.gif`, `<slug>.png` (sheet), `<slug>.json`
  (an Aseprite/TexturePacker-style atlas with `meta.anchor`), and with
  `--game-pack`, `<slug>-game.zip` (`whole.png`, one sheet per part,
  `manifest.json` with each clip's depth, frames, and offset). The download
  URLs need no auth.
- `describe presets|parts|recipe|edits|...` documents the rest: 17 presets
  and about 90 parts as of October 2026.

**Two gaps a wrapper has to cover:**

- No reply after a part is added prints the recipe, and the exported JSON
  does not carry it. `start --effect <saved id>` does, including slider
  changes made on pixellab.ai, so pixelkiln reads it back from there after
  each export.
- A recipe stores only where the sprite stands (`subject: {x, y, align}`),
  not its pixels, so re-rendering an effect built around a sprite needs the
  sprite sent again.

Wired up as `pixelkiln vfx` for loose files ([the CLI reference](./CLI.md#vfx))
and as the `vfx` manifest generator ([GENERATORS.md](./GENERATORS.md#vfx)),
which cuts the exported sheet into an ordered frame set. The workbench
answers "the pixel tools are busy. retry in a few seconds." while another
render on the account is running; pixelkiln retries that with backoff.

---

## VFX artist (`POST /vfx`), measured once

PixelLab 0.4.130 added "Create VFX" to the REST API: an effects artist (the
website's VFX creator) that builds an effect from a plain-language
description, renders it, checks its own work, and saves it to My effects.
The request and price table come from the OpenAPI document.

**Measured once** (October 2026, Tier 3 account): `pixelkiln vfx
--description "a small orange fireball flying right, flickering flames,
short looping trail" --artist lite`, no sprite. The submit quoted 1
generation and the finished job's `usage` billed exactly 1 (balance 5104
to 5103).
The job finished in about 20 s. `files` held the GIF, the sheet, and the
atlas. The result was a 163×26 canvas, 8 frames at 12 fps, looping, anchor
`origin` at (80, 13), parts `fireball` and `trail`. The sheet is 489×78, a
3×3 grid holding 8 frames, and the atlas is an Aseprite-style `frames` list
with per-frame `frame` rects and 83 ms durations. pixelkiln's slicer cut 8
correct frames from it. A sprite, the pro artist, a change, and the game
pack remain unmeasured.

**Request** (`VfxRequest`): `description` (required, up to 8000 characters;
with `effect_id`, what to change), `sprite` (optional base64 PNG or GIF, up
to 512×512 per frame; an animation is a GIF or a horizontal strip of
`sprite_frames`, 1–32), `sprite_fps` (1–60), `artist` (`lite`, the default,
or `pro`), `effect_id` (change a saved effect in place; it keeps its own
sprite), `conversation` (from a previous result, with its `effect_id`:
priced as a change), `name` (up to 80 characters), and `game_pack`.

**Response.** A 202 with `background_job_id`, `status`, `quoted_generations`,
and `usage`. Poll `GET /background-jobs/{id}` every 5–10 s (PixelLab says
30–90 s usually). A completed job's `last_response` has `files` (no-auth
links: `<name>.gif`, `<name>.png` sheet, `<name>.json` with frames,
durations, `pivot`, and `meta.anchor`, `<name>-game.zip` with `game_pack`,
`<name>-normals.png` when a light made the sprite's normal map), `effect_id`,
`name`, `edit_url`, `message`, `canvas` `{w, h}`, `frames`, `fps`, `loop`,
`anchor` `{kind, x, y}`, `parts`, and `conversation`. The shape of `files`
(a list or a map) is not documented; pixelkiln reads a URL list, a list of
`{name, url}` records, or a name-to-URL map, and fails naming the keys it got
otherwise.

**Errors.** 400 is a request to change (the detail says what), 402 means
insufficient credits, 429 too many concurrent jobs, and 503 the renderer is
busy. The shared HTTP policy retries 429 and 503 with backoff.

**Cost** (generations), quoted at submit and charged on delivery: the quote,
or more when the effect took much longer (the overrun past 25% of the
quote), never more than twice the quote.

| | lite | pro |
|---|---|---|
| new effect, no sprite or up to 128 px | 1 | 6 (8 with a sprite) |
| change (with `conversation`) | 1 | 4 |
| sprite up to 256 px | 3 (change 2) | 14 (change 5) |
| sprite up to 512 px | 5 (change 2) | 28 (change 8) |

An animated sprite adds "a little per frame", unpriced; pixelkiln sends
still PNG sprites only. Plans and `--budget` count twice the quote, the most
a job can bill, and the lock records `quotedGenerations` beside the bill read
from the finished job's `usage`.

Wired up as `pixelkiln vfx --description` ([CLI](./CLI.md#described-effects-paid))
and as a `vfx` block's `description` ([GENERATORS.md](./GENERATORS.md#described-effects-the-paid-vfx-artist)).

---

## Normal map (`POST /normal-map`), measured once

PixelLab 0.4.130. The body is `image` (base64 PNG, 8 to 512px per frame
side; an animation is a horizontal strip), `frames` (1 to 32), and
`convention` (`opengl`, green up, the default; or `directx`). It returns a
background job, and the finished job's `last_response.image` is the map as
a PNG the input's size. PixelLab documents 0.5 generations, charged on
delivery.

**Measured once** (October 2026): `pixelkiln normal-map --frames 8` on a
1304×26 strip of eight 163×26 effect frames billed exactly 0.5 generations
(balance 5103 to 5102.5) and returned a 1304×26 RGBA strip. Its alpha
matched the source's pixel for pixel, so the strip cuts back into the same
8 frames. Wired up as the `normal-map` revision mode and `pixelkiln
normal-map` ([REVISIONS.md](./REVISIONS.md#normal-maps)).

---

## Tilesets: measured once per kind

Called out separately because these are the most capable endpoints for level art
and they are relevant to the disc-golf game. pixelkiln plans a top-down set
at PixelLab's own quote (Pro 15 for tiles up to 32px, 25 at 64px; standard 4,
the top of its quoted 1 to 4). Every kind is measured below: Pro billed
exactly its quote at 32px and 64px, and standard billed 3, under the plan.

`POST /tilesets` (top-down) and `/tilesets-sidescroller` are the current
versions; `/create-tileset*` are the older aliases with identical schemas.
pixelkiln's `terrain` generator
(skills/pixelkiln/references/pixellab.md) calls the aliases, the sidescroller one with
`terrainOrientation: "sidescroller"`; the reference-image/`color_image`
knobs below are not.

They take `lower_description` + `upper_description` (+ optional
`transition_description`). You describe two terrains and the transition between
them, and get a tileset that blends them. Distinctively, they accept **both**
`color_image` *and* per-layer reference images (`lower_reference_image`,
`upper_reference_image`, `transition_reference_image`). They are the only
family that combines palette forcing with style anchoring.

Useful knobs: `tile_size`, `tileset_adherence` / `tileset_adherence_freedom`
(how strictly tiles must fit together), and the usual `outline` / `shading` /
`detail`. Pro's border controls are `raggedness`, `roundness`,
`boundary_amplitude` with `boundary_seed`, `step_slope`, and
`connect_diagonals`; `spread_x` and `slope_size` are documented as "No
effect" now and kept only so existing calls work.

`lower_base_tile_id` / `upper_base_tile_id` connect a new set to another
set's terrain. `GET /tilesets/{id}` (observed live) has a top-level
`metadata.terrain_ids` of `{ "lower": "<uuid>", "upper": "<uuid>" }`: those
are the base tile ids, so set A's `upper` id sent as set B's
`lower_base_tile_id` makes the two share that terrain. pixelkiln records them
as `terrainIds` when it polls a set.

### Pro at 64px, edge slope, and standard sets, measured

A second round on the same showcase project billed 46 generations in all
(balance 5055 to 5009), each set exactly as below:

- `lava-floor`: Pro, 64px, `terrainTransitionSize: 0.5`,
  `terrainRaggedness: 0.4`, `terrainBoundaryAmplitude: 0.15`,
  `terrainBoundarySeed: 3`, prompt `1). glowing lava texture 2). dark dungeon
  stone floor texture 3). crumbling dungeon brick wall`. Billed **exactly
  25** and returned **25 tiles** covering **21** distinct corner
  combinations, which confirms that Pro switches to the tall-wall layout at
  0.5, not only at 1, and that four tiles are corner twins. The third
  description became the brick wall dropping into the lava.
- `swamp-marsh`: Pro, 32px, `terrainTransitionSize: 0.25`,
  `terrainStepSlope: 1.5`, `terrainRaggedness: 0.8`. Billed **exactly 15**,
  16 tiles, with a ragged bank between the water and the marsh grass.
- `lake-grass` and `path-grass`: standard, 32px. Each billed **3**, under the
  planned 4. `path-grass` used `connect: { upper: { of: "lake-grass",
  terrain: "upper" } }`, sent `upper_base_tile_id`, and its recorded
  `terrain_ids.upper` came back identical to `lake-grass`'s upper id. The
  standard sets look flatter, with a hard edge, as PixelLab's tilesets
  tutorial describes.

pixelkiln keeps connected sets in one style, and a style fixes
`terrainMode`, so a standard set cannot connect to a Pro set.

### Pro top-down and a connected pair, measured

October 2026, through `pixelkiln gen` on the website's showcase project
(`website/art/pixellab-0.4.130`). Two Pro sets at 32px with
`terrainRoundness: 2` and `terrainConnectDiagonals: true`:

- `ocean-sand` ("deep ocean water texture" to "plain smooth sand texture")
  billed **exactly 15 generations**, 16 tiles. Its `metadata.terrain_ids`
  held both a `lower` and an `upper` id, recorded as `terrainIds`.
- `sand-grass` ("plain smooth sand texture" to "plain short grass texture")
  with `connect: { lower: { of: "ocean-sand", terrain: "upper" } }` stayed
  blocked until `ocean-sand` was downloaded, then sent `ocean-sand`'s upper
  id as `lower_base_tile_id` and billed **exactly 15**.
- Painted together on one vertex grid, the two sets join at the shared sand
  with matching colour. The second set's sand carries fewer pebbles, so the
  ring where it meets the first set's sand is visible up close. "plain smooth
  sand texture" still came back with pebbles in the first set.

### Sidescroller, measured

One `POST /create-tileset-sidescroller` call, 16px tiles,
`transition_size: 0.25`, `lower_description` "mossy stone bricks texture",
`transition_description` "green grass texture", billed **exactly 3
generations** (balance 5107 to 5104). PixelLab's MCP tool quotes 2 or 3.

- The body has no `mode`, `view`, `upper_description`, or shape controls.
  `tile_size` is 16 or 32 only, `transition_size` one of 0, 0.25, 0.5, 1.
  `lower_base_tile_id` is the only connection field.
- Submit answers `{ tileset_id, background_job_id, status: "processing" }`,
  with `usage: null`.
- `GET /tilesets/{id}` (and `/tilesets-sidescroller/{id}`) returns the
  top-down shape: 16 tiles named `wang_0` to `wang_15`, each with `corners`
  and `pattern_4x4`, images base64 inline. But `tileset.terrain_types` is
  `["central", "background"]` while every corner still says `"lower"` (the
  platform) or `"upper"` (empty, transparent air; the all-upper tile is
  blank). pixelkiln records `["lower", "upper"]` so its corner masks work.
- `metadata.terrain_ids` has `lower` only, and `metadata.view` is `"side"`.
  `metadata.transition_size` came back `0.0` although 0.25 was sent.
- `usage` is null on the GET, so the billed amount comes from
  `GET /background-jobs/{background_job_id}` (`usage.generations: 3.0`).

A trimmed copy of that response is `test/fixtures/tileset/sidescroller-get.json`.

`create-tiles-pro` is a different shape, a single `description` plus
`style_images`, `tile_view`, `building_*` fields for structures.

Its `style_images` is a **fourth** convention, and not the one two lines up:
`TilesProStyleImage` is flat, with all three fields required.

```jsonc
// create-tiles-pro
{ "style_images": [ { "base64": "...", "width": 32, "height": 32 } ] }
```

Sending `generate-with-style-v2`'s nested `{image: {...}}` here is rejected as
an extra field. Passing style images at all makes the endpoint ignore
`tile_type` and `tile_view` and copy the reference's tile geometry instead.
That is the only way to land new art on an existing sheet's ground plane.

`GET /tiles-pro/{id}` carries no `status` field. It answers **423 while the set
is still drawing** and 200 with `storage_urls` when it is done, so the HTTP code
is the status. Cost is reported at submit time and lands on the same canvas
tiers as `1dir` (10/15/25 since the October 2026 cut, 20/25/40 before; a 4-tile
16px set billed 10), but the canvas is tile size x variation count, not one
sprite. A small tile in a large set still reaches the top tier.

All response shapes used by the client are validated at runtime. The TypeScript
interfaces alone are not trusted at the HTTP boundary: missing ids, invalid
object geometry, malformed tile URL maps, or balance fields with changed types
produce an `Invalid PixelLab response` error before pipeline state is updated.

`outline_mode` defaults to `outline`, which draws a dark border around every
tile. For ground tiles that is wrong: laid on a grid the borders read as
quilting, with a seam at every cell edge. `segmentation` omits them and the
same set tiles seamlessly, measured on a fairway-to-rough terrain set, where
it was the difference between usable and unusable.

`tile_feature` and `style_images` are **mutually exclusive**. The API says
"Connectable features (roads/tileset/building) cannot be combined with style
tiles". So the
geometry-anchoring trick above is unavailable for a connectable set, and its
tiles land on whatever ground plane the view angle implies (measured: 32x24
with the diamond midline at y=7, against a 32x32 sheet wanting y=15).

`tile_feature` turns it from independent variations into a connectable set:
`roads` (18-configuration path set), `tileset` (16-tile Wang corner set for a
terrain transition; describe it as the transition, not one terrain), and
`building` (floor/wall/doorway kit). These are sliced by index, so the returned
order is load-bearing. They are structural multi-output results, not candidates
to choose between: PixelKiln persists every URL in numeric order and labels the
downloaded outputs `tile-00`, `tile-01`, … .

The completed response also carries `tile_rules` for connectable sets. Its
placement contract is `rule_type` (`edge`, `corner`, or `outline`), `arity` (4
for square/isometric edges or corners, 6 for hex edges), `connectivity`
(`same`/`other`), two terrain labels, and a `tiles` map of provider tile key to
bitmask. Four-edge masks use N/E/S/W as bits 0/1/2/3. Four-corner masks use
NW/NE/SW/SE as bits 3/2/1/0. Tiles absent from that map are stamp-only. PixelKiln
stores the complete object in `providerMetadata.pixellab.tileRules`; exporters
normalize the documented subset but retain the raw object in the generic file.

Given that `color_image` is honoured on `pixflux` but silently ignored on
`resize`, **verify the palette actually holds on a single tileset before
committing to a set**.

## Standalone isometric tile: schema documented, cost measured once

`POST /create-isometric-tile` (+ `GET`/`DELETE /isometric-tiles/{tile_id}`) is
a *third*, separate path to isometric content, distinct from both
`create-tiles-pro`'s `tile_type: "isometric"` (a full Wang/connectable set)
and the tileset family above (confirmed square-only, no isometric option at
all). This one generates a single standalone tile — no candidates, no
connectable set — and is wrapped by pixelkiln's `isometricTile` generator
(docs/GENERATORS.md).

`isometric_tile_shape` (`"thin tile"` ~15% canvas height, `"thick tile"`
~25%, `"block"` ~50%, the default) is a direct thickness/elevation control,
more granular than anything in `tiles`/`terrain`. `isometric_tile_size` (16
or 32, default 16) is the API's own tile grid, a separate concept from
`image_size` (the generation canvas, 16-64px each side; the endpoint's own
description states "sizes above 24x24 often produce better quality
results"). `outline` defaults to `"lineless"` here specifically — unlike
`create-tiles-pro`'s `"outline"` default — with its own three-value enum
(`"single color outline"`, `"selective outline"`, `"lineless"`); `shading`
and `detail` reuse the same enums as the tileset family above.

`GET /isometric-tiles/{tile_id}` carries no `status` field either: it answers
**423 while still processing** and 200 with the image once done, matching the
tileset family's own polling contract. Unlike every other job resource here,
its response shape is `{ image: Base64Image, usage }` — the finished tile
comes back embedded as base64, not a `storage_urls` link.

**Its own OpenAPI response schema example is misleading on cost.** It shows
`{ type: "usd", usd: 0.02 }`, which reads as billing in real dollars rather
than subscription generations, unlike everything else in this file. A real
call against a live subscription account (Tier 2, "generations" balance)
billed exactly `{ type: "generations", generations: 1 }` instead — the
documented shape never actually appeared. Measured at one size/shape
combination only (32px canvas, `"block"`); the endpoint's own docs give no
size-tiering formula the way `1dir`/`tiles` do, so pixelkiln's
`isometricTileCost()` assumes flat 1-generation pricing across the whole
16-64px range rather than guessing a tier.

`init_image`/`init_image_strength` (image-to-image) and `color_image`
(native forced-palette) both exist on this endpoint and are not modeled by
pixelkiln yet — no `style_images` concept exists here at all, unlike
`create-tiles-pro`.

---

## UI panels: one endpoint, schema documented, cost unverified

`POST /create-ui-asset` (+ `GET`/`DELETE /ui-assets/{id}`, `GET /ui-assets`)
is wrapped by pixelkiln's `uiAsset` generator (docs/GENERATORS.md). A broad
search of the live OpenAPI document for "ui-asset", "element", "split", and
"template" paths found **only these three callable endpoints** — no separate
batch-icon endpoint, no states endpoint, no nine-slice endpoint, contrary to
tutorial-based descriptions elsewhere. (True in September 2026; no longer.)

Request fields: `description`, `image_size` (`{width, height}`, 192-688px per
axis, aspect-gated rather than a free rectangle — square tops out at
512x512, 16:9 at 688x384, 9:16 at 384x688, 4:3 at 600x448, 3:4 at 448x600; a
combination outside these five tiers is rejected or silently resolved to a
different tier's ceiling), `pieces` (an array of `rounded_rect`/`circle`/
`polygon` shapes, each with a unique `id` and optional `label`, positioned on
a virtual 0-512 coordinate canvas independent of `image_size`), `elements`
(named auto-positioned scaffolds — `button`, `icon_button`, `toolbar`, `tab`,
`panel`, `window`, `health_bar`, `avatar`, `triangle`, `pentagon`, `hexagon`,
`octagon`), `style_image` (a single `Base64Image`, unlike most generators'
plural `style_images`), `color_palette` (a free-text prompt-level hint, e.g.
"brown and gold" — pixelkiln's own hex-array `palette` field is a different,
local-quantization concept and is deliberately not sent here), `no_background`,
`seed`.

`POST /create-ui-asset` responds `{ui_asset_id, background_job_id, status,
usage}`. `GET /ui-assets/{id}` responds `{id, prompt, size, image_url
(nullable), status ("processing"|"completed"|"failed"), progress_percent,
eta_seconds}` — **one flat composited image**, confirmed by the schema to
carry no per-piece sub-images, no bounding-box data, and no nine-slice
metadata at all, regardless of how many `pieces`/`elements` the request
listed.

That was the whole surface when this section was written (September 2026).
PixelLab has since added split, states and 9-slice endpoints, and `GET
/ui-assets/{id}` now reports `kind`, `elements`, `states`, `nine_slice` and
`split_preview`; see [UI split, states and 9-slice](#ui-split-states-and-9-slice-measured).
The paragraph above describes the response as it was then.

**Cost: confirmed live at one data point, and it overturned the borrowed
formula.** A real 256x192 (49152px²) call against a Tier 2 subscription
account billed exactly **20 generations** (balance 4979.8 → 4959.8), matching
the low end of the `create_ui_asset` MCP tool description's "20-40
generations" claim. pixelkiln's `generationCost()` has no dedicated branch
for `uiAsset` and falls through to the same canvas-tier formula as
`1dir`/`tiles`, which — given `uiAsset`'s 192px-per-side floor (already
36864px², past that formula's own 2048px² top tier) — always predicts the
40-generation ceiling. The measured call proves that formula wrong for this
generator: 49152px² sits well above the borrowed top tier yet billed the
*floor* price, not the ceiling, so `uiAsset` pricing does not follow
`1dir`/`tiles`' area-based tiers at all. Left unchanged rather than patched
from one data point — over-reading stays the safe direction for `--budget`,
the same policy `tiles`/`terrain` estimates use elsewhere in this file — but
budget a real call at roughly half the number `pixelkiln plan` prints until a
second size is measured.

---

## Recipes

**Lock a palette.** Use `pixflux` with a `color_image` swatch. Build the swatch
with `paletteSwatch()`: 64×64 blocks, one band per colour. It is a real
constraint, not a hint: 130 badges across two sets came back containing *only*
the requested colours.

**Re-roll one bad asset.** 1 generation. `gen --only <id> --force`. Cheaper than
asking for more candidates. A `1dir` call that yields 16 candidates costs 10–25.

**Clean up fringing.** `remove-background` at 1 generation, and it will not
disturb the palette.

**Change the size of an existing asset.** Regenerate with `pixflux` at the new
size. Do not use `resize`.

**Anchor to an existing look rather than a palette.** `generate-with-style-v2`
(20 before the October 2026 cut, not re-measured) or `generate-image-v2`
(10–25). `bitforge` claims to do this for 1, but see
above. `map` has no style anchoring at all. A 1-bit set generated through it
came back with a yellow star and a brown chocolate bar.

**Write prompts for a monochrome style.** Strip colour words from the prompt
itself. "a golden trophy" fights a two-tone palette; the neutral noun does not.
pixelkiln's `promptByStyle` exists for exactly this.

**Never let a device or medium name lead a prompt.** `"Original Game Boy DMG
handheld sprite:"` as a prefix produced drawings of handheld consoles across a
whole set. Put the medium in the *suffix*, after the subject.

**Probe an unfamiliar parameter freely.** Failed generations are not billed.

---

## Candidates

Only `create-1-direction-object` returns multiple candidates, and the count is
derived from size, and cannot be requested:

| size | candidates |
|---|---|
| ≤42 | 64 |
| ≤85 | 16 |
| ≤170 | 4 |
| >170 | 1 |

Cost is per call, so the candidates are free. Counterintuitively, generating
*smaller* yields *more* candidates for *less*. But "pick from 16" is poor value
once a 1-generation re-roll exists: forty re-rolls cost one `1dir` call.

**`item_descriptions` turns those same candidate slots into distinct items,
still free.** Instead of N variations of one prompt, `create-1-direction-object`
takes a per-slot description list and returns N *different* described
objects; `select-frames`'s own `indices` field is already plural — several
candidates, not just one, promote to separate permanent objects in a single
call. Wired up as the `1dir` asset shape's `batch` field; see
[`1dir`](./GENERATORS.md#batch-several-distinct-objects-for-one-calls-cost).
**Confirmed live**: a 32px, 3-description call billed exactly 20 generations
(the ordinary floor tier above, unaffected by `item_descriptions`), and
`item_descriptions[0]` owns candidate slot 0 — a `["a wooden treasure
chest", "a red potion...", "a rusty key..."]` call returned exactly a chest
at frame 0, a potion at frame 1, a key at frame 2. Only confirmed at this
one size; the higher cost tiers are still unconfirmed under
`item_descriptions`.

---

## Object lifecycle

- `1dir` and `8dir` objects **persist** with stable public URLs.
- `map-objects` job records are documented to auto-delete after 8 hours. The
  **image survives**: a March 2026 sprite still resolved from `/v2/objects` four
  months on while `/v2/map-objects/{id}` returned 404. pixelkiln's `poll` checks
  the objects collection on a 404 rather than writing the work off.
- `pixflux`/`pixen`/`bitforge` results are **not account objects** at all.
  Bytes come back inline and are never listed. `adopt` and `salvage` cannot see
  them, and they cannot be tagged.
- Character rotation and frame URLs live at a stable path under
  `backblaze.pixellab.ai/file/pixellab-characters/...` but carry
  `?t=<updated_at as epoch seconds>`, and the response is
  `cache-control: public, max-age=31536000`. The path serves the current
  bytes with any `t` (checked September 2026), but a cache between you and
  the bucket may not, so `fetch --refresh` reads `GET /characters/{id}` for
  the current stamp before comparing. Object URLs carry no stamp.

---

## Limits and billing

- **Submissions must be >2s apart.** Concurrent background jobs: Tier 1 = 8,
  Tier 2 = 10, Tier 3 = 20.
- **Failed generations are not billed.** Two failed forced-palette attempts moved
  the balance by zero, so probing an unfamiliar parameter is free.
- **Billing lags slightly.** A bitforge call read as cost 0 immediately after and
  1 a few seconds later. Trust the `usage` field in the response over an
  immediate balance diff. Confirmed again below: a standard character base's
  balance read unchanged immediately after `getCharacter` reported it complete.
- `usage` is returned inline by the synchronous endpoints:
  `{"type":"generations","generations":1}`.
- **`GET /background-jobs/{id}` carries `usage` on a completed job, at the top
  level and duplicated at `last_response.billing_usage`** (same shape, plus
  `billing_charged: true` on the nested copy); confirmed live for a `map`
  object (1 generation, matched a balance diff taken later) and a standard
  character base (1 generation). The resource-level GET does not: neither
  `GET /objects/{id}`/`GET /map-objects/{id}` nor `GET /characters/{id}`
  carries `usage` once the job is gone, completed or not. `poll` reads the
  object/character for the result but would need this same job id, still
  polled separately today, to learn what it actually cost.
- **A v3 character base once recorded `billed: {amount: 0, unit: "usd"}`**
  against an estimate of 2 generations while the submit reported 1
  generation consumed. Its job record had expired before the shape could be
  read (jobs are deleted 8 hours after finishing, and the lock had dropped
  the job id), so the real `usage` is unseen; `GET /characters/{id}` carries
  none. `poll` now treats a dollar-denominated zero as not known, tries
  `last_response.billing_usage`, and keeps `backgroundJobId` in the
  character's lock metadata.
- **`inpaint-v3` and `edit-images-v2` both confirmed live at their floor
  size**: a 32×32 masked inpaint and a separate 32×32 whole-image edit each
  billed exactly 20 generations, both matching a balance diff taken after.
  `inpaint-v3`'s `last_response` is `{seed, type, image: {type, base64,
  width, height}, action, progress, billing_usage, generation_id,
  usage_cost_usd, billing_charged, generation_mode: "inpainting_v3",
  quantized_image: {type, base64, width, height}, generation_started_at,
  original_image_n_colors, quantized_image_n_colors}`. `edit-images-v2`'s is
  the same shape except **plural and array-wrapped**: `images: [{type,
  base64, width, height}]` and `quantized_images: [...]` in place of
  `image`/`quantized_image`, and `generation_mode: "edit_images"` — the
  request's own `edit_images` array (which supports several images per call)
  carries through to the response even though pixelkiln always sends and
  reads exactly one. In both, the first field is the edited result and the
  quantized one an automatically color-reduced copy pixelkiln does not read.
  `inpaint-v3` is now also confirmed at the opposite end: a live 512×512
  masked inpaint (the maximum the endpoint accepts) billed exactly 40
  generations, response shape identical in structure to the 32×32 case.
  **Seven more points, bisecting from both sides, disprove the borrowed
  tiering's breakpoints entirely and tightly bracket `inpaint-v3`'s real
  20/25/40 structure**: 40×40 (1600px²), 128×128 (16384px²), and 256×256
  (65536px²) all billed **20** (the borrowed model predicts 25 for
  1600px²); 288×288 (82944px²) and 320×320 (102400px²) both billed **25**
  — the middle tier is real, just starting far higher than the borrowed
  model's 1024px²; 352×352 (123904px²) and 384×384 (147456px²) both billed
  **40**. Nine points now read 1024px²→20, 1600px²→20, 16384px²→20,
  65536px²→20, 82944px²→25, 102400px²→25, 123904px²→40, 147456px²→40,
  262144px²→40. Both breakpoints are now tightly bracketed: 20→25 sits
  somewhere in (65536px², 82944px²] — a 1.27x range — and 25→40 somewhere
  in (102400px², 123904px²] — a 1.21x range. Every point at or above
  2048px² falls into `generationCost`'s `else` branch and returns 40
  regardless: correct for 352×352, 384×384, and 512×512, but a full-tier
  overestimate for 288×288 and 320×320 (predicts 40, actually 25) — still
  safe (never bills more than predicted), just a larger miss than the
  earlier single-tier gap. `edit-images-v2` beyond its own 32×32 floor
  remains completely unmeasured.

---

## Not yet explored

Listed so the gaps are known rather than assumed away:

- `edit-images-v2` and `inpaint-v3` (the `revision` asset shape's
  `image-to-image` and `inpaint` modes; see
  [Controlled asset revisions](./REVISIONS.md)) are confirmed at their floor
  and ceiling sizes; `inpaint-v3` is further confirmed to have a real
  middle (25-generation) tier, just far above where the borrowed tiering
  places it, and bisection has tightly bracketed both real breakpoints
  (see above): 20→25 in (65536px², 82944px²] and 25→40 in
  (102400px², 123904px²]. Exactly where in either range is still
  unconfirmed, and `edit-images-v2` beyond its own floor is unmeasured
  entirely. The older
  `inpaint` and `edit-image` (non-v2/v3)
  endpoints are untouched by any of this. All four accept
  `color_image`, but given that
  `resize` accepts and ignores it, assume nothing until measured.
- `/animate-with-text-v3` and `/animate-pixminimax` — animating any loose
  image from a text description, no `character`/`objectPro` resource
  required — are now wired up as the `revision` asset shape's `animate` and
  `animate-pixminimax` modes; see
  [Animation and interpolation](./REVISIONS.md#animation-and-interpolation).
  `/interpolation-v2` ("Interpolate (Pro)", in-betweens from one keyframe to
  another) and `/edit-animation-v2` ("Edit animation (Pro)", one text edit
  across every frame of a set) are wired the same way, as the `interpolate`
  and `edit-animation` modes; see
  [Interpolate between two keyframes](./REVISIONS.md#interpolate-between-two-keyframes).
  All four ran live in November 2026 (Tier 3): 64×64 PixMiniMax at 8 and 16
  frames billed 1 and 2, `animate-with-text-v3` at 4 frames billed 1,
  `interpolate` billed 10, and `edit-animation` of a 9-frame set billed 10.
  Every completed job was read correctly. PixMiniMax returned the frame count
  plus the input frame (9 and 17 frames); `interpolate` returned 14 frames at
  the default count. Cost: `animate` borrows `character`'s measured v3-loop
  formula; `animate-pixminimax` follows PixelLab's published table, which the
  borrowed formula under-read; `interpolate` and `edit-animation` price the
  canvas on the 10/15/25 Pro ladder (the planner had read them as 25).
- `/generate-font-pro` (+ `GET /generate-font-pro/{job_id}`) — an 80-glyph
  atlas PNG plus a `.ttf` from a style description, `weight`
  (`Bold`/`Regular`), and `glyph_px` (8/16/32/64). Documented at 15
  generations since the October 2026 cut (25 before), unmeasured. Wired up as `pixelkiln font`, outside the
  manifest; see [the CLI reference](./CLI.md#font).
- Everything else PixelLab's own tutorials demonstrate that this file has no
  entry for at all — "animation to animation" motion transfer,
  skeleton-animation's rig/template-style controls, Object Creator, and Map
  Workshop scene composition — is cataloged with tutorial citations in
  [references/pixellab-roadmap.md](../skills/pixelkiln/references/pixellab-roadmap.md)
  rather than duplicated here, since none of it has been measured either.
  UI-kit generation is covered above (`create-ui-asset` is now wrapped as the
  `uiAsset` generator; cost confirmed live at one data point, 20 generations
  for a 256x192 canvas).
- `image-to-pixelart-pro` takes only `image` + `description`, no size fields.
  The non-Pro version is characterised above, and the Pro Flash version,
  which pixelkiln wraps, [below](#image-to-pixel-art-pro-flash-measured).
- `generate-font-pro`, job-based, with a response shape not in the simple
  `{usage, image}` form (wrapped by `pixelkiln font`, but its cost is not
  yet measured)
- the character family beyond what the `character` generator uses: lip-sync,
  `portrait_to_character` (a full character from a bust),
  and `source_image_id` on Pro Flash. The four creation engines, states,
  `animate-character`, portraits, and outfit transfer are covered in full; see
  the September 2026 measurements below.

## Skeleton-driven motion, measured

October 2026, on a v3 character (64×64, `pixen_v3`), each billed exactly 3
generations and finished in about two minutes:

- **`POST /animate-with-skeleton-v3`** (pixelkiln's `animate-skeleton`):
  8 hand-edited poses on a 64×64 sprite returned 8 frames at 64×64, matching
  PixelLab's anchor (8 frames = 3). `description` and `action` are both
  required. Sent with neither, the endpoint answers `422` with a field
  error for each, and a failed request bills nothing. The completed job's
  `last_response` carries `images` (base64, `width`, `height`), `flow_kind`,
  and `billing_usage` beside the top-level `usage`.
- **`POST /characters/animations`, `mode: "skeleton-v3"` with a
  `template_animation_id`** (a template `skeleton-v3` loop): one loop on a v3
  character billed 3, inside PixelLab's quoted 2 to 4.
- **`POST /characters/animations`, `mode: "skeleton-v3"` with no
  `template_animation_id`** (PixelLab's new custom motion): a one-sentence
  `action_description` and `frame_count` 8 returned 8 frames at **96×96**
  (the character's own canvas grows from 64) in one job for `south`, saved
  onto the character as an animation (`animation_id`, `animation_group_id`),
  and billed 3. The submit answers `{ background_job_ids, directions,
  animation_group_id, status, enhanced_prompt, enhance_usage }`. The finished
  job's `last_response` has `images`, `storage_urls.frames`,
  `generation_model: "skeleton-v3_custom"`, `animation_description`, and
  `billing_usage: {usd: 0, type: "generations", generations: 3}`, the same
  nested field as the other character jobs, which is where `poll` looks when
  the top-level amount is a dollar zero. PixelLab says the action is written
  into one 3D motion that every direction is drawn from, so later directions
  added with `animation_group_id` move the same way (humanoids). pixelkiln
  sends this mode for a character loop with `mode: "skeleton-v3"`, a prompt,
  and no template (docs/CHARACTERS.md, "Loops from a sentence"), one request
  per direction asset. The first direction of a `directions` loop is sent
  without `animation_group_id`; each later one is sent after it with the
  leader's recorded `animation_group_id` and the group's own `animation_name`
  (not inherited, so omitting it would rename the group). That append was
  **verified live once** (October 2026): adding `west` to a generated `south`
  loop sent the leader's `animation_group_id` and `animation_name`, the submit
  and the finished job both answered with that same group, the job billed 3,
  and `GET /characters/{id}` then listed the group under the leader's name
  with `directions` `south` and `west` (each animation there is
  `{ display_name, animation_group_id, directions: { <direction>: ... } }`),
  with the character's other animations untouched. Deleting one direction of
  a shared group has not been run live. Verified live twice
  with one south direction on a v3 character, once by a direct call and once
  through `pixelkiln gen` (a manifest loop on an `adopt`ed character, 8
  frames at 96×96, billed 3, then `pick` and `fetch`); a standard-engine
  character is refused (`has no stored 3D skeleton`).

## Characters, measured

- Standard bases draw on a canvas 28px larger than `image_size` (64 → 92,
  104 → 132). A `directions` reference is placed on it as is, centred, pixel
  for pixel.
- Pro Flash returns exactly the requested canvas, and refuses a `style_image`
  larger than it ("Style image must fit the native canvas"). Its
  `/pro-flash/cost` answer for `operation=character` was `image` 5 up to 96px,
  6 from 100 to 208px, 9 at 224px and above, plus `rotations` equal to v3's
  `ceil(side² × 8 / 65536)` on the padded square canvas; two live jobs (7 and
  2) billed exactly the estimate. `first_frame` bills the rotations only.
- A 64px `create-character-state` moved the balance by about 22 against the
  20 to 40 tier documented; other jobs were running on the account, so it is a
  rough number.
- `animate-character` with `custom_start_frame` and `end_frame` may return
  frames taller than the rotation (92 × 104 for a crouch). `enhance_prompt`
  writes the expanded text into the animation's `animation_type`. A v3 text
  loop on a 96px pro-flash base came back at 108 × 108.
- Template loops need a skeleton template. On a pro-flash base with
  `template_id: custom` a `walking-8-frames` job failed upstream at once; on
  a round robot fitted to `mannequin` the same template returned a different,
  humanoid character standing nearly still. A v3 text loop ("walking forward
  in place, short legs stepping") kept the robot and walked. For anything
  that is not a biped or one of the four quadrupeds, animate from text.
- Request validation is strict: an unknown body field is a 422 listing every
  problem at once, which is a free way to check a body's shape.
- **`portrait-character-pro`** (`direction: character_to_portrait`, a full-body
  sprite in, a bust out) is job-based: `POST` returns `background_job_id`,
  `GET /portrait-character-pro/{job_id}` answers 423 while drawing and, once
  `status: "completed"`, a `download_url` (its own `usage` is always `null`;
  read the billed amount from `GET /background-jobs/{background_job_id}`
  instead, same as every other job here). Not the couple-generations
  "conversion" the name suggests: the smallest `result_size` (16px) billed
  **20 generations**, the same order of magnitude as a state or `1dir`.
  `POST /characters/{id}/portrait` (attaching a portrait image to a character
  record) is a separate, synchronous, **free** call (`usage.generations: 0`);
  its response is the only place the stored portrait's URL appears; the
  character's own `GET /characters/{id}` never gains a portrait field, so
  PixelKiln has to remember the URL itself. `character_to_portrait` and
  `SetPortrait` are two independent calls with no automatic link between them.
- **`transfer-outfit-v2`** (a reference outfit image plus 2–16 existing
  frames back wearing it) is job-based the same way, polled through
  `GET /background-jobs/{id}` only (no dedicated status endpoint). A 2-frame,
  92×92 job billed **20 generations** — again a real generation cost, not a
  cheap frame edit. The completed job returns the result frames inline as
  base64 in `last_response.quantized_images`, not as storage URLs like every
  other multi-frame result here.

---

## Reproducing these numbers

```bash
curl -s -H "Authorization: Bearer $PIXELLAB_API_KEY" \
  https://api.pixellab.ai/v2/balance
```

The count lives at **`subscription.generations`**, not at the top level. A
probe reading `.generations` gets `undefined` and silently reports every cost as
`NaN` rather than failing:

```jsonc
{ "credits":      { "type": "usd", "usd": 0.0 },
  "subscription": { "type": "generations", "status": "active",
                    "plan": "Tier 2: Pixel Artisan",
                    "generations": 1281.0, "total": 5000.0 } }
```

Take a balance reading, make one call, wait a few seconds, read again. Prefer
the response's `usage` field where present. It is inline, exact, and immune to
the billing lag.
