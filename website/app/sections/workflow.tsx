import Image from "next/image";

export function WorkflowSection() {
  return (
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
  );
}
