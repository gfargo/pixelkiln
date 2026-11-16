import Image from "next/image";
import { TrackedLink } from "@/app/ui/tracked-link";

export function ReviewSection() {
  return (
        <section className="review-section" id="review">
          <div className="shell review-grid">
            <div className="section-heading review-copy">
              <h2>Pick the image.<br />Approve the pixels.</h2>
              <p className="section-deck">
                <code>pixelkiln pick</code> opens a local page with every
                candidate. It preserves native aspect ratios and stays readable on
                ultrawide displays, and a frame set counts as one choice.
                PixelKiln records every candidate and leaves the decision to you.
              </p>
              <p className="section-deck">
                PixelKiln asks providers for your palette, and <code>enforcePalette</code>{" "}
                makes it a rule: every downloaded sprite is snapped to the nearest
                palette color as it is written, while the provider&apos;s bytes stay
                in the cache. Turning the rule on or off later re-applies it to art
                you already paid for.
              </p>
              <div className="review-links">
                <TrackedLink className="text-link" id="review_pick_docs" section="review" href="/docs/cli/pick">
                  Read about pick
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
            </div>
          </div>
        </section>
  );
}
