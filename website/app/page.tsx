import Image from "next/image";
import { absoluteUrl } from "@/app/lib/metadata";
import { CopyCommand } from "@/app/ui/copy-command";
import { JsonLd } from "@/app/ui/json-ld";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";
import { SpriteCarousel } from "@/app/ui/sprite-carousel";
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
            <span className="status-dot" /> A build pipeline for generated pixel art
          </p>
          <h1>
            Fire once.
            <br />
            Ship every sprite
            <br />
            <em>with receipts.</em>
          </h1>
          <p className="hero-deck">
            Declare the sprites you need in one manifest. PixelKiln prices the
            run offline, lets you choose among candidates, and records a SHA-256
            hash for every file you ship.
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
          <div className="hero-install">
            <CopyCommand command="npm install --save-dev pixelkiln" />
          </div>
          <div className="trust-line" aria-label="What PixelKiln does">
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
            <strong>35</strong>
            <span>composable commands</span>
          </div>
          <div>
            <strong>00</strong>
            <span>LLM calls in the loop</span>
          </div>
          <p>
            You choose every image.
            <br />
            PixelKiln does the polling, hashing, and file placement the same way every time.
          </p>
        </div>
        </section>

        <section className="workflow-section shell" id="workflow">
          <div className="section-heading">
            <h2>Declare it. Price it. Generate it.<br />Review it. Ship it.</h2>
            <p className="section-deck workflow-deck">
              One committed manifest drives every step. Each step says what it reads and what it writes.
            </p>
          </div>
          <div className="workflow-grid">
            <article>
              <span className="step-number">01</span>
              <div className="step-glyph"><Image src="/sprites/workflow/declare.png" alt="" width={64} height={64} /></div>
              <h3>Declare</h3>
              <p>List each asset, its prompt, its provider, and an optional final-art quality profile in one file.</p>
              <small className="step-io">You write the manifest.</small>
              <code>pixelkiln.manifest.json</code>
            </article>
            <article>
              <span className="step-number">02</span>
              <div className="step-glyph"><Image src="/sprites/workflow/plan.png" alt="" width={64} height={64} /></div>
              <h3>Plan</h3>
              <p>Compare the manifest with the lockfile and the files on disk. The plan shows what costs money and what you can restore for free, and it makes no provider calls.</p>
              <small className="step-io">Reads the manifest, lockfile, and disk. Spends nothing.</small>
              <code>pixelkiln plan</code>
            </article>
            <article>
              <span className="step-number">03</span>
              <div className="step-glyph"><Image src="/sprites/spark.png" alt="" width={64} height={64} /></div>
              <h3>Generate</h3>
              <p>Pass a budget and PixelKiln submits, polls, and downloads. It saves each remote id before polling, so a failed download is recoverable work and not a second charge.</p>
              <small className="step-io">Writes the lockfile and the downloaded files.</small>
              <code>pixelkiln gen --budget 120</code>
            </article>
            <article>
              <span className="step-number">04</span>
              <div className="step-glyph"><Image src="/sprites/workflow/review.png" alt="" width={64} height={64} /></div>
              <h3>Review</h3>
              <p>Choose from a local candidate sheet, touch a sprite up in the gallery&apos;s editor, then approve the exact pixels you ship.</p>
              <small className="step-io">Writes your choice and approval to the lockfile.</small>
              <code>pixelkiln pick</code>
            </article>
            <article>
              <span className="step-number">05</span>
              <div className="step-glyph"><Image src="/sprites/workflow/ship.png" alt="" width={64} height={64} /></div>
              <h3>Ship</h3>
              <p>Build atlases, Aseprite sheet JSON, Godot SpriteFrames, and tilesets for Tiled and Godot. A style with a palette rule never ships a color outside it. Quality-profile styles stay blocked until approval is current.</p>
              <small className="step-io">Writes sheets and exports with provenance.</small>
              <code>pixelkiln pack</code>
            </article>
          </div>
        </section>

        <section className="review-section">
          <div className="shell review-grid">
            <div className="section-heading review-copy">
              <h2>Pick the image.<br />Edit the pixels.<br />Keep the record.</h2>
              <p className="section-deck">
                <code>pixelkiln pick</code> opens a local page with every
                candidate. It preserves native aspect ratios and stays readable on
                ultrawide displays, and a frame set counts as one choice.
                PixelKiln records every candidate and leaves the decision to you.
              </p>
              <p className="section-deck">
                Afterwards, <code>pixelkiln gallery</code> opens any generation
                with its prompt, cost, hashes, lineage, and approval, and compares
                two records side by side. With <code>--edit</code> it changes
                prompts and style fields and adds assets. With{" "}
                <code>--budget</code> it generates again under the ceiling you set.
              </p>
              <p className="section-deck">
                Regenerating keeps the version it replaces, up to a count you
                choose, and one click brings it back at no cost. Hand edits save
                beside the generated file, never over it. Open a sprite in your own
                editor with <code>pixelkiln edit</code>, or in the gallery&apos;s
                built-in{" "}
                <a href="https://pixelorama.org" rel="noreferrer">Pixelorama</a>,
                a pinned build fetched once and verified by hash. Art you edit in
                PixelLab&apos;s own editor comes back with{" "}
                <code>fetch --refresh</code>.
              </p>
              <p className="section-deck">
                PixelKiln asks providers for your palette, and <code>enforcePalette</code>{" "}
                makes it a rule: every downloaded sprite is snapped to the nearest
                palette color as it is written, while the provider&apos;s bytes stay
                in the cache. Turning the rule on or off later re-applies it to art
                you already paid for.
              </p>
              <div className="review-links">
                <TrackedLink className="text-link" id="review_gallery_docs" section="review" href="/docs/cli/gallery">
                  Browse the gallery command
                </TrackedLink>
                <TrackedLink className="text-link" id="review_edit_docs" section="review" href="/docs/getting-started#touch-art-up-by-hand">
                  Touch art up by hand
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
                  <li><span>✓</span> Bust portraits and outfit transfer onto a loop, and one <code>directions</code> list that declares a loop and mirrors the rest.</li>
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
  "generator": "character", "mode": "pro-flash",
  "template": "custom", "size": 96 },

