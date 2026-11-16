import Image from "next/image";
import { FeatureArt } from "@/app/ui/feature-art";
import { TrackedLink } from "@/app/ui/tracked-link";

/** What the pipeline hands back: real files from three kinds of asset, each leading to its page. */
export function OutputsSection() {
  return (
    <section className="outputs-section shell" id="outputs">
      <div className="section-heading split-heading">
        <div>
          <h2>What comes out.</h2>
        </div>
        <p className="section-deck">
          The same five steps make a single sprite, a character with its loops, or a wardrobe of layers, and one local page to review them in. These are from real runs.
        </p>
      </div>
      <div className="outputs-grid">
        <TrackedLink id="outputs_characters" section="feature_page" href="/characters">
          <FeatureArt id="characters" />
          <strong>A character in eight directions</strong>
        </TrackedLink>
        <TrackedLink id="outputs_review" section="feature_page" href="/review">
          <FeatureArt id="review" />
          <strong>A gallery of every file, with its cost</strong>
        </TrackedLink>
        <TrackedLink id="outputs_editor" section="feature_page" href="/review#gallery">
          <div className="feature-art feature-art-shot">
            <Image src="/gallery-editor-showcase.jpg" alt="The gallery's pixel editor open on a sprite" width={1280} height={720} sizes="(max-width: 980px) 100vw, 560px" />
          </div>
          <strong>Touch-ups in the browser, kept beside the original</strong>
        </TrackedLink>
        <TrackedLink id="outputs_paperdoll" section="feature_page" href="/paperdoll">
          <FeatureArt id="paperdoll" />
          <strong>Layers that stack into one figure</strong>
        </TrackedLink>
      </div>
    </section>
  );
}
