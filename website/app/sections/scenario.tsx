import Image from "next/image";
import { CodeWindow } from "@/app/ui/code-window";
import { TrackedLink } from "@/app/ui/tracked-link";

export function ScenarioSection() {
  return (
        <section className="scenario-section shell" id="scenario">
          <div className="section-heading split-heading">
            <div>
              <h2>Scenario, measured: ten models, one chain, and where it fails.</h2>
            </div>
            <p className="section-deck">
              We ran Scenario&apos;s catalogue through PixelKiln: ten text-to-image
              models priced from 1 to 11 compute units, six single-image tool
              models, reference-image edits, a three-model chain, and a real
              isometric pixel-art game&apos;s structures, covers, backdrops, and sound
              effects. Every paid request is preceded by a free quote and held
              under a ceiling you set. These are our own benchmark images, one
              sample each.
            </p>
          </div>

          <div className="scenario-grid">
            <article className="scenario-panel">
              <h3>Price does not predict fit</h3>
              <div className="scenario-strip scenario-strip-four">
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/klein-1cu.png" alt="A pixel-art stone keep on a mountain from FLUX.2 Klein 9b" width={384} height={384} sizes="(max-width: 680px) 50vw, 200px" />
                  <figcaption><b>1 CU</b> FLUX.2 Klein 9b</figcaption>
                </figure>
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/krea-2cu.png" alt="A pixel-art mossy cave mountain from Krea 2 Turbo" width={384} height={384} sizes="(max-width: 680px) 50vw, 200px" />
                  <figcaption><b>2 CU</b> Krea 2 Turbo</figcaption>
                </figure>
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/ernie-3cu.png" alt="A pixel-art castle on a cliff from Ernie Image Turbo" width={384} height={384} sizes="(max-width: 680px) 50vw, 200px" />
                  <figcaption><b>3 CU</b> Ernie Image Turbo</figcaption>
                </figure>
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/gpt-11cu.png" alt="A detailed pixel-art stone keep with banners from GPT Image 2" width={384} height={384} sizes="(max-width: 680px) 50vw, 200px" />
                  <figcaption><b>11 CU</b> GPT Image 2</figcaption>
                </figure>
              </div>
              <p>
                The same brief, seed, and 512 px request to four models. The 1 and
                2 CU models gave a usable silhouette and the most authentic pixel
                texture; GPT Image 2 followed the brief best. None returned a
                native-grid, closed-palette asset, and four ignored the requested
                canvas size.
              </p>
            </article>

            <article className="scenario-panel">
              <h3>Render, pixelate, cut out, refine</h3>
              <div className="scenario-strip scenario-strip-four scenario-strip-chain">
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/chain-1-render.png" alt="A knight rendered by FLUX.2 Klein 9b on a white background" width={256} height={256} sizes="(max-width: 680px) 50vw, 200px" />
                  <figcaption><b>1 CU</b> render</figcaption>
                </figure>
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/chain-2-pixelate.png" alt="The knight pixelated onto a 32-color palette" width={256} height={256} sizes="(max-width: 680px) 50vw, 200px" />
                  <figcaption><b>5 CU</b> Pixelate</figcaption>
                </figure>
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/chain-3-cutout.png" alt="The pixelated knight with its background removed" width={256} height={256} sizes="(max-width: 680px) 50vw, 200px" />
                  <figcaption><b>2 CU</b> Birefnet cutout</figcaption>
                </figure>
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/chain-4-refined.png" alt="The final 64 by 64 transparent knight sprite after refinement" width={256} height={256} sizes="(max-width: 680px) 50vw, 200px" />
                  <figcaption><b>free</b> refine, 64×64</figcaption>
                </figure>
              </div>
              <p>
                One manifest, one <code>pixelkiln gen</code>, 8 CU: each step names its
                parent&apos;s style, so the chain runs in order and a 64×64 transparent
                sprite lands at the end, held at the same review gate as any other
                asset. On a real game&apos;s 240 px landmarks the same chain returned
                the sprite&apos;s exact size at high confidence with far more detail.
              </p>
            </article>
            <article className="scenario-panel scenario-panel-wide">
              <h3>The same render, one PixelLab call</h3>
              <div className="scenario-strip scenario-strip-three scenario-strip-chain">
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/chain-1-render.png" alt="The same knight render, the source for both conversions" width={256} height={256} sizes="(max-width: 680px) 33vw, 200px" />
                  <figcaption><b>source</b> the 1 CU render</figcaption>
                </figure>
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/chain-2-pixelate.png" alt="The knight after Scenario's Pixelate" width={256} height={256} sizes="(max-width: 680px) 33vw, 200px" />
                  <figcaption><b>5 CU</b> Scenario Pixelate</figcaption>
                </figure>
                <figure>
                  <Image src="/benchmarks/provider-scenario-showcase/pixellab-pixelate.png" alt="The knight after PixelLab's Image to Pixel Art Pro Flash, 108 by 109 pixels" width={108} height={109} sizes="(max-width: 680px) 33vw, 200px" unoptimized />
                  <figcaption><b>6 gen</b> PixelLab pixelate, 108×109</figcaption>
                </figure>
              </div>
              <p>
                <code>pixelkiln pixelate</code> sends the same knight to PixelLab&apos;s
                Image to Pixel Art Pro Flash. PixelLab picked the 108×109 grid itself and
                returned it in one call for a flat 6 generations. Like Scenario&apos;s
                Pixelate, the result is opaque, here on near-white, so the cutout step
                still applies before it becomes a sprite.
              </p>
            </article>
          </div>

          <article className="scenario-panel scenario-findings">
            <h3>What a real game taught us</h3>
            <ul>
              <li><b>Large art works.</b> A 240 px landmark chain returned the existing sprite&apos;s exact size at high confidence, with far more detail, for 8 CU on the cheap model or 18 CU on the strongest.</li>
              <li><b>A reference keeps the design.</b> Sending the current sprite as a reference raised silhouette overlap from 0.39 to 0.66 to 0.93 to 1.00, at the same pixel scale. Some models shift colors.</li>
              <li><b>Small sprites and tiles do not.</b> 32 px props came back as different objects with holes after the cutout; terrain tiles and characters need tools built for them.</li>
              <li><b>Backdrops need the prompt to say flat.</b> An isometric prompt lay on a diagonal plane; asking for a front-facing horizontal strip gave the exact grid. A mist fade needs a better cutout route.</li>
              <li><b>The pixelate grid is not always literal.</b> On a 960 px render, asking for 240 made 2 px blocks and asking for 120 made the 240 cells wanted. Check one image first.</li>
              <li><b>Sound effects need one event each.</b> A two-part impact worked only as two sounds layered, and only on the pricier model; the cheap one returned ambience.</li>
              <li><b>Quotes were exact, the balance is not visible.</b> Every quote matched its bill, but the adapter cannot read the account balance, and a hand tally ran about 5% under it.</li>
            </ul>
          </article>

          <div className="scenario-bottom">
            <div className="scenario-snippet scenario-snippet-window">
              <CodeWindow
                title="pixelkiln.manifest.json"
                language="json"
                copyId="scenario_chain_manifest"
                section="scenario"
                code={`
"assets": {
  "knight": { "styles": ["render"], "prompt": "…" },
  "knight-px": {
    "styles": ["pixelate"],
    "prompt": "pixelate",
    "revision": {
      "mode": "image-to-image",
      "from": "knight",
      "fromStyle": "render"
    }
  }
}
`}
              />
              <p>
                <code>revision.fromStyle</code> lets a style that uses one model
                revise another style&apos;s output, so a chain across models is declared,
                priced, and ordered instead of stitched by hand.
              </p>
            </div>
            <dl className="scenario-facts">
              <div><dt>Where it fits</dt><dd>Large landmarks, covers and key art with legible text, flat backdrops, image-to-image edits at 1 CU, and cheap sound effects</dd></div>
              <div><dt>Where it does not</dt><dd>32 px props, characters, terrain tiles and cliff blocks, which stay on a tool built for them</dd></div>
              <div><dt>Cost control</dt><dd>A free quote before every paid call, a per-style ceiling, and a command budget</dd></div>
            </dl>
          </div>

          <div className="scenario-links">
            <TrackedLink className="text-link" id="scenario_docs" section="scenario" href="/docs/scenario">
              Set up Scenario
            </TrackedLink>
            <TrackedLink className="text-link" id="scenario_across_styles" section="scenario" href="/docs/revisions#across-styles">
              Chain models across styles
            </TrackedLink>
            <TrackedLink className="text-link" id="scenario_game_pilot" section="scenario" href="https://github.com/gfargo/pixelkiln/tree/main/benchmarks/provider-scenario-game-pilot" external>
              Read the game pilot ↗
            </TrackedLink>
            <TrackedLink className="text-link" id="scenario_bakeoff" section="scenario" href="https://github.com/gfargo/pixelkiln/tree/main/benchmarks/provider-scenario-bakeoff" external>
              Inspect the model bake-off ↗
            </TrackedLink>
          </div>
        </section>
  );
}
