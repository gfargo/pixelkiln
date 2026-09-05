import Image from "next/image";
import { absoluteUrl } from "@/app/lib/metadata";
import { CopyCommand } from "@/app/ui/copy-command";
import { JsonLd } from "@/app/ui/json-ld";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";
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
          "Plan costs, review candidates, recover paid work, and package generated pixel art with recorded hashes.",
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
          "A build pipeline that plans provider costs, records human choices, restores paid work, and packages generated pixel art.",
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
            <span className="status-dot" /> Generated pixel art without guesswork
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
              Read the quickstart <span aria-hidden="true">→</span>
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
            <strong>05</strong>
            <span>provider routes</span>
          </div>
          <div>
            <strong>22</strong>
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
            <p className="eyebrow">Four steps, one committed manifest</p>
            <h2>Declare it. Price it.<br />Review it. Ship it.</h2>
          </div>
          <div className="workflow-grid">
            <article>
              <span className="step-number">01</span>
              <div className="step-glyph"><Image src="/sprites/workflow/declare.png" alt="" width={64} height={64} /></div>
              <h3>Declare</h3>
              <p>Put asset names, prompts, sizes, palettes, references, and output paths in one file.</p>
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
              <p>Choose from a local candidate sheet. PixelKiln never asks another model to pick the winner.</p>
              <code>pixelkiln pick</code>
            </article>
            <article>
              <span className="step-number">04</span>
              <div className="step-glyph"><Image src="/sprites/workflow/ship.png" alt="" width={64} height={64} /></div>
              <h3>Ship</h3>
              <p>Verify downloaded pixels, restore missing files, and build repeatable atlases or engine metadata.</p>
              <code>pixelkiln pack</code>
            </article>
          </div>
        </section>

        <section className="review-section">
          <div className="shell review-grid">
            <div className="section-heading review-copy">
              <p className="eyebrow">Human review stays local</p>
              <h2>Choose the image.<br />Keep the receipts.</h2>
              <p className="section-deck">
                PixelLab, Retro Diffusion, ComfyUI, and Scenario use the same review,
                lockfile, and recovery flow. PixelKiln records every candidate,
                then leaves the visual decision to you.
              </p>
              <div className="provider-status" aria-label="Current provider support">
                <span><i className="status-dot" /> PixelLab · production</span>
                <span><i /> Retro Diffusion · experimental</span>
                <span><i /> ComfyUI · experimental</span>
                <span><i /> Scenario · preview</span>
                <span><i /> FakeProvider · tests</span>
              </div>
              <p className="provider-note">
                PixelLab has live coverage for generation and account recovery.
                Retro Diffusion has live-tested single-candidate stills. ComfyUI
                has passed local generation, candidate review, cache recovery,
                and grid refinement. Its tested SDXL graph still needs manual
                cleanup and art review. Scenario has passed live authentication
                and CU preflight; paid generation is still waiting for its first
                benchmark.
              </p>
              <div className="review-links">
                <TrackedLink className="text-link" id="review_provider_boundary" section="review" href="/docs/provider-notes">
                  Compare providers →
                </TrackedLink>
                <TrackedLink className="text-link" id="review_provider_benchmark" section="review" href="/docs/provider-benchmark">
                  See the environment benchmark →
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
            <figure className="review-visual">
              <div className="review-window-bar">
                <span>localhost · pixelkiln pick</span>
                <span>human review</span>
              </div>
              <Image
                src="/review-ui-showcase.jpg"
                alt="PixelKiln's local candidate review interface showing generated forge emblems"
                width={1280}
                height={720}
                sizes="(max-width: 980px) 100vw, 56vw"
              />
              <figcaption>Actual local review UI · generated brand sprites · no model selects for you</figcaption>
            </figure>
          </div>
        </section>

        <section className="provider-showcase-section shell" id="providers">
          <div className="section-heading split-heading provider-showcase-heading">
            <div>
              <p className="eyebrow">Provider results</p>
              <h2>Same briefs.<br />Different pixels.</h2>
            </div>
            <p className="section-deck">
              These are outputs from committed benchmark projects. The
              ComfyUI card separates its model canvas from the recovered native
              pixel grid, because a large raster can still contain fake pixels.
              Its samples are diagnostics, not finished asset recommendations.
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
                  <figcaption>Large building · map</figcaption>
                </figure>
                <figure>
                  <Image
                    src="/benchmarks/provider-environments/pixellab/background/a/alpine-valley.png"
                    alt="PixelLab result for an alpine valley background at dusk"
                    width={256}
                    height={256}
                    sizes="(max-width: 680px) 50vw, 280px"
                  />
                  <figcaption>Scenic background · Pixflux</figcaption>
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
                  Set up PixelLab →
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
                  <figcaption>Large building · RD Plus</figcaption>
                </figure>
                <figure>
                  <Image
                    src="/benchmarks/provider-environments/retrodiffusion/background/a/alpine-valley.png"
                    alt="Retro Diffusion result for an alpine valley background at dusk"
                    width={256}
                    height={256}
                    sizes="(max-width: 680px) 50vw, 280px"
                  />
                  <figcaption>Scenic background · RD Plus</figcaption>
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
                  Set up Retro Diffusion →
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_retro_site" section="provider_showcase" href="https://www.retrodiffusion.ai/" external>
                  Visit Retro Diffusion ↗
                </TrackedLink>
              </div>
            </article>

            <article className="provider-card provider-card-comfy">
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
                  <figcaption>Refined · native 128×128 · 15 colors · transparent</figcaption>
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
                  <figcaption>Refined · native 128×128 · 24 colors</figcaption>
                </figure>
              </div>
              <p>
                SDXL Base plus Pixel Art XL found workable compositions, but
                the raw files only imitated a pixel grid. Pixel Art Fixer
                recovers editable 1× assets and applies a fixed palette.
                PixelKiln verifies those mechanical checks. You still judge the
                drawing. Build large scenes from small parts that pass review.
              </p>
              <dl>
                <div><dt>PixelKiln cost</dt><dd>0 free; hardware is external</dd></div>
                <div><dt>Quality target</dt><dd>48–128px native per part</dd></div>
                <div><dt>Best fit</dt><dd>Local composition and custom graph experiments</dd></div>
                <div><dt>Readiness</dt><dd>Refinement automated; art review required</dd></div>
              </dl>
              <div className="provider-card-links">
                <TrackedLink className="text-link" id="showcase_comfyui_recipe" section="provider_showcase" href="/docs/recipes">
                  Install tested recipe →
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_comfyui_setup" section="provider_showcase" href="/docs/comfyui">
                  Set up ComfyUI →
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_comfyui_site" section="provider_showcase" href="https://www.comfy.org/" external>
                  Visit ComfyUI ↗
                </TrackedLink>
                <TrackedLink className="text-link" id="showcase_pixel_fixer" section="provider_showcase" href="https://www.retrodiffusion.ai/tools/pixel-art-fixer/" external>
                  Try Pixel Art Fixer ↗
                </TrackedLink>
              </div>
            </article>
          </div>

          <div className="provider-showcase-links">
            <TrackedLink className="text-link" id="showcase_scenario_setup" section="provider_showcase" href="/docs/scenario">
              Set up the Scenario preview →
            </TrackedLink>
            <TrackedLink className="text-link" id="showcase_scenario_site" section="provider_showcase" href="https://www.scenario.com/" external>
              Visit Scenario ↗
            </TrackedLink>
            <TrackedLink className="text-link" id="showcase_mixed_providers" section="provider_showcase" href="/docs/mixed-providers">
              Use several providers in one project →
            </TrackedLink>
            <TrackedLink className="text-link" id="showcase_benchmark" section="provider_showcase" href="/docs/provider-benchmark">
              Review the three-provider benchmark →
            </TrackedLink>
            <TrackedLink className="text-link" id="showcase_comparison" section="provider_showcase" href="/docs/provider-notes">
              Compare provider capabilities →
            </TrackedLink>
          </div>
        </section>

        <section className="safety-section">
          <div className="shell safety-grid">
            <div className="section-heading safety-copy">
              <p className="eyebrow">Keep the record after generation</p>
              <h2>Paid work needs a paper trail.</h2>
              <p className="section-deck">
                Every provider object, prompt identity, output role, path, and
                byte hash survives in project state. A failed download remains
                recoverable work, not a reason to pay twice.
              </p>
              <ul className="check-list">
                <li><span>✓</span> Remote identity saved before polling</li>
                <li><span>✓</span> Content-addressed local recovery cache</li>
                <li><span>✓</span> Manual-edit and overwrite protection</li>
                <li><span>✓</span> Transactional atlas and export writes</li>
              </ul>
              <TrackedLink className="text-link" id="safety_recovery" section="safety" href="/docs/recovery">
                Explore recovery guarantees →
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
              <div className="lock-callout top"><span>01</span> paid-work identity</div>
              <div className="lock-callout bottom"><span>02</span> exact output bytes</div>
            </div>
          </div>
        </section>

        <section className="capabilities-section shell">
          <div className="section-heading split-heading">
            <div>
              <p className="eyebrow">What happens around generation</p>
              <h2>The prompt is only the start.</h2>
            </div>
            <p className="section-deck">PixelKiln handles the work between a prompt and the files your game loads.</p>
          </div>
          <div className="capability-grid">
            <article className="capability-card large">
              <span className="card-index">01 / PLAN</span>
              <h3>Know the bill before the fire starts.</h3>
              <p>Offline diffs distinguish new spend from zero-cost recovery. Copy the estimate into a hard budget ceiling.</p>
              <div className="budget-meter">
                <div><span>Selected work</span><strong>80 / 120</strong></div>
                <div className="meter-track"><span /></div>
              </div>
            </article>
            <article className="capability-card">
              <span className="card-index">02 / RECOVER</span>
              <h3>Restore before you regenerate.</h3>
              <p>Rebuild missing output from trusted cache bytes or a provider URL without new generation cost.</p>
              <div className="micro-state"><span className="status-dot" /> recoverable · 0 gen</div>
            </article>
            <article className="capability-card">
              <span className="card-index">03 / AUDIT</span>
              <h3>Make visual consistency measurable.</h3>
              <p>Gate palette distance, transparency, color count, outliers, and cache integrity locally or in CI.</p>
              <div className="audit-bars" aria-hidden="true"><span /><span /><span /><span /><span /></div>
            </article>
            <article className="capability-card large">
              <span className="card-index">04 / PACKAGE</span>
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
              <p className="section-deck">Measured PixelLab costs vary by up to 40×. Retro Diffusion uses USD pricing. PixelKiln makes generator choice explicit and never combines unlike cost units.</p>
            </div>
            <div className="generator-table">
              <div className="generator-row header"><span>Generator</span><span>Best for</span><span>Measured cost</span></div>
              <div className="generator-row"><strong>map</strong><span>Standalone props and icons</span><span><i style={{ width: "2.5%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>pixflux</strong><span>Exact closed palettes</span><span><i style={{ width: "2.5%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>1dir</strong><span>References and candidate variety</span><span><i style={{ width: "72%" }} /> 20–40 gen</span></div>
              <div className="generator-row"><strong>tiles</strong><span>Ground and structural sets</span><span><i style={{ width: "100%" }} /> 20–40 gen</span></div>
            </div>
            <div className="review-links">
              <TrackedLink className="text-link" id="generator_compare" section="generator" href="/docs/generators">
                Compare generator capabilities →
              </TrackedLink>
              <TrackedLink className="text-link" id="provider_compare" section="generator" href="/docs/provider-notes">
                Compare providers →
              </TrackedLink>
            </div>
          </div>
        </section>

        <section className="install-section shell">
          <div className="install-panel">
            <div>
              <p className="eyebrow">Official agent skill · one command</p>
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
                  Agent setup →
                </TrackedLink>
                <TrackedLink
                  className="button button-secondary"
                  id="install_library_quickstart"
                  section="install"
                  href="/docs/getting-started"
                >
                  Library quickstart →
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
