import { CodeWindow } from "@/app/ui/code-window";
import { SpriteLoop } from "@/app/ui/sprite-loop";
import { TrackedLink } from "@/app/ui/tracked-link";

/** Strips rendered by `pixelkiln vfx --lib pixelfx` at 12 fps, each frame padded to a square cell. */
const LOCAL_EFFECTS = [
  { id: "fire/torch", strip: "/effects/pixelfx-torch.png", cell: 120, frames: 24, scale: 2, note: "loops, pivot on the wall bracket", label: "A wall torch with a flickering flame, smoke and embers" },
  { id: "lightning/spark-arc", strip: "/effects/pixelfx-spark-arc.png", cell: 124, frames: 24, scale: 2, note: "loops, pivot on the ground", label: "Electric arcs jumping between two contacts" },
  { id: "spawn/poof", strip: "/effects/pixelfx-poof.png", cell: 112, frames: 20, scale: 2, note: "plays once, pivot at the feet", label: "A puff of smoke and stars" },
  { id: "pickups/coin-spin", strip: "/effects/pixelfx-coin.png", cell: 56, frames: 19, scale: 3, note: "loops, pivot under the coin", label: "A spinning gold coin" },
] as const;

const CONTROLS: Array<[string, string, string]> = [
  ["List what exists", "`vfx presets`, `vfx parts`", "`vfx effects` (add `--json` for every option and default)"],
  ["Pick the effect", "`--preset <name>`, plus `--part <name>` as often as you like", "`--effect <category>/<name>`"],
  ["Build it around a sprite", "`--sprite <file | URL | character:<id>:<dir>>`", "Not available: effects stand alone and are placed by their pivot"],
  ["Colors", "Sliders on pixellab.ai, pulled back with `--effect <id> --force`", "`--palette \"#102,#43a,#8cf,#fff\"`, a ramp from dark to bright"],
  ["Variation", "Part sliders in the saved effect", "`--seed <n>`"],
  ["Speed", "`--fps <n>`, 1 to 60", "`--fps <n>`, 1 to 60; sets the frame count too"],
  ["Canvas", "Set by the preset and the sprite", "The effect's own size; `--margin <px>` adds transparent space around it"],
  ["Render it again", "`--recipe <base>.vfx.json`", "`--recipe <base>.vfx.json`, no `--lib` needed"],
  ["Extra files", "`<base>.gif`, and `--game-pack` for one clip per layer", "None: no GIF is written"],
  ["Needs", "`PIXELLAB_API_KEY` and a subscription; free to render", "`npm i github:patch-gg/pixelfx`; no key, no network"],
];

/** Text with `code` spans marked by backticks. */
function Marked({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}
    </>
  );
}