"bot": {
  "prompt": "small round orange robot, one blue eye",
  "reference": "refs/bot-south.png" },
"bot.dented": {
  "prompt": "shell dented, one arm hanging loose",
  "state": { "of": "bot" } },
"bot.walk.west": {
  "prompt": "walking in place, short legs stepping",
  "animation": { "of": "bot", "direction": "west",
    "frames": 12, "fps": 12 } },
"bot.walk.east": { "mirror": "bot.walk.west" }`}</code></pre>
                  <div className="lock-callout top"><span>◇</span> 2 generations to rotate</div>
                  <div className="lock-callout bottom"><span>◇</span> 0 for the mirror</div>
                </div>
                <figure className="cast-loop" aria-label="Four moves of the robot, one at a time">
                  <SpriteCarousel
                    slides={[
                      { id: "walk", label: "walk", strip: "/sprites/characters/walk-loop.png", width: 1452, frames: 12, start: 1, generated: 12, cell: 108, stride: 112, fps: 12 },
                      { id: "jump", label: "jump", strip: "/sprites/characters/jump-loop.png", width: 1004, frames: 9, start: 0, generated: 8, cell: 108, stride: 112, fps: 12 },
                      { id: "power up", label: "power up", strip: "/sprites/characters/powerup-loop.png", width: 1452, frames: 12, start: 1, generated: 12, cell: 108, stride: 112, fps: 12 },
                      { id: "dance", label: "dance", strip: "/sprites/characters/dance-loop.png", width: 1452, frames: 12, start: 1, generated: 12, cell: 108, stride: 112, fps: 12 },
                    ]}
                  />
                  <figcaption>Four moves on the same robot, animated from a sentence each on the v3 engine: two generations per loop, the resting pose kept as frame 0. Each is reviewed as one set in <code>pick</code> and packed as one looping animation at the fps the manifest records. The arrows and dots are yours; it also cycles on its own.</figcaption>
                </figure>
              </div>
            </div>
          </div>
        </section>

        <section className="provider-showcase-section shell" id="providers">
          <div className="section-heading split-heading provider-showcase-heading">
            <div>
              <h2>Four providers, one review flow.</h2>
            </div>
            <p className="section-deck">
              PixelLab, Retro Diffusion, ComfyUI, and Scenario share the same
              review, lockfile, and recovery flow. The cards below show outputs from
              committed benchmark projects, one sample each. The ComfyUI card
              separates its model canvas from the recovered native pixel grid,
              because a large raster can still contain fake pixels. Its samples are
              diagnostics, not asset recommendations. A <code>style.quality</code>{" "}
              profile applies the same palette and approval gate after any
              single-image provider or an atomic ComfyUI frame set. ComfyUI and
              PixelLab both back controlled revisions, and PixelLab adds palette
              cleanup, animation, and interpolation of an existing asset.
              PixelKiln hashes the parent and mask bytes before a revision runs.
            </p>
          </div>

          <div className="provider-table-wrap">
            <table className="provider-table" aria-label="Provider support and what has run">
              <thead>
                <tr><th>Provider</th><th>Status</th><th>Billed in</th><th>What has run</th></tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">PixelLab</th>
                  <td><span className="provider-badge production">Production</span></td>
                  <td>Generations</td>
                  <td>Generation and account recovery against a live account.</td>
                </tr>
                <tr>
                  <th scope="row">Retro Diffusion</th>
                  <td><span className="provider-badge experimental">Experimental</span></td>
                  <td>USD</td>
                  <td>Single-candidate stills, live. Its other paths need paid runs.</td>
                </tr>
                <tr>
                  <th scope="row">ComfyUI</th>
                  <td><span className="provider-badge experimental">Experimental</span></td>
                  <td>Nothing (self-hosted)</td>
                  <td>Local generation, candidate review, cache recovery, and grid refinement. Atomic frame sets have automated coverage, and PixelKiln saves each accepted frame prompt before it queues the next one. They still need a live pose recipe and benchmark. The tested SDXL graph needs manual cleanup and art review.</td>
                </tr>
                <tr>
                  <th scope="row">Scenario</th>
                  <td><span className="provider-badge experimental">Experimental</span></td>
                  <td>Compute units</td>
                  <td>Paid single- and two-output generation, human review, and recovery. Ten more models, six tool models, reference-image edits, and multi-model chains ran once each.</td>
                </tr>
              </tbody>
            </table>
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
                <div><dt>Best fit</dt><dd>Large or illustrative art, reference-image edits, and chains of hosted models</dd></div>
                <div><dt>Readiness</dt><dd>Eleven image models, six tool models, and reference edits run once each; other schemas unverified</dd></div>
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
            <TrackedLink className="text-link" id="review_pixellab_mcp" section="provider_showcase" href="https://github.com/pixellab-code/pixellab-mcp" external>
              PixelLab MCP ↗
            </TrackedLink>
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
            <div className="scenario-snippet">
              <pre><code>{`"assets": {
  "knight":    { "styles": ["render"],   "prompt": "…" },
  "knight-px": { "styles": ["pixelate"], "prompt": "pixelate",
    "revision": { "mode": "image-to-image",
                  "from": "knight", "fromStyle": "render" } }
}`}</code></pre>
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

        <section className="generator-section">
          <div className="shell">
            <div className="section-heading split-heading">
              <div>
                <h2>The same sprite can cost 1 generation or 40.</h2>
              </div>
              <p className="section-deck">Measured PixelLab costs vary by up to 40×. Retro Diffusion bills in USD, Scenario in compute units, and self-hosted ComfyUI has no provider charge. PixelKiln keeps those units separate.</p>
            </div>
            <div className="generator-table">
              <div className="generator-row header"><span>Generator</span><span>Best for</span><span>Measured cost</span></div>
              <div className="generator-row"><strong>map</strong><span>Standalone props and icons</span><span><i style={{ width: "2.5%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>pixflux</strong><span>Exact closed palettes</span><span><i style={{ width: "2.5%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>imagePro</strong><span>Non-square or larger scenes, real style transfer</span><span><i style={{ width: "100%" }} /> 40 gen flat</span></div>
              <div className="generator-row"><strong>1dir</strong><span>References and candidate variety</span><span><i style={{ width: "72%" }} /> 20–40 gen</span></div>
              <div className="generator-row"><strong>tiles</strong><span>Ground and structural sets</span><span><i style={{ width: "100%" }} /> 20–40 gen</span></div>
              <div className="generator-row"><strong>terrain</strong><span>Two-terrain elevation tilesets</span><span><i style={{ width: "100%" }} /> 20–40 gen (unmeasured)</span></div>
              <div className="generator-row"><strong>isometricTile</strong><span>A single elevation tile, such as a mesa or a cliff block</span><span><i style={{ width: "2.5%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>character</strong><span>A base in 8 directions, its poses, its loops</span><span><i style={{ width: "17.5%" }} /> 1–40 gen per base by engine, 1–4 per template loop, mirrors free</span></div>
              <div className="generator-row"><strong>objectPro</strong><span>A skeleton-free prop&apos;s base, poses, and loops</span><span><i style={{ width: "17.5%" }} /> about 6 gen per base at 64px, 1 per loop (unmeasured)</span></div>
              <div className="generator-row"><strong>imageProFlash</strong><span>Styled stills on the Pro Flash model, 16–256px</span><span><i style={{ width: "22.5%" }} /> 5–9 gen (quoted)</span></div>
              <div className="generator-row"><strong>uiAsset</strong><span>UI panels, buttons, and bars from pieces and elements</span><span><i style={{ width: "50%" }} /> 20 gen (measured once)</span></div>
              <div className="generator-row"><strong>uiElement</strong><span>One UI element from a description, 16px and up</span><span><i style={{ width: "100%" }} /> 20–40 gen (unmeasured)</span></div>
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
              <h2>Give your agent the PixelKiln workflow.</h2>
              <p>The skill tells compatible agents when to plan, when to ask for a budget, when to restore existing work, when to stop for human review, and how to verify output.</p>
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
