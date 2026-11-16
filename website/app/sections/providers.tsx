import Image from "next/image";
import { TrackedLink } from "@/app/ui/tracked-link";

export function ProvidersSection() {
  return (
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
                  <h3>PixelLab</h3>
                  <span className="provider-badge production">Production</span>
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
                  <h3>Retro Diffusion</h3>
                  <span className="provider-badge experimental">Experimental</span>
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
                  <h3>ComfyUI</h3>
                  <span className="provider-badge experimental">Experimental</span>
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
                  <h3>Scenario</h3>
                  <span className="provider-badge experimental">Experimental</span>
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
  );
}
