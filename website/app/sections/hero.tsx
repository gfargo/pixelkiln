import { CopyCommand } from "@/app/ui/copy-command";
import { HeroReceipt } from "@/app/ui/hero-receipt";
import { TrackedLink } from "@/app/ui/tracked-link";

export function HeroSection() {
  return (
      <section className="hero shell">
        <div className="hero-copy">
          <h1>
            AI pixel art,
            <br />
            <em>with receipts.</em>
          </h1>
          <p className="hero-deck">
            PixelKiln is a build pipeline for AI pixel art. List the sprites
            you need in one manifest, see the price before you pay, pick the
            candidates you like, and ship files whose cost and hash are on
            record.
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
        </div>

        <HeroReceipt />
      </section>
  );
}