/** The reference half of the effects page: where an effect goes, its controls, its files, and the library calls. */
export function EffectsGuideSections() {
  return (
    <>
      <section className="fx-section fx-section-alt" id="placement">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Around a sprite, or on its own.</h2>
            </div>
            <p className="section-deck">
              An effect reaches your game one of two ways. Which one you pick
              decides whether it knows about the character or object under it.
            </p>
          </div>
          <div className="fx-ways">
            <article>
              <h3>Built around a sprite</h3>
              <p>
                Give PixelLab&apos;s workbench a <code>--sprite</code> and the
                effect is drawn to fit it: an aura follows its outline, a
                shield wraps it, lightning lands on it. The sprite can be a
                character or an object, as a local PNG, a URL, or a PixelLab
                reference such as <code>character:&lt;id&gt;:south</code>.
              </p>
              <ul className="check-list effects-list">
                <li><span className="tick" aria-hidden="true" /> The sheet and GIF show the sprite with the effect behind and in front of it, as in the four above.</li>
                <li><span className="tick" aria-hidden="true" /> <code>--game-pack</code> also writes each layer as its own clip, with a manifest of its depth and offset, so your game can draw its own animated sprite between them.</li>
                <li><span className="tick" aria-hidden="true" /> The paid artist (<code>--description</code>) takes a walk or attack strip and builds the effect around every frame.</li>
              </ul>
            </article>
            <article>
              <h3>On its own, placed by a pivot</h3>
              <p>
                Leave the sprite out, or render from the pixelfx library, and
                you get the effect alone on transparency. Its atlas names one
                point, the pivot, in <code>meta.anchor</code>. Your game puts
                that point where the effect belongs.
              </p>
              <ul className="check-list effects-list">
                <li><span className="tick" aria-hidden="true" /> It works over a character, an object, a tile, or the UI alike, because it knows nothing about what is under it.</li>
                <li><span className="tick" aria-hidden="true" /> Typical pivots: a character&apos;s feet for a spawn puff, a hand or muzzle for a shot, the point of contact for a hit, a wall tile for a torch.</li>
                <li><span className="tick" aria-hidden="true" /> pixelfx effects that need a body to wrap (burning, frozen, whole attack moves) are not rendered yet; use the workbench with <code>--sprite</code> for those.</li>
              </ul>
            </article>
          </div>
        </div>
      </section>

      <section className="fx-section" id="local">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Or render them on your own machine.</h2>
            </div>
            <p className="section-deck">
              <code>--lib pixelfx</code> draws from{" "}
              <TrackedLink id="effects_pixelfx_repo" section="effects" href="https://github.com/patch-gg/pixelfx">pixelfx</TrackedLink>,
              an MIT-licensed library of code-drawn effects by Patch. No key,
              no network, no cost. Its randomness is seeded, so the same recipe
              writes the same bytes every time.
            </p>
          </div>
          <div className="effects-strip">
            {LOCAL_EFFECTS.map((effect) => (
              <figure key={effect.id}>
                <div className="fx-stage">
                  <SpriteLoop
                    strip={effect.strip}
                    width={effect.cell * effect.frames}
                    frames={effect.frames}
                    cell={effect.cell}
                    stride={effect.cell}
                    scale={effect.scale}
                    seconds={effect.frames / 12}
                    label={effect.label}
                  />
                </div>
                <figcaption><b>{effect.id}</b> {effect.note}</figcaption>
              </figure>
            ))}
          </div>
          <div className="effects-bottom">
            <CodeWindow
              title="terminal"
              language="shell"
              copyId="effects_pixelfx_commands"
              section="effects"
              code={`
npm i github:patch-gg/pixelfx
pixelkiln vfx effects
pixelkiln vfx --lib pixelfx --effect fire/torch --fps 12 --out fx/torch
# writes fx/torch.png  .json  .vfx.json

pixelkiln vfx --recipe fx/torch.vfx.json --out fx/torch-again
`}
            />
            <ul className="check-list effects-list">
              <li><span className="tick" aria-hidden="true" /> 171 standalone effects in 18 categories: fire, explosions, water, ice, lightning, impacts, projectiles, pickups, weather, critters.</li>
              <li><span className="tick" aria-hidden="true" /> <code>--palette</code> swaps an effect&apos;s color ramp for yours; <code>--seed</code> rolls it differently.</li>
              <li><span className="tick" aria-hidden="true" /> pixelfx is not on the npm registry, so you install it yourself. Without it the command stops and prints the install line.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="fx-section fx-section-alt" id="in-your-game">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Playing one in your game.</h2>
            </div>
            <p className="section-deck">
              Both sources write the same pair: a spritesheet and an
              Aseprite-style atlas. Most engines import that pair directly.
              Four things are all a game needs to know.
            </p>
          </div>
          <div className="effects-bottom fx-top">
            <CodeWindow
              title="fx/torch.json"
              language="json"
              copyId="effects_atlas_json"
              section="effects"
              code={`
{
  "frames": [
    { "filename": "torch 0", "frame": { "x": 0, "y": 0, "w": 72, "h": 120 }, "duration": 83 },
    { "filename": "torch 1", "frame": { "x": 72, "y": 0, "w": 72, "h": 120 }, "duration": 83 }
  ],
  "meta": {
    "image": "torch.png",
    "anchor": { "kind": "origin", "x": 36, "y": 94 },
    "pixelfx": { "id": "fire/torch", "fps": 12, "loop": true, "frames": 24, "columns": 7 }
  }
}
`}
            />
            <ol className="fx-steps">
              <li>
                <b>Where each frame is.</b> <code>frames[i].frame</code> is its
                rectangle on the sheet, in play order, and{" "}
                <code>duration</code> is how long it shows, in milliseconds.
              </li>
              <li>
                <b>Where to draw it.</b> Draw the frame&apos;s top-left corner
                at <code>target − meta.anchor</code>. For the torch above, a
                bracket at (200, 150) puts the frame at (164, 56).
              </li>
              <li>
                <b>When to stop.</b> A looping effect repeats until you remove
                it. A one-shot plays its frames once; free it after the last.
                pixelfx sheets say which in <code>meta.pixelfx.loop</code>, and
                every <code>.vfx.json</code> record has a <code>loop</code>{" "}
                field.
              </li>
              <li>
                <b>How to blend it.</b> Frames are ordinary RGBA with straight
                alpha. Glow is already baked into the alpha, so normal blending
                is right; draw the effect after the thing it sits on.
              </li>
            </ol>
          </div>
        </div>
      </section>

      <section className="fx-section" id="controls">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>Every control, side by side.</h2>
            </div>
            <p className="section-deck">
              One command, two sources. <code>--out &lt;base&gt;</code>,{" "}
              <code>--force</code>, <code>--dry-run</code> and{" "}
              <code>--json</code> mean the same for both.
            </p>
          </div>
          <div className="provider-table-wrap">
            <table className="provider-table fx-controls">
              <thead>
                <tr>
                  <th scope="col">To do this</th>
                  <th scope="col">PixelLab workbench (default)</th>
                  <th scope="col"><code>--lib pixelfx</code></th>
                </tr>
              </thead>
              <tbody>
                {CONTROLS.map(([task, pixellab, pixelfx]) => (
                  <tr key={task}>
                    <th scope="row">{task}</th>
                    <td><Marked text={pixellab} /></td>
                    <td><Marked text={pixelfx} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="review-links">
            <TrackedLink className="text-link" id="effects_controls_cli_docs" section="effects" href="/docs/cli/vfx">
              Every flag in the vfx reference
            </TrackedLink>
            <TrackedLink className="text-link" id="effects_generator_docs" section="effects" href="/docs/generators#vfx">
              Declare effects in a manifest
            </TrackedLink>
          </div>
        </div>
      </section>

      <section className="fx-section fx-section-alt" id="recipes">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>A record that renders it again.</h2>
            </div>
            <p className="section-deck">
              Every run writes <code>&lt;base&gt;.vfx.json</code> beside the
              sheet. It says what made the effect and holds the recipe. Commit
              it, and anyone can rebuild the sheet with <code>--recipe</code>.
            </p>
          </div>
          <div className="effects-bottom fx-top">
            <CodeWindow
              title="fx/boom.vfx.json"
              language="json"
              copyId="effects_record_json"
              section="effects"
              code={`
{
  "provider": "pixelfx",
  "library": { "name": "pixelfx", "version": "0.3.1", "license": "MIT" },
  "effect": "explosions/small-explosion",
  "width": 300, "height": 240, "frames": 66, "fps": 12, "loop": false,
  "anchor": { "kind": "origin", "x": 150, "y": 196 },
  "sheetSha256": "…",
  "recipe": {
    "effect": "explosions/small-explosion",
    "fps": 12,
    "options": { "palette": ["#102", "#215", "#43a", "#8cf", "#fff"], "seed": 3 }
  }
}
`}
            />
            <ul className="check-list effects-list">
              <li><span className="tick" aria-hidden="true" /> A pixelfx record names the library version. If yours differs, the run says so, because a newer version may draw the effect differently.</li>
              <li><span className="tick" aria-hidden="true" /> Edit <code>recipe.options</code> by hand to reach what the flags do not cover: <code>flip</code>, <code>angle</code>, <code>light</code>, and each effect&apos;s own options.</li>
              <li><span className="tick" aria-hidden="true" /> A PixelLab record holds the effect&apos;s full layer recipe, its saved id, and the sprite it was built around.</li>
              <li><span className="tick" aria-hidden="true" /> Flags given with <code>--recipe</code> override the recorded value, one option at a time.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="fx-section" id="library">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>The same calls from code.</h2>
            </div>
            <p className="section-deck">
              The command is a thin layer over functions the{" "}
              <code>pixelkiln</code> package exports. Use them to render
              effects in a build script, or to get raw frames without writing
              files.
            </p>
          </div>
          <div className="effects-bottom fx-top">
            <CodeWindow
              title="render-effects.ts"
              language="json"
              copyId="effects_library_code"
              section="effects"
              code={`
import { loadPixelfx, listPixelfxEffects, makePixelfxVfx, renderPixelfx } from "pixelkiln"

const lib = await loadPixelfx()
const ids = listPixelfxEffects(lib).filter((fx) => !fx.needsCharacter).map((fx) => fx.id)

const made = await makePixelfxVfx(lib, {
  effect: "fire/torch",
  fps: 12,
  options: { seed: 4 },
  out: "fx/torch",
})
console.log(made.paths.sheet, made.anchor, made.frames)

const { frames, width, height } = renderPixelfx(lib, { effect: "pickups/coin-spin" })
`}
            />
            <ul className="check-list effects-list">
              <li><span className="tick" aria-hidden="true" /> <code>loadPixelfx()</code> finds the library in your project and throws an error with code <code>capability</code> when it is missing.</li>
              <li><span className="tick" aria-hidden="true" /> <code>makePixelfxVfx()</code> writes the sheet, atlas and record, and returns their paths, the pivot and the sheet&apos;s SHA-256.</li>
              <li><span className="tick" aria-hidden="true" /> <code>renderPixelfx()</code> returns one RGBA buffer per frame and writes nothing.</li>
              <li><span className="tick" aria-hidden="true" /> <code>makeVfx()</code> and <code>makeVfxWithArtist()</code> are the PixelLab equivalents.</li>
            </ul>
          </div>
          <div className="review-links">
            <TrackedLink className="text-link" id="effects_library_docs" section="effects" href="/docs/library/render-effects">
              Read the library reference
            </TrackedLink>
            <TrackedLink className="text-link" id="effects_third_party_docs" section="effects" href="/docs/third-party">
              pixelfx credit and license
            </TrackedLink>
          </div>
        </div>
      </section>
    </>
  );
}
