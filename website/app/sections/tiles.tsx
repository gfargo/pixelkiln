import Image from "next/image";
import { CodeWindow } from "@/app/ui/code-window";
import { CopyCommand } from "@/app/ui/copy-command";
import { TerrainBrush } from "@/app/ui/terrain-brush";
import { TrackedLink } from "@/app/ui/tracked-link";

/** The four surfaces of a coast, as the colors the island map above is drawn in. */
const CHIP = { ocean: "#043862", sand: "#ecc570", grass: "#4c8e29", forest: "#2c4a22" };

/** The engine formats: what each writes, and how it was checked. */
const ENGINES: Array<{ id: string; name: string; file: string; gets: string; checked: string }> = [
  {
    id: "generic",
    name: "Generic JSON",
    file: ".json",
    gets: "The lossless record: the atlas, every tile's rectangle and mask, and the provider's raw rules. For any engine without an exporter.",
    checked: "Round-trip tests.",
  },
  {
    id: "tiled",
    name: "Tiled",
    file: ".tsj",
    gets: "An image tileset with a Wang set, its ids in Tiled's own order. Isometric sets get their diamond grid and the offset that seats each image on it.",
    checked: "Follows Tiled's documented format. Not loaded by Tiled in CI.",
  },
  {
    id: "godot",
    name: "Godot 4",
    file: ".tres",
    gets: "A TileSet with terrain peering bits on every tile. Isometric sets get the diamond as the cell, each image placed on it, and a diamond layout.",
    checked: "A headless Godot 4.7.2 loads it in CI, reads a peering bit and the isometric geometry back, and paints square and isometric corner and edge sets, and the three-terrain coast, with every border compared to the strokes. Drawn in Godot, isometric cells tile exactly.",
  },
  {
    id: "ldtk",
    name: "LDtk",
    file: ".ldtk",
    gets: "A project: the tileset, a paint layer, an auto-rule layer, and a Preview level that uses every rule.",
    checked: "Opened in LDtk 1.5.3, where its own rules redrew the tiles the file stores.",
  },
];

/** Which kind of tile work each generator does, what it makes, and what the measured runs billed. */
const KINDS: Array<{ id: string; name: string; makes: string; cost: string; doc: string }> = [
  {
    id: "terrain",
    name: "terrain",
    makes: "Two surfaces and the border between them, as 16 tiles, or 25 when the walls are tall. Top-down.",
    cost: "Pro: 15 generations at 32px, 25 at 64px. Standard: 1 to 3.",
    doc: "/docs/generators",
  },
  {
    id: "sidescroller",
    name: "terrain, sidescroller",
    makes: "A platform set: a stone or earth body with a grass or snow top, 16 tiles.",
    cost: "1 generation on standard, 15 on pro.",
    doc: "/docs/generators",
  },
  {
    id: "tiles",
    name: "tiles",
    makes: "Independent ground tiles, an 18-piece road set, a 16-tile terrain transition, or a building kit of floors, walls, doors and stairs.",
    cost: "10 to 25 generations.",
    doc: "/docs/generators#tiles",
  },
  {
    id: "isometricTile",
    name: "isometricTile",
    makes: "One block: a raised mesa, a cliff, a floor slab, with the thickness you choose.",
    cost: "1 generation.",
    doc: "/docs/generators#isometrictile",
  },
  {
    id: "import",
    name: "asset import",
    makes: "Your own sheet, cut into tiles and put under the same record, review and export.",
    cost: "Free.",
    doc: "/docs/cli/asset",
  },
];

