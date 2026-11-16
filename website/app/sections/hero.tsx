import { CopyCommand } from "@/app/ui/copy-command";
import { TrackedLink } from "@/app/ui/tracked-link";

export function HeroSection() {
  return (
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
  );
}
