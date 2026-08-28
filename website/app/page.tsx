import Link from "next/link";
import Image from "next/image";
import { CopyCommand } from "@/app/ui/copy-command";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";

export default function Home() {
  return (
    <>
      <main>
        <SiteHeader />

      <section className="hero shell">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" /> Pixel-art operations, under control
          </p>
          <h1>
            Fire once.
            <br />
            Ship every sprite
            <br />
            <em>with receipts.</em>
          </h1>
          <p className="hero-deck">
            PixelKiln turns generative pixel art into a deterministic build
            pipeline—planned costs, human review, exact hashes, resilient
            recovery, and engine-ready output.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/docs/getting-started">
              Read the quickstart <span aria-hidden="true">→</span>
            </Link>
            <a
              className="button button-secondary"
              href="https://github.com/gfargo/pixelkiln"
            >
              View on GitHub <span aria-hidden="true">↗</span>
            </a>
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
            <span>purpose-fit generators</span>
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
            <p className="eyebrow">One source of truth, four deliberate moves</p>
            <h2>From intent to engine—<br />without losing the thread.</h2>
          </div>
          <div className="workflow-grid">
            <article>
              <span className="step-number">01</span>
              <div className="step-glyph"><Image src="/sprites/anvil.png" alt="" width={32} height={32} /></div>
              <h3>Declare</h3>
              <p>Describe assets, styles, dimensions, palettes, references, and output paths in one committed manifest.</p>
              <code>pixelkiln.manifest.json</code>
            </article>
            <article>
              <span className="step-number">02</span>
              <div className="step-glyph"><Image src="/sprites/hammer.png" alt="" width={32} height={32} /></div>
              <h3>Plan</h3>
              <p>Diff intent against lock state and disk. See exactly what is missing, stale, recoverable, and billable.</p>
              <code>pixelkiln plan</code>
            </article>
            <article>
              <span className="step-number">03</span>
              <div className="step-glyph"><Image src="/sprites/kiln.png" alt="" width={32} height={32} /></div>
              <h3>Review</h3>
              <p>Keep selection human with a fast local candidate sheet. Nothing is silently chosen by another model.</p>
              <code>pixelkiln pick</code>
            </article>
            <article>
              <span className="step-number">04</span>
              <div className="step-glyph"><Image src="/sprites/spark.png" alt="" width={32} height={32} /></div>
              <h3>Ship</h3>
              <p>Fetch verified pixels, restore paid work, and build deterministic atlases or engine-native tilesets.</p>
              <code>pixelkiln pack</code>
            </article>
          </div>
        </section>

        <section className="review-section">
          <div className="shell review-grid">
            <div className="section-heading review-copy">
              <p className="eyebrow">Provider-neutral core · proven with PixelLab</p>
              <h2>The pipeline is portable. The proof is real.</h2>
              <p className="section-deck">
                PixelKiln keeps provider mechanics behind an adapter boundary.
                PixelLab is the production and live-tested adapter today;
                deterministic tests use the same contract, and another production
                backend can be added without rewriting project state.
              </p>
              <div className="provider-status" aria-label="Current provider support">
                <span><i className="status-dot" /> PixelLab · production</span>
                <span><i /> FakeProvider · tests</span>
                <span><i /> Next adapter · roadmap</span>
              </div>
              <p className="provider-note">
                PixelLab&apos;s official MCP is complementary: it gives agents direct
                creation tools, while PixelKiln owns planning, budget limits,
                provenance, human review, recovery, and packaging.
              </p>
              <div className="review-links">
                <Link className="text-link" href="/docs/provider-notes">Read the provider boundary →</Link>
                <a className="text-link" href="https://github.com/pixellab-code/pixellab-mcp">PixelLab MCP ↗</a>
              </div>
            </div>
            <figure className="review-visual">
              <div className="review-window-bar">
                <span>localhost · pixelkiln pick</span>
                <span>human review</span>
              </div>
              <Image
                src="/review-ui.jpg"
                alt="PixelKiln's local candidate review interface showing generated forge emblems"
                width={1280}
                height={720}
                sizes="(max-width: 980px) 100vw, 56vw"
              />
              <figcaption>Actual local review UI · generated brand sprites · no model selects for you</figcaption>
            </figure>
          </div>
        </section>

        <section className="safety-section">
          <div className="shell safety-grid">
            <div className="section-heading safety-copy">
              <p className="eyebrow">The provenance layer generation tools forget</p>
              <h2>Paid work shouldn’t disappear into vibes.</h2>
              <p className="section-deck">
                Every provider object, prompt identity, output role, path, and
                byte hash survives in project state. A failed download remains
                recoverable work—not a reason to pay twice.
              </p>
              <ul className="check-list">
                <li><span>✓</span> Remote identity saved before polling</li>
                <li><span>✓</span> Content-addressed local recovery cache</li>
                <li><span>✓</span> Manual-edit and overwrite protection</li>
                <li><span>✓</span> Transactional atlas and export writes</li>
              </ul>
              <Link className="text-link" href="/docs/recovery">Explore recovery guarantees →</Link>
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
              <p className="eyebrow">A complete asset operations layer</p>
              <h2>More than generation.</h2>
            </div>
            <p className="section-deck">PixelKiln handles the unglamorous mechanics between a good prompt and a game-ready asset library.</p>
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
              <h3>Turn source pixels into durable game assets.</h3>
              <p>Pack sheets, mount stable cells, and export lossless generic, Tiled, or Godot terrain metadata—with provenance.</p>
              <div className="format-list"><span>PNG</span><span>JSON</span><span>TILED</span><span>GODOT 4</span></div>
            </article>
          </div>
        </section>

        <section className="generator-section">
          <div className="shell">
            <div className="section-heading split-heading">
              <div>
                <p className="eyebrow">Purpose-fit routing</p>
                <h2>Use the capability you need.<br />Pay only for that.</h2>
              </div>
              <p className="section-deck">Measured PixelLab costs vary by up to 40×. PixelKiln makes generator choice explicit and keeps unlike cost units separate.</p>
            </div>
            <div className="generator-table">
              <div className="generator-row header"><span>Generator</span><span>Best for</span><span>Measured cost</span></div>
              <div className="generator-row"><strong>map</strong><span>Standalone props and icons</span><span><i style={{ width: "2.5%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>pixflux</strong><span>Exact closed palettes</span><span><i style={{ width: "2.5%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>1dir</strong><span>References and candidate variety</span><span><i style={{ width: "72%" }} /> 20–40 gen</span></div>
              <div className="generator-row"><strong>tiles</strong><span>Ground and structural sets</span><span><i style={{ width: "100%" }} /> 20–40 gen</span></div>
            </div>
            <Link className="text-link" href="/docs/generators">Compare generator capabilities →</Link>
          </div>
        </section>

        <section className="install-section shell">
          <div className="install-panel">
            <div>
              <p className="eyebrow">Official agent skill · one command</p>
              <h2>Give your agent the operating manual.</h2>
              <p>Install the provider-neutral PixelKiln skill for safe planning, hard budgets, human review, recovery-first decisions, and correct artifacts.</p>
            </div>
            <div className="install-actions">
              <CopyCommand command="npx skills add gfargo/pixelkiln@pixelkiln" />
              <div>
                <Link className="button button-primary" href="/docs/agents">Agent setup →</Link>
                <Link className="button button-secondary" href="/docs/getting-started">Library quickstart →</Link>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