/** The tiles page: what a tileset is, what it costs, what comes out, and where it goes. */
export function TilesSections() {
  return (
    <>
      <section className="tiles-section" id="sets">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Describe the border. Get the tiles.</h2>
            </div>
            <p className="section-deck">
              A map is drawn from tiles that join. A terrain set is the whole
              family for two surfaces, grass and water, floor and lava, drawn
              together so the corners match, whichever way the border turns.
              Sixteen tiles cover a coast. Twenty-five add the walls when one
              surface stands above the other.
            </p>
          </div>
          <figure className="tiles-sheet">
            {/* Pixel art at its own size; next/image would resample it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/showcase/tilesets/raised-shore.png" alt="Sixteen tiles of grass meeting shallow water along a winding shoreline with a dark raised bank" width={795} height={201} loading="lazy" />
            <figcaption>
              <b>One set, sixteen tiles.</b> Grass to shallow water on 32px
              tiles, with a raised, winding bank. 10 generations.
            </figcaption>
          </figure>
          <TerrainBrush />
          <div className="tiles-maps">
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/showcase/tilesets/island.png" alt="A sandy island with a grass meadow in the middle, surrounded by ocean, edges cut at 45 degrees" width={448} height={320} loading="lazy" />
              <figcaption>
                <b>Two sets that share a terrain.</b> Ocean to sand, then sand
                to grass, which reuses the first set&apos;s sand. 15
                generations each.
              </figcaption>
            </figure>
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/showcase/tilesets/dungeon.png" alt="Dark stone dungeon floors raised over a lava sea, with brick walls dropping into the lava and lava pits cut into the floors" width={512} height={480} loading="lazy" />
              <figcaption>
                <b>One set with tall walls.</b> Dungeon stone over lava at
                64px: 25 tiles, walls included. 25 generations.
              </figcaption>
            </figure>
          </div>
          <ul className="check-list effects-list tiles-points">
            <li><span className="tick" aria-hidden="true" /> A tile records which surface fills each of its four corners, so an engine can pick the right one for any neighbour. PixelKiln keeps that record beside the file.</li>
            <li><span className="tick" aria-hidden="true" /> The set comes from one request, so its tiles are drawn to match. You review the set, not tile by tile.</li>
            <li><span className="tick" aria-hidden="true" /> A set that shares a surface with another waits for it, and goes stale if the first is regenerated.</li>
          </ul>
        </div>
      </section>

      <section className="tiles-section tiles-section-alt" id="kinds">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Pick the kind that fits the map.</h2>
            </div>
            <p className="section-deck">
              Each kind is a generator in the manifest, so <code>plan</code>{" "}
              prices it before anything is sent. The prices below were
              billed in live runs, and the lockfile records what each set
              actually cost.
            </p>
          </div>
          <div className="tiles-kinds">
            <div className="tiles-kind tiles-kind-head" aria-hidden="true">
              <span>Generator</span>
              <span>What it makes</span>
              <span>What it cost</span>
            </div>
            {KINDS.map((kind) => (
              <div className="tiles-kind" key={kind.id}>
                <strong><code>{kind.name}</code></strong>
                <span>{kind.makes}</span>
                <span>{kind.cost}</span>
              </div>
            ))}
          </div>
          <div className="review-links">
            <TrackedLink className="text-link" id="tiles_generators_docs" section="feature_page" href="/docs/generators">
              Compare every generator
            </TrackedLink>
            <TrackedLink className="text-link" id="tiles_costs_docs" section="feature_page" href="/docs/endpoints/tilesets-measured-once-per-kind">
              See what was measured
            </TrackedLink>
          </div>
        </div>
      </section>

      <section className="tiles-section" id="textures">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Bring your own texture.</h2>
            </div>
            <p className="section-deck">
              Give a terrain a PNG and PixelLab uses it almost as the texture
              itself, drawing only the border between. In the test, two
              hand-made 16×16 striped swatches came back as the fill of both
              terrains, stripes intact. Hand it a tile you would be happy to see
              repeated.
            </p>
          </div>
          <div className="tiles-pair">
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/showcase/tilesets/references.png" alt="A sixteen-tile set of teal striped pools in a purple striped floor, beside the two small striped swatches it was made from" width={849} height={169} loading="lazy" />
              <figcaption>
                <b>Your texture, their borders.</b> A standard set from two
                swatches (right). 1 generation.
              </figcaption>
            </figure>
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/showcase/tilesets/sidescroller-modes.png" alt="Two sixteen-tile platform sets: light mossy stonework above, denser earth with a bright grass cap below" width={667} height={345} loading="lazy" />
              <figcaption>
                <b>Platforms, standard above and pro below.</b> The same prompt
                as a sidescroller set on each mode. 1 generation and 15.
              </figcaption>
            </figure>
          </div>
          <div className="effects-bottom fx-top">
            <CodeWindow
              title="pixelkiln.manifest.json"
              language="json"
              copyId="tiles_manifest"
              section="feature_page"
              code={`
"styles": {
  "cave":  { "generator": "terrain", "size": 16, "outDir": "tiles/cave" },
  "ledge": { "generator": "terrain", "size": 16, "outDir": "tiles/ledge",
             "terrainOrientation": "sidescroller" }
},
"assets": {
  "pool": {
    "prompt": "1). teal slime pool 2). purple crystal floor",
    "styles": ["cave"],
    "terrainReferences": { "lower": "refs/slime.png", "upper": "refs/crystal.png" }
  },
  "moss": { "prompt": "1). mossy stone bricks 2). green grass", "styles": ["ledge"] }
}
`}
            />
            <ul className="check-list effects-list">
              <li><span className="tick" aria-hidden="true" /> A reference is hashed into the set&apos;s identity: replace the file and the set is stale, rename it and nothing changes.</li>
              <li><span className="tick" aria-hidden="true" /> A file that changes between <code>plan</code> and <code>gen</code> is refused, so the request always matches what was priced.</li>
              <li><span className="tick" aria-hidden="true" /> Other controls shape the border: <code>tileElevation</code> raises a bank, <code>tileBoundaryAmplitude</code> makes the line meander, and <code>terrainRoundness</code> with <code>terrainConnectDiagonals</code> cuts a coast at 45°.</li>
            </ul>
          </div>
          <div className="review-links">
            <TrackedLink className="text-link" id="tiles_references_docs" section="feature_page" href="/docs/tiles#terrain-reference-images">
              Terrain reference images
            </TrackedLink>
            <TrackedLink className="text-link" id="tiles_fields_docs" section="feature_page" href="/docs/manifest/style-fields">
              Every terrain field
            </TrackedLink>
          </div>
        </div>
      </section>

      <section className="tiles-section" id="isometric">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Isometric, in four kinds.</h2>
            </div>
            <p className="section-deck">
              The same generators draw on a diamond grid when you set{" "}
              <code>tileType: &quot;isometric&quot;</code>. These came from one
              manifest, in one run, and every set below is untouched PixelLab
              output.
            </p>
          </div>
          <figure className="tiles-sheet">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/showcase/isometric/ground-sheet.png" alt="Sixteen isometric blocks of grass and worn cobblestone, each a raised slab with earth showing along its side" width={848} height={176} loading="lazy" />
            <figcaption>
              <b>A terrain set.</b> Short green grass to worn grey cobblestone,
              16 tiles at 32 by 24. Billed 10 generations against a plan of 25.
            </figcaption>
          </figure>
          <figure className="tiles-sheet tiles-sheet-next">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/showcase/isometric/road-sheet.png" alt="Eighteen isometric slabs of grass with a brown dirt road running across them in every junction and turn" width={952} height={224} loading="lazy" />
            <figcaption>
              <b>A road set.</b> A dirt road over grass: every end, turn,
              junction and crossing, 18 tiles at 48 by 48. Isometric roads must
              be 48 to 96px; the API refused 32 before charging anything. Billed 10.
            </figcaption>
          </figure>
          <figure className="tiles-sheet tiles-sheet-next">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/showcase/isometric/hall-sheet.png" alt="Fifty-eight pieces of a grey stone building kit: wall sections, corners, pillars, doorways, stairs and floor slabs" width={1096} height={736} loading="lazy" />
            <figcaption>
              <b>A building kit.</b> A stone hall with a slate roof as 58
              separate pieces: walls, corners, pillars, doorways, stairs and
              floors, each 52 by 58. Billed 10.
            </figcaption>
          </figure>
          <figure className="tiles-sheet tiles-sheet-next">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/showcase/isometric/blocks-sheet.png" alt="Two isometric blocks: earth with a thick grass top, and grey mossy stone bricks" width={360} height={184} loading="lazy" />
            <figcaption>
              <b>Single blocks.</b> <code>isometricTile</code>: one tile per
              prompt, 32 by 32. 1 generation each.
            </figcaption>
          </figure>
          <ul className="check-list effects-list tiles-points">
            <li><span className="tick" aria-hidden="true" /> A tile image is taller than its diamond. The 32 by 24 tiles are a 32 by 16 diamond with 8 rows of side below it, so <code>export</code> finds the diamond and gives Godot its cell and offset, and Tiled its grid, to stand each image on its cell.</li>
            <li><span className="tick" aria-hidden="true" /> The terrain set is corner-ruled and the road set is edge-ruled. Both export to Godot and Tiled. The road set&apos;s four edges are the diamond&apos;s four sides, which we measured on these tiles and checked by painting a road network in Godot.</li>
            <li><span className="tick" aria-hidden="true" /> A building kit has its own rule family, so it exports to the generic file with every rule kept. An engine importer has to place its pieces.</li>
          </ul>
        </div>
      </section>

      <section className="tiles-section tiles-section-alt" id="engines">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Out to Tiled, Godot and LDtk.</h2>
            </div>
            <p className="section-deck">
              A folder of tile images is not a tileset until an engine knows
              which tile goes where. <code>export</code> writes the atlas and
              the placement rules together, so the engine&apos;s terrain brush
              can paint with it. Godot&apos;s was checked by painting.
            </p>
          </div>
          <figure className="tiles-shot">
            <Image src="/showcase/tilesets/ldtk-preview.webp" alt="LDtk open on a generated project: a layer list on the left, and a painted preview of grass islands in a lake, every shore drawn with the right edge tile" width={1600} height={1003} sizes="(max-width: 1280px) 100vw, 1180px" />
            <figcaption>
              <b>The result, opened in LDtk 1.5.3.</b> The Preview level that{" "}
              <code>--format ldtk</code> writes, drawn by the auto-rules the
              export wrote. Pick the corners layer and paint: the shores redraw.
            </figcaption>
          </figure>
          <div className="tiles-kinds tiles-kinds-engines">
            <div className="tiles-kind tiles-kind-head" aria-hidden="true">
              <span>Format</span>
              <span>File</span>
              <span>What you get</span>
              <span>How it was checked</span>
            </div>
            {ENGINES.map((engine) => (
              <div className="tiles-kind" key={engine.id}>
                <strong>{engine.name}</strong>
                <span><code>{engine.file}</code></span>
                <span>{engine.gets}</span>
                <span>{engine.checked}</span>
              </div>
            ))}
          </div>
          <div className="effects-bottom fx-top">
            <CodeWindow
              title="terminal"
              language="shell"
              copyId="tiles_export_commands"
              section="feature_page"
              code={`
pixelkiln plan
pixelkiln gen --budget 15
pixelkiln export --style ground --only terrain --format tiled
pixelkiln export --style ground --only terrain --format godot
pixelkiln export --style ground --only terrain --format ldtk
pixelkiln export --style ground --only terrain --format generic
`}
            />
            <ul className="check-list effects-list">
              <li><span className="tick" aria-hidden="true" /> Each export has a record of its inputs and output hashes. An edited file stops the next export instead of being overwritten.</li>
              <li><span className="tick" aria-hidden="true" /> Fix a tile by hand with <code>pixelkiln edit --only coast --no-open</code>. It copies each tile to <code>edits/</code>, and the next export uses your version and names the files in its record.</li>
              <li><span className="tick" aria-hidden="true" /> Brought your own sheet? <code>asset import</code> cuts it into tiles under the same record and export.</li>
            </ul>
          </div>

          <div className="tiles-merge-wrap" id="merged">
            <h3>One brush for several sets.</h3>
            <div className="tiles-merge">
              <div className="merge-sets" aria-hidden="true">
                {[
                  ["Set 1: coast", "ocean", "sand"],
                  ["Set 2: meadow", "sand", "grass"],
                  ["Set 3: forest", "grass", "forest"],
                ].map(([label, first, second]) => (
                  <div className="merge-set" key={label}>
                    <b>{label}</b>
                    {[first, second].map((name) => (
                      <span className="merge-chip" key={name} style={{ "--chip": CHIP[name as keyof typeof CHIP] } as React.CSSProperties}><i />{name}</span>
                    ))}
                  </div>
                ))}
              </div>
              <span className="merge-arrow" aria-hidden="true">→</span>
              <div className="merge-brush" aria-hidden="true">
                <b>One tileset, four surfaces</b>
                {(["ocean", "sand", "grass", "forest"] as const).map((name) => (
                  <span className="merge-chip" key={name} style={{ "--chip": CHIP[name] } as React.CSSProperties}><i />{name}</span>
                ))}
              </div>
            </div>
            <p className="tiles-merge-copy">
              A coast takes three sets, and each one joins only two surfaces.
              Exported one at a time they are three brushes that do not know
              the sand is the same sand. Add <code>--merge-connected</code> and
              the sets that share a surface come out as one tileset with all
              four. Naming any one set exports the group, and every set in it
              has to be generated first. Surfaces no set joins, ocean against
              grass, leave empty cells where they meet, so plan a set for every
              pair that touches.
            </p>
            <CodeWindow
              title="terminal"
              language="shell"
              copyId="tiles_merge_commands"
              section="feature_page"
              code={`
pixelkiln export --style ground --format tiled --merge-connected
pixelkiln export --style ground --only meadow --format ldtk --merge-connected
`}
            />
          </div>

          <div className="tiles-limits">
            <h3>What it does not do yet.</h3>
            <ul>
              <li>Connected sets export one at a time unless you ask for <code>--merge-connected</code>. A sidescroller set connects only its platform, so it always exports alone.</li>
              <li>Six-edge hex masks stay in the generic JSON, and so do edge masks on oblique tiles for Godot: we have not measured which diagonal each bit means. LDtk takes square tiles only.</li>
              <li>Terrain sets are square, top-down or side-on, because PixelLab&apos;s tileset endpoint has no shape option. Isometric ground comes from <code>tiles</code>, and exports with its diamond geometry. A single raised block is <code>isometricTile</code>.</li>
            </ul>
          </div>
          <div className="review-links">
            <TrackedLink className="text-link" id="tiles_engines_docs" section="feature_page" href="/docs/tiles">
              Tiles and engine exports
            </TrackedLink>
            <TrackedLink className="text-link" id="tiles_connected_docs" section="feature_page" href="/docs/tiles#connected-sets">
              Connected sets
            </TrackedLink>
            <TrackedLink className="text-link" id="tiles_artifacts_docs" section="feature_page" href="/docs/artifacts">
              How exports are recorded
            </TrackedLink>
          </div>
        </div>
      </section>

      <section className="tiles-section" id="try">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Draw a coast. Open it in your engine.</h2>
            </div>
            <p className="section-deck">
              Describe two surfaces, read the price, and export. The first set
              is one command after the plan, and the lockfile records what it
              cost.
            </p>
          </div>
          <div className="tiles-try">
            <CopyCommand command="npm install --save-dev pixelkiln" />
            <CodeWindow
              title="pixelkiln.manifest.json"
              language="json"
              copyId="tiles_first_set"
              section="feature_page"
              code={`
"styles": {
  "ground": { "generator": "terrain", "size": 32, "outDir": "tiles" }
},
"assets": {
  "coast": { "prompt": "1). deep ocean water texture 2). plain smooth sand texture" }
}
`}
            />
            <div className="tiles-try-actions">
              <TrackedLink className="button button-primary" id="tiles_try_getting_started" section="feature_page" href="/docs/getting-started">
                Getting started
              </TrackedLink>
              <TrackedLink className="button button-secondary" id="tiles_try_docs" section="feature_page" href="/docs/tiles">
                Tiles in the docs
              </TrackedLink>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
