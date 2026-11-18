import Image from "next/image";
import { TrackedLink } from "@/app/ui/tracked-link";

export function GallerySection() {
  return (
        <section className="gallery-section" id="gallery">
          <div className="shell">
            <div className="section-heading">
              <h2>The whole project, one page.</h2>
              <p className="section-deck gallery-deck">
                <code>pixelkiln gallery</code> shows every generation the lockfile
                knows about, plus the assets you declared and have not made yet. It
                starts read-only. Each flag you add gives the page one more power,
                and the page says which one it is using.
              </p>
            </div>
            <figure className="review-visual gallery-hero">
              <div className="review-window-bar">
                <span>localhost <code>pixelkiln gallery</code></span>
                <span>provenance</span>
              </div>
              <Image
                src="/gallery-ui-showcase.jpg"
                alt="PixelKiln's local gallery showing 24 generated environments from three providers, with one record open"
                width={1280}
                height={720}
                sizes="(max-width: 1240px) 100vw, 1180px"
              />
              <figcaption>The environment benchmark: 24 sprites from three providers in one view, one record open.</figcaption>
            </figure>
            <div className="gallery-tiers">
              <article>
                <h3>Look</h3>
                <code>pixelkiln gallery</code>
                <small className="step-io">Reads the manifest, lockfile, and disk. Writes nothing and never contacts a provider.</small>
                <ul>
                  <li>Sprites at whole-number zoom on a checkerboard, dark, light, or your game&apos;s background color.</li>
                  <li>Each record shows the prompt that was sent, cost, hashes, lineage, and who approved it.</li>
                  <li>Search by prompt, id, or hash. Filters and the open record live in the URL, so a link lands on the same view.</li>
                  <li>Compare up to four records side by side, with every differing field tinted.</li>
                  <li>Loops play on the grid. The frame player steps, scrubs, and shows an onion skin.</li>
                  <li>A character family turns through its rotations and plays each loop by direction.</li>
                  <li>Entries the manifest no longer declares stay visible, marked undeclared, so paid work never hides.</li>
                </ul>
              </article>
              <article>
                <h3>Change</h3>
                <code>pixelkiln gallery --edit</code>
                <small className="step-io">Rewrites the manifest and nothing else. Never contacts a provider, never spends.</small>
                <ul>
                  <li>Edit prompts, sizes, tags, and style fields, and add assets. A style edit shows how many assets it changes and what regenerating them costs.</li>
                  <li>Every write offers Undo, and is refused if the manifest changed on disk since the page loaded it.</li>
                  <li>Edit a sprite in your own editor, or in the built-in <a href="https://pixelorama.org" rel="noreferrer">Pixelorama</a>, a pinned build fetched once and verified by hash.</li>
                  <li>Hand edits save beside the generated file, never over it, with the generated art as a faint layer underneath.</li>
                  <li>A <code>.glb</code> 3D model gets a live preview, and its textures open in the same editor with a guide that names each piece of the unwrap. The model updates beside the canvas as you paint, and Blender round trips land in an edited copy.</li>
                  <li>Draw a mask for an inpaint revision, or pose a skeleton for an animation.</li>
                </ul>
              </article>
              <article>
                <h3>Spend</h3>
                <code>pixelkiln gallery --budget 80</code>
                <small className="step-io">Submits work under the ceiling you set. Writes the same lockfile <code>gen</code> writes.</small>
                <ul>
                  <li>Generate what is missing, stale, or failed, from an asset, a style, or a whole character family.</li>
                  <li>A dialog lists every asset with its estimate and what the session ceiling still allows, before anything is submitted.</li>
                  <li>Candidate sets slide the <code>pick</code> sheet over the gallery. Choose there and the art downloads.</li>
                  <li>Regenerating keeps the version it replaces. Restore it for free, up to the count you choose.</li>
                  <li>Resume polls and fetches work already at the provider at no cost, and a system notification says when a job finishes.</li>
                  <li>Credentials load from the project&apos;s own <code>.env</code> and never reach the page.</li>
                </ul>
              </article>
            </div>
            <figure className="review-visual gallery-editor">
              <div className="review-window-bar">
                <span>localhost <code>pixelkiln gallery --edit</code></span>
                <span>hand edit</span>
              </div>
              <Image
                src="/gallery-editor-showcase.jpg"
                alt="PixelKiln's gallery with a benchmark fortress sprite open in the built-in Pixelorama editor, ready to save back to the project"
                width={1280}
                height={720}
                sizes="(max-width: 1240px) 100vw, 1180px"
              />
              <figcaption>The in-browser editor. It saves beside the generated file, and the next open hands the layers back as you left them.</figcaption>
            </figure>
            <div className="review-links gallery-links">
              <TrackedLink className="text-link" id="gallery_docs" section="gallery" href="/docs/cli/gallery">
                Browse the gallery command
              </TrackedLink>
              <TrackedLink className="text-link" id="gallery_workspace_docs" section="gallery" href="/docs/cli/gallery#workspace-every-project-in-one-gallery">
                Show several projects at once
              </TrackedLink>
            </div>
          </div>
        </section>
  );
}
