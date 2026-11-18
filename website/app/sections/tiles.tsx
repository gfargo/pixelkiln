import { CodeWindow } from "@/app/ui/code-window";
import { TrackedLink } from "@/app/ui/tracked-link";

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
            <li><span className="tick" aria-hidden="true" /> A tile records which surface fills each of its four corners, so a map engine can pick the right one for any neighbour. PixelKiln keeps that record beside the file.</li>
            <li><span className="tick" aria-hidden="true" /> The set comes from one request, so its tiles are drawn to match each other. You review the set, not tile by tile.</li>
            <li><span className="tick" aria-hidden="true" /> A set that shares a surface with another waits for it, sends its id, and goes stale if the first set is regenerated.</li>
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

      <section className="tiles-section tiles-section-alt" id="engines">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Out to Tiled, Godot and LDtk.</h2>
            </div>
            <p className="section-deck">
              A folder of tile images is not a tileset until an engine knows
              which tile goes where. <code>export</code> writes the atlas and
              the placement rules together, so the terrain brush works the
              first time you open it.
            </p>
          </div>
          <div className="effects-bottom">
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
pixelkiln export --style ground --format tiled --merge-connected
`}
            />
            <ul className="check-list effects-list">
              <li><span className="tick" aria-hidden="true" /> <b>Tiled:</b> a <code>.tsj</code> tileset with a Wang set, its ids in Tiled&apos;s own order.</li>
              <li><span className="tick" aria-hidden="true" /> <b>Godot 4:</b> a <code>.tres</code> TileSet with terrain peering bits on every tile. A headless Godot 4.7.2 loads it in CI and reads a peering bit back.</li>
              <li><span className="tick" aria-hidden="true" /> <b>LDtk:</b> a <code>.ldtk</code> project with the tileset, a paint layer and an auto-rule layer, and a small Preview level that uses every rule. Corner sets paint on a grid shifted half a tile, so the brush works on the corners. LDtk 1.5.3 redrew the same tiles from the rules when we opened one.</li>
              <li><span className="tick" aria-hidden="true" /> <b>Anything else:</b> generic JSON with the atlas, each tile&apos;s rectangle and mask, and the provider&apos;s raw rules, for an importer of your own.</li>
              <li><span className="tick" aria-hidden="true" /> <b>Connected sets:</b> add <code>--merge-connected</code> and the sets that share a surface export as one tileset. Ocean to sand, sand to grass and grass to forest become one Tiled Wang set, Godot terrain set or LDtk layer with four surfaces.</li>
              <li><span className="tick" aria-hidden="true" /> Each export has a record of its inputs and output hashes. An edited file stops the next export instead of being overwritten.</li>
            </ul>
          </div>
          <div className="tiles-limits">
            <h3>What it does not do yet.</h3>
            <ul>
              <li>Connected sets export one at a time unless you ask for <code>--merge-connected</code>. A sidescroller set connects only its platform, so it always exports alone.</li>
              <li>Six-edge hex masks stay in the generic JSON. Edge masks on isometric tiles do too, for Godot. LDtk takes square tiles only.</li>
              <li>Terrain sets are always square and top-down or side-on. Isometric ground comes from <code>tiles</code> or <code>isometricTile</code>.</li>
            </ul>
          </div>
          <div className="review-links">
            <TrackedLink className="text-link" id="tiles_engines_docs" section="feature_page" href="/docs/tiles">
              Tiles and engine exports
            </TrackedLink>
            <TrackedLink className="text-link" id="tiles_artifacts_docs" section="feature_page" href="/docs/artifacts">
              How exports are recorded
            </TrackedLink>
          </div>
        </div>
      </section>
    </>
  );
}
