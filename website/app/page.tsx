import Image from "next/image";
import { absoluteUrl } from "@/app/lib/metadata";
import { CopyCommand } from "@/app/ui/copy-command";
import { JsonLd } from "@/app/ui/json-ld";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";
import { SpriteLoop } from "@/app/ui/sprite-loop";
import { TrackedLink } from "@/app/ui/tracked-link";

export default function Home() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${absoluteUrl("/")}#website`,
        name: "PixelKiln",
        url: absoluteUrl("/"),
        description:
          "Plan costs, review candidates and frame sets, edit sprites in the browser, gate derived art, recover paid work, and package pixel art with recorded hashes.",
      },
      {
        "@type": "SoftwareSourceCode",
        "@id": `${absoluteUrl("/")}#software`,
        name: "PixelKiln",
        url: absoluteUrl("/"),
        codeRepository: "https://github.com/gfargo/pixelkiln",
        license: "https://opensource.org/license/mit",
        programmingLanguage: "TypeScript",
        runtimePlatform: "Node.js",
        description:
          "A build pipeline that plans provider costs, records human choices and hand edits, verifies derived art and frame sets, restores paid work, and packages pixel art.",
      },
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <SiteHeader />
      <main>
      <section className="hero shell">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" /> Generated pixel art, without the guesswork
          </p>
          <h1>
            Fire once.
            <br />
            Ship every sprite
            <br />
            <em>with receipts.</em>
          </h1>
          <p className="hero-deck">
            Declare the art you need, see the price before generation, choose
            candidates yourself, and keep a hash for every file you ship.
          </p>
          <div className="hero-actions">
            <TrackedLink
              className="button button-primary"
              id="hero_quickstart"
              section="hero"
              href="/docs/getting-started"
            >
              Read the quickstart
            </TrackedLink>
            <TrackedLink
              className="button button-secondary"
              id="hero_github"
              section="hero"
              href="https://github.com/gfargo/pixelkiln"
              external
            >
              View on GitHub <span aria-hidden="true">↗</span>
            </TrackedLink>
          </div>
          <div className="trust-line" aria-label="Core guarantees">
            <span>Offline planning</span>
            <span>Hard budgets</span>
            <span>Exact provenance</span>
          </div>
        </div>

        <div className="hero-visual" aria-label="Example PixelKiln plan">
          <div className="visual-glow" />
          <div className="terminal-window">
            <div className="terminal-bar">
              <div className="terminal-lights" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <span>pixelkiln plan</span>
              <span className="terminal-state">offline</span>
            </div>
            <div className="terminal-body">
              <div className="command-line">
                <span className="prompt-mark">$</span>
                <span>pixelkiln plan --style base</span>
              </div>
              <div className="plan-summary">
                <div>
                  <span className="summary-label">PROJECT</span>
                  <strong>forge-kit</strong>
                </div>
                <div>
                  <span className="summary-label">EST. COST</span>
                  <strong className="ember-text">2 generations</strong>
                </div>
              </div>
              <div className="plan-list">
                <div className="plan-row">
                  <span className="plan-icon ok">✓</span>
                  <span className="asset-name">base/anvil</span>
                  <span className="plan-status">current</span>
                </div>
                <div className="plan-row">
                  <span className="plan-icon recover">↻</span>
                  <span className="asset-name">base/hammer</span>
                  <span className="plan-status">recoverable · free</span>
                </div>
                <div className="plan-row active">
                  <span className="plan-icon missing">+</span>
                  <span className="asset-name">base/tongs</span>
                  <span className="plan-status">missing · 1 gen</span>
                </div>
                <div className="plan-row active">
                  <span className="plan-icon stale">△</span>
                  <span className="asset-name">base/crucible</span>
                  <span className="plan-status">stale · 1 gen</span>
                </div>
              </div>
              <div className="terminal-footer">
                <span>No provider calls made</span>
                <span>4 assets inspected in 31ms</span>
              </div>
            </div>
          </div>
          <div className="provenance-card">
            <span className="provenance-icon">#</span>
            <div>
              <span>PROVENANCE LOCKED</span>
              <strong>sha256 · 98f1…c42a</strong>
            </div>
            <span className="check-pip">✓</span>
          </div>
        </div>
      </section>

        <section className="proof-strip" aria-label="PixelKiln at a glance">
        <div className="shell proof-grid">
          <div>
            <strong>04</strong>
            <span>generation providers</span>
          </div>
          <div>
            <strong>31</strong>
            <span>composable commands</span>
          </div>
          <div>
            <strong>00</strong>
            <span>LLM calls in the loop</span>
          </div>
          <p>
            The judgment stays human.
            <br />
            The mechanics stay deterministic.
          </p>
        </div>
        </section>

        <section className="workflow-section shell" id="workflow">
          <div className="section-heading">
            <p className="eyebrow">Four steps from one committed manifest</p>
            <h2>Declare it. Price it.<br />Review it. Ship it.</h2>
          </div>
          <div className="workflow-grid">
            <article>
              <span className="step-number">01</span>
              <div className="step-glyph"><Image src="/sprites/workflow/declare.png" alt="" width={64} height={64} /></div>
              <h3>Declare</h3>
              <p>Put asset names, prompts, provider settings, and an optional final-art quality profile in one file.</p>
              <code>pixelkiln.manifest.json</code>
            </article>
            <article>
              <span className="step-number">02</span>
              <div className="step-glyph"><Image src="/sprites/workflow/plan.png" alt="" width={64} height={64} /></div>
              <h3>Plan</h3>
              <p>Compare the manifest with the lockfile and disk. See what costs money and what can be restored for free.</p>
              <code>pixelkiln plan</code>
            </article>
            <article>
              <span className="step-number">03</span>
              <div className="step-glyph"><Image src="/sprites/workflow/review.png" alt="" width={64} height={64} /></div>
              <h3>Review</h3>
              <p>Choose from a local candidate sheet, touch a sprite up in the gallery&apos;s editor, then approve the exact pixels you ship.</p>
              <code>pixelkiln pick</code>
            </article>
            <article>
              <span className="step-number">04</span>
              <div className="step-glyph"><Image src="/sprites/workflow/ship.png" alt="" width={64} height={64} /></div>
              <h3>Ship</h3>
              <p>Build repeatable atlases, Aseprite sheet JSON, Godot SpriteFrames, and tilesets for Tiled and Godot. A style with a palette rule never ships a colour outside it. Quality-profile styles stay blocked until approval is current.</p>
              <code>pixelkiln pack</code>
            </article>
          </div>
        </section>

        <section className="review-section">
          <div className="shell review-grid">
            <div className="section-heading review-copy">
              <p className="eyebrow">Review and edits stay local</p>
              <h2>Choose the image.<br />Fix the pixel.<br />Keep the receipts.</h2>
              <p className="section-deck">
                PixelLab, Retro Diffusion, ComfyUI, and Scenario use the same review,
                lockfile, and recovery flow. PixelKiln records every candidate,
                then leaves the visual decision to you. The page preserves native
                aspect ratios and stays readable on ultrawide displays. Afterwards,{" "}
                <code>pixelkiln gallery</code> opens any generation with its
                prompt, cost, hashes, lineage, and approval. It compares two
                records side by side. With <code>--edit</code> it changes prompts
                and style fields and adds assets. With <code>--budget</code> it
                generates again, under a ceiling you set.
              </p>
              <p className="section-deck">
                Regenerating keeps the version it replaces. Each record lists its
                previous generations, up to a count you choose, and one click
                brings any of them back. Nothing is spent, and the swap can be
                undone from the same list.
              </p>
              <p className="section-deck">
                Providers are asked for your palette; <code>enforcePalette</code>{" "}
                makes it a guarantee. Every downloaded sprite is snapped to the
                nearest palette colour as it is written, the provider&apos;s
                bytes stay in the cache, and turning the rule on or off later
                re-applies it to art you already paid for.
              </p>
              <p className="section-deck">
                Hand edits stay beside the art, never over the record. Open a
                sprite in your own editor with <code>pixelkiln edit</code>, or in
                the gallery&apos;s built-in{" "}
                <a href="https://pixelorama.org" rel="noreferrer">Pixelorama</a>,
                a pinned build fetched once and verified by hash, and save it
                back with its layers kept. Frame sets and tile sets open as one
                project with a frame per member, and every member is written back
                under its role. Art edited in PixelLab&apos;s own editor returns
                with <code>fetch --refresh</code>.
              </p>
              <div className="provider-status" aria-label="Current provider support">
                <span><i className="status-dot" /> PixelLab <em>production</em></span>
                <span><i /> Retro Diffusion <em>experimental</em></span>
                <span><i /> ComfyUI <em>experimental</em></span>
                <span><i /> Scenario <em>experimental</em></span>
                <span><i /> FakeProvider <em>tests</em></span>
              </div>
              <p className="provider-note">
                PixelLab has live coverage for generation and account recovery.
                Retro Diffusion has live-tested single-candidate stills. ComfyUI
                has passed local generation, candidate review, cache recovery,
                and grid refinement. Atomic frame sets have automated coverage,
                and accepted frame prompts are saved before the next one is queued.
                They still need a live pose recipe and benchmark. The tested SDXL
                graph needs manual cleanup and art review. Scenario&apos;s BFL profile
                has passed paid single- and two-output generation, human review,
                and durable recovery.
              </p>
              <div className="review-links">
                <TrackedLink className="text-link" id="review_provider_boundary" section="review" href="/docs/provider-notes">
                  Compare providers
                </TrackedLink>
                <TrackedLink className="text-link" id="review_provider_benchmark" section="review" href="/docs/provider-benchmark">
                  See the environment benchmark
                </TrackedLink>
                <TrackedLink className="text-link" id="review_gallery_docs" section="review" href="/docs/cli/gallery">
                  Browse the gallery command
                </TrackedLink>
                <TrackedLink className="text-link" id="review_edit_docs" section="review" href="/docs/getting-started#touch-art-up-by-hand">
                  Touch art up by hand
                </TrackedLink>
                <TrackedLink
                  className="text-link"
                  id="review_pixellab_mcp"
                  section="review"
                  href="https://github.com/pixellab-code/pixellab-mcp"
                  external
                >
                  PixelLab MCP ↗
                </TrackedLink>
              </div>
            </div>
            <div className="review-visuals">
              <figure className="review-visual">
                <div className="review-window-bar">
                  <span>localhost <code>pixelkiln pick</code></span>
                  <span>human review</span>
                </div>
                <Image
                  src="/review-ui-showcase.jpg"
                  alt="PixelKiln's local candidate review interface showing generated forge emblems"
                  width={1280}
                  height={720}
                  sizes="(max-width: 980px) 100vw, 56vw"
                />
                <figcaption>The local review page with generated brand sprites. No model chooses for you.</figcaption>
              </figure>
              <figure className="review-visual">
                <div className="review-window-bar">
                  <span>localhost <code>pixelkiln gallery</code></span>
                  <span>provenance</span>
                </div>
                <Image
                  src="/gallery-ui-showcase.jpg"
                  alt="PixelKiln's local gallery showing 24 generated environments from three providers, with one record open"
                  width={1280}
                  height={720}
                  sizes="(max-width: 980px) 100vw, 56vw"
                />
                <figcaption>The local gallery on the environment benchmark, three providers in one view, every record a click away.</figcaption>
              </figure>
              <figure className="review-visual">
                <div className="review-window-bar">
                  <span>localhost <code>pixelkiln gallery --edit</code></span>
                  <span>hand edit</span>
                </div>
                <Image
                  src="/gallery-editor-showcase.jpg"
                  alt="PixelKiln's gallery with a benchmark fortress sprite open in the built-in Pixelorama editor, ready to save back to the project"
                  width={1280}
                  height={720}
                  sizes="(max-width: 980px) 100vw, 56vw"
                />
                <figcaption>The in-browser editor, a pinned and hash-verified Pixelorama. It saves beside the generated file, never over it.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="cast-section" id="characters">
          <div className="shell">
            <figure className="cast-strip" aria-label="One character facing eight directions">
              <div className="cast-strip-row">
                <Image src="/sprites/characters/robot-8dir.png" alt="A round orange robot drawn facing south, south-west, west, north-west, north, north-east, east, and south-east" width={796} height={96} unoptimized />
                <SpriteLoop strip="/sprites/characters/robot-8dir.png" width={796} frames={8} cell={96} stride={100} scale={2} seconds={2.4} label="The same robot turning through its eight directions" />
              </div>
            </figure>
            <div className="cast-grid">
              <div className="section-heading cast-copy">
                <p className="eyebrow">Characters are a family, not a file</p>
                <h2>Draw the base once.<br />Everything else follows it.</h2>
                <p className="section-deck">
                  A <code>character</code> style holds a base drawn facing 4 or 8
                  directions, states that apply a pose or an outfit to every
                  direction at once, and loops, one direction each. Every one is
                  an asset with its own record and files, so <code>plan</code>{" "}
                  prices the cast, one <code>gen</code> runs it in waves (bases,
                  then states, then loops), and <code>pack --format godot</code>{" "}
                  writes a SpriteFrames with every direction and every loop.
                </p>
                <p className="section-deck">
                  Start from a prompt on any of PixelLab&apos;s four engines, or
                  from your own south-facing sprite: <code>reference</code> hands
                  it over and pro-flash rotates it for one generation at 64px.
                  Regenerate the base and its states and loops go stale, never
                  silently mismatched. Characters already on your account come
                  under the manifest with <code>adopt</code>, and the gallery
                  shows the family: states under their base, loops with their
                  direction, mirrors with their source.
                </p>
                <ul className="check-list cast-list">
                  <li><span>✓</span> A loop facing east is the west loop flipped. <code>mirror</code> makes it locally for nothing; eight directions of one walk cost 5, not 8.</li>
                  <li><span>✓</span> Poses from a text edit, loops from a template or from text, with start and end poses you supply.</li>
                  <li><span>✓</span> Concept images and style anchors on pro, style images with chosen traits on pro-flash.</li>
                </ul>
                <div className="review-links">
                  <TrackedLink className="text-link" id="cast_manifest_docs" section="characters" href="/docs/characters">
                    Read the character reference
                  </TrackedLink>
                  <TrackedLink className="text-link" id="cast_mirror_docs" section="characters" href="/docs/characters#mirrors">
                    How mirrors work
                  </TrackedLink>
                </div>
              </div>
              <div className="cast-visuals">
                <div className="lock-visual cast-manifest" aria-label="A character family in the manifest">
                  <div className="lock-label">pixelkiln.manifest.json</div>
                  <pre><code>{`"cast": {
  "generator": "character",
  "mode": "pro-flash", "size": 64 },

"hero": {
  "prompt": "a knight in a teal cloak",
  "reference": "refs/hero-south.png" },
"hero.sit": {
  "prompt": "sitting cross-legged",
  "state": { "of": "hero" } },
"hero.walk.west": {
  "prompt": "",
  "animation": { "of": "hero",
    "template": "walk", "direction": "west" } },
"hero.walk.east": { "mirror": "hero.walk.west" }`}</code></pre>
                  <div className="lock-callout top"><span>◇</span> 1 generation to rotate</div>
                  <div className="lock-callout bottom"><span>◇</span> 0 for the mirror</div>
                </div>
                <figure className="cast-loop" aria-label="A six-frame walk loop">
                  <div className="cast-loop-row">
                    <SpriteLoop strip="/sprites/characters/walk-loop.png" width={572} frames={5} start={1} cell={92} stride={96} scale={2} seconds={0.625} label="The walk loop playing at 8 frames per second" />
                    <Image src="/sprites/characters/walk-loop.png" alt="Six frames of a walking character, south-facing" width={572} height={92} unoptimized />
                  </div>
                  <figcaption>A template walk, one generation, playing at the fps the manifest records. Reviewed as one set in <code>pick</code>, packed as one looping animation.</figcaption>
                </figure>
              </div>
            </div>
          </div>
        </section>

        <section className="provider-showcase-section shell" id="providers">
          <div className="section-heading split-heading provider-showcase-heading">
            <div>
              <h2>Real runs.<br />Different pixels.</h2>
            </div>
            <p className="section-deck">
              These are outputs from committed benchmark projects. The
              ComfyUI card separates its model canvas from the recovered native
              pixel grid, because a large raster can still contain fake pixels.
              Its samples are diagnostics, not finished asset recommendations.
              Scenario shows its first paid integration smoke, not a comparable
              environment benchmark. A manifest <code>style.quality</code> profile
              can apply the same offline palette and approval gate after any
              supported single-image provider or an atomic ComfyUI frame set.
              ComfyUI is also the first adapter for controlled revisions. It
              hashes the parent and mask bytes before a workflow can run.
            </p>
          </div>

          <div className="provider-showcase-grid">
            <article className="provider-card">
              <div className="provider-card-header">
                <div>
                  <span className="provider-badge production">Production</span>
                  <h3>PixelLab</h3>
                </div>
                <span className="provider-unit">Generations</span>
              </div>
              <div className="provider-image-grid">
                <figure>
                  <Image
                    src="/benchmarks/provider-environments/pixellab/isolated/a/cliffside-fortress.png"
                    alt="PixelLab result for a fortified monastery built into a mountain cliff"
                    width={384}
                    height={384}
                    sizes="(max-width: 680px) 50vw, 280px"
                  />
                  <figcaption>Large building, map generator</figcaption>
                </figure>
                <figure>
                  <Image
                    src="/benchmarks/provider-environments/pixellab/background/a/alpine-valley.png"
                    alt="PixelLab result for an alpine valley background at dusk"
                    width={256}
                    height={256}
                    sizes="(max-width: 680px) 50vw, 280px"
                  />
                  <figcaption>Scenic background, pixflux generator</figcaption>
                </figure>
              </div>
              <p>
                PixelLab kept more of each brief and made the scenic depth
                planes easier to separate. Its map objects were opaque, and one
                scenic attempt added a signature-like mark. Check alpha and
                stray marks before a batch.
              </p>
              <dl>
                <div><dt>Benchmark cost</dt><dd>1 generation each</dd></div>
                <div><dt>Best fit</dt><dd>Prompt fidelity and account recovery</dd></div>
              </dl>
              <div className="provider-card-links">
                <TrackedLink className="text-link" id="showcase_pixellab_setup" section="provider_showcase" href="/docs/pixellab">
                  Set up PixelLab
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_pixellab_site" section="provider_showcase" href="https://www.pixellab.ai/" external>
                  Visit PixelLab ↗
                </TrackedLink>
              </div>
            </article>

            <article className="provider-card">
              <div className="provider-card-header">
                <div>
                  <span className="provider-badge experimental">Experimental</span>
                  <h3>Retro Diffusion</h3>
                </div>
                <span className="provider-unit">USD</span>
              </div>
              <div className="provider-image-grid">
                <figure>
                  <Image
                    src="/benchmarks/provider-environments/retrodiffusion/isolated/a/cliffside-fortress.png"
                    alt="Retro Diffusion result for a fortified monastery built into a mountain cliff"
                    width={384}
                    height={384}
                    sizes="(max-width: 680px) 50vw, 280px"
                  />
                  <figcaption>Large building, RD Plus</figcaption>
                </figure>
                <figure>
                  <Image
                    src="/benchmarks/provider-environments/retrodiffusion/background/a/alpine-valley.png"
                    alt="Retro Diffusion result for an alpine valley background at dusk"
                    width={256}
                    height={256}
                    sizes="(max-width: 680px) 50vw, 280px"
                  />
                  <figcaption>Scenic background, RD Plus</figcaption>
                </figure>
              </div>
              <p>
                Both 384px building attempts had transparent backgrounds and
                used 49 to 55 colors. They also filled more of the frame than
                the earlier 256px attempt.
              </p>
              <dl>
                <div><dt>Benchmark cost</dt><dd>$0.058–$0.099 each</dd></div>
                <div><dt>Best fit</dt><dd>Ready-to-place cutouts and native animation</dd></div>
              </dl>
              <div className="provider-card-links">
                <TrackedLink className="text-link" id="showcase_retro_setup" section="provider_showcase" href="/docs/retro-diffusion">
                  Set up Retro Diffusion
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_retro_site" section="provider_showcase" href="https://www.retrodiffusion.ai/" external>
                  Visit Retro Diffusion ↗
                </TrackedLink>
              </div>
            </article>

            <article className="provider-card">
              <div className="provider-card-header">
                <div>
                  <span className="provider-badge experimental">Experimental</span>
                  <h3>ComfyUI</h3>
                </div>
                <span className="provider-unit">Self-hosted</span>
              </div>
              <div className="provider-image-grid">
                <figure>
                  <Image
                    src="/benchmarks/provider-hires/comfyui/refined/cliffside-fortress-128x128.png"
                    alt="Transparent ComfyUI cliffside fortress refined onto a native 128 by 128 grid with a fixed palette"
                    width={128}
                    height={128}
                    sizes="(max-width: 680px) 50vw, 280px"
                    unoptimized
                  />
                  <figcaption>Refined to a native 128×128 grid, 15 colors, transparent</figcaption>
                </figure>
                <figure>
                  <Image
                    src="/benchmarks/provider-hires/comfyui/refined/alpine-valley-128x128.png"
                    alt="ComfyUI alpine valley refined onto a native 128 by 128 grid with a fixed palette"
                    width={128}
                    height={128}
                    sizes="(max-width: 680px) 50vw, 280px"
                    unoptimized
                  />
                  <figcaption>Refined to a native 128×128 grid, 24 colors</figcaption>
                </figure>
              </div>
              <p>
                SDXL Base plus Pixel Art XL found workable compositions, but
                the raw files only imitated a pixel grid. Pixel Art Fixer
                recovers editable 1× assets and applies a fixed palette.
                A manifest quality profile makes those mechanical checks and
                approval part of planning and packaging. You still judge the
                drawing. Build large scenes from small parts that pass review.
              </p>
              <dl>
                <div><dt>Provider charge</dt><dd>None; hardware cost is external</dd></div>
                <div><dt>Quality target</dt><dd>48–128px native per part</dd></div>
                <div><dt>Best fit</dt><dd>Local composition, revisions, frame experiments, and custom graphs</dd></div>
                <div><dt>Readiness</dt><dd>Still workflow live-tested; frame workflow awaits a live benchmark</dd></div>
              </dl>
              <div className="provider-card-links">
                <TrackedLink className="text-link" id="showcase_comfyui_recipe" section="provider_showcase" href="/docs/recipes">
                  Install tested recipe
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_comfyui_setup" section="provider_showcase" href="/docs/comfyui">
                  Set up ComfyUI
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_comfyui_revisions" section="provider_showcase" href="/docs/revisions">
                  Revise an existing asset
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_comfyui_revision_smoke" section="provider_showcase" href="https://github.com/gfargo/pixelkiln/tree/main/benchmarks/provider-revisions/comfyui" external>
                  Inspect the revision smoke ↗
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_comfyui_site" section="provider_showcase" href="https://www.comfy.org/" external>
                  Visit ComfyUI ↗
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_pixel_fixer" section="provider_showcase" href="https://www.retrodiffusion.ai/tools/pixel-art-fixer/" external>
                  Try Pixel Art Fixer ↗
                </TrackedLink>
              </div>
            </article>

            <article className="provider-card">
              <div className="provider-card-header">
                <div>
                  <span className="provider-badge experimental">Experimental</span>
                  <h3>Scenario</h3>
                </div>
                <span className="provider-unit">Compute Units</span>
              </div>
              <div className="provider-image-grid provider-image-grid-single">
                <figure>
                  <Image
                    src="/benchmarks/provider-scenario-smoke/mountain-keep.png"
                    alt="Scenario BFL Flux 2 Dev result showing a stone keep on a mountain"
                    width={512}
                    height={512}
                    sizes="(max-width: 680px) 100vw, 560px"
                  />
                  <figcaption>Live smoke test, raw 512×512, opaque, 19,619 colors</figcaption>
                </figure>
              </div>
              <p>
                BFL Flux 2 Dev produced a readable keep and completed the full
                PixelKiln lifecycle. The raw file imitates pixel art but carries
                a large RGB palette. Treat it as concept art or refinement input,
                not a finished game asset.
              </p>
              <dl>
                <div><dt>Measured cost</dt><dd>16 CU for one output; 32 CU for two</dd></div>
                <div><dt>Best fit</dt><dd>Hosted models and project-specific LoRA experiments</dd></div>
                <div><dt>Readiness</dt><dd>One BFL profile live-tested; other schemas unverified</dd></div>
              </dl>
              <div className="provider-card-links">
                <TrackedLink className="text-link" id="showcase_scenario_setup" section="provider_showcase" href="/docs/scenario">
                  Set up Scenario
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_scenario_smoke" section="provider_showcase" href="https://github.com/gfargo/pixelkiln/tree/main/benchmarks/provider-scenario-smoke" external>
                  Inspect the live smoke ↗
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_scenario_site" section="provider_showcase" href="https://www.scenario.com/" external>
                  Visit Scenario ↗
                </TrackedLink>
              </div>
            </article>
          </div>

          <div className="provider-showcase-links">
            <TrackedLink className="text-link" id="showcase_mixed_providers" section="provider_showcase" href="/docs/mixed-providers">
              Use several providers in one project
            </TrackedLink>
            <TrackedLink className="text-link" id="showcase_benchmark" section="provider_showcase" href="/docs/provider-benchmark">
              Review the environment benchmark
            </TrackedLink>
            <TrackedLink className="text-link" id="showcase_comparison" section="provider_showcase" href="/docs/provider-notes">
              Compare provider capabilities
            </TrackedLink>
          </div>
        </section>

        <section className="safety-section">
          <div className="shell safety-grid">
            <div className="section-heading safety-copy">
              <h2>Paid work needs a paper trail.</h2>
              <p className="section-deck">
                Every provider object, prompt identity, output role, path, and
                byte hash survives in project state. A failed download remains
                recoverable work, not a reason to pay twice.
              </p>
              <ul className="check-list">
                <li><span>✓</span> Remote identity saved before polling</li>
                <li><span>✓</span> Content-addressed local recovery cache</li>
                <li><span>✓</span> Hand edits kept beside the generated file</li>
                <li><span>✓</span> Replaced generations kept, restorable at no cost</li>
                <li><span>✓</span> Manual-edit and overwrite protection</li>
                <li><span>✓</span> Transactional atlas and export writes</li>
              </ul>
              <TrackedLink className="text-link" id="safety_recovery" section="safety" href="/docs/recovery">
                Explore recovery guarantees
              </TrackedLink>
            </div>
            <div className="lock-visual" aria-label="Example provenance lock entry">
              <div className="lock-label">pixelkiln.lock.json</div>
              <pre><code>{`{
  "base/anvil": {
    "status": "downloaded",
    "provider": "pixellab",
    "specHash": "61c9…a071",
    "cost": { "value": 1,
              "unit": "generations" },
    "outputs": [{
      "path": "art/base/anvil.png",
      "sha256": "98f1…c42a"
    }]
  }
}`}</code></pre>
              <div className="lock-callout top"><span>◇</span> paid-work identity</div>
              <div className="lock-callout bottom"><span>◇</span> exact output bytes</div>
            </div>
          </div>
        </section>

        <section className="capabilities-section shell">
          <div className="section-heading split-heading">
            <div>
              <h2>The prompt is only the start.</h2>
            </div>
            <p className="section-deck">PixelKiln handles the work between a prompt and the files your game loads.</p>
          </div>
          <div className="capability-grid">
            <article className="capability-card large">
              <span className="card-index">Plan</span>
              <h3>Know the bill before the fire starts.</h3>
              <p>Offline diffs distinguish new spend from zero-cost recovery. Copy the estimate into a hard budget ceiling.</p>
              <div className="budget-meter">
                <div><span>Selected work</span><strong>80 / 120</strong></div>
                <div className="meter-track"><span /></div>
              </div>
            </article>
            <article className="capability-card">
              <span className="card-index">Recover</span>
              <h3>Restore before you regenerate.</h3>
              <p>Rebuild missing output from trusted cache bytes or a provider URL without new generation cost. A regeneration keeps the version it replaced, so the old one is one command away.</p>
              <div className="micro-state"><span className="status-dot" /> recoverable, 0 generations</div>
            </article>
            <article className="capability-card">
              <span className="card-index">Audit</span>
              <h3>Turn accepted pixels into a release gate.</h3>
              <p>Declare the final palette and grid threshold, record human approval, and block stale or unreviewed art in CI.</p>
              <div className="audit-bars" aria-hidden="true"><span /><span /><span /><span /><span /></div>
            </article>
            <article className="capability-card large">
              <span className="card-index">Package</span>
              <h3>Build the files your engine expects.</h3>
              <p>Pack sheets, mount stable cells, and export lossless generic, Tiled, or Godot terrain metadata with provenance.</p>
              <div className="format-list"><span>PNG</span><span>JSON</span><span>TILED</span><span>GODOT 4</span></div>
            </article>
          </div>
        </section>

        <section className="generator-section">
          <div className="shell">
            <div className="section-heading split-heading">
              <div>
                <p className="eyebrow">Different routes, different bills</p>
                <h2>Use the capability you need.<br />Pay only for that.</h2>
              </div>
              <p className="section-deck">Measured PixelLab costs vary by up to 40×. Retro Diffusion uses USD pricing. Self-hosted ComfyUI has no provider charge. PixelKiln keeps those units separate.</p>
            </div>
            <div className="generator-table">
              <div className="generator-row header"><span>Generator</span><span>Best for</span><span>Measured cost</span></div>
              <div className="generator-row"><strong>map</strong><span>Standalone props and icons</span><span><i style={{ width: "2.5%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>pixflux</strong><span>Exact closed palettes</span><span><i style={{ width: "2.5%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>1dir</strong><span>References and candidate variety</span><span><i style={{ width: "72%" }} /> 20–40 gen</span></div>
              <div className="generator-row"><strong>tiles</strong><span>Ground and structural sets</span><span><i style={{ width: "100%" }} /> 20–40 gen</span></div>
              <div className="generator-row"><strong>character</strong><span>A base in 8 directions, its poses, its loops</span><span><i style={{ width: "17.5%" }} /> 1–7 gen per base, 1 per loop, mirrors free</span></div>
              <div className="generator-row"><strong>animation</strong><span>Retro Diffusion GIFs and sprite sheets</span><span>USD quote</span></div>
              <div className="generator-row"><strong>frames</strong><span>Controlled ComfyUI still sequences</span><span>0 provider units</span></div>
            </div>
            <div className="review-links">
              <TrackedLink className="text-link" id="generator_compare" section="generator" href="/docs/generators">
                Compare generator capabilities
              </TrackedLink>
              <TrackedLink className="text-link" id="provider_compare" section="generator" href="/docs/provider-notes">
                Compare providers
              </TrackedLink>
            </div>
          </div>
        </section>

        <section className="install-section shell">
          <div className="install-panel">
            <div>
              <h2>Teach your agent the PixelKiln workflow.</h2>
              <p>The skill tells compatible agents when to plan, ask for a budget, restore existing work, stop for human review, and verify output.</p>
            </div>
            <div className="install-actions">
              <CopyCommand command="npx skills add gfargo/pixelkiln@pixelkiln" />
              <div>
                <TrackedLink
                  className="button button-primary"
                  id="install_agent_setup"
                  section="install"
                  href="/docs/agents"
                >
                  Agent setup
                </TrackedLink>
                <TrackedLink
                  className="button button-secondary"
                  id="install_library_quickstart"
                  section="install"
                  href="/docs/getting-started"
                >
                  Library quickstart
                </TrackedLink>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
