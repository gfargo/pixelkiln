import Image from "next/image";
import { MeshViewer } from "@/app/ui/mesh-viewer";
import { SpinViewer } from "@/app/ui/spin-viewer";
import { TrackedLink } from "@/app/ui/tracked-link";

const STEPS: Array<{ name: string; text: string }> = [
  { name: "Draw", text: "The generator draws a bare figure in eight directions, then the same figure wearing each item." },
  { name: "Mesh", text: "A multi-view model builds a shape from the front, left, back and right pictures, once for the body and once for the body wearing each item." },
  { name: "Paint", text: "A second model paints each mesh, one direction at a time with that direction's picture as its reference, plus views from above and below." },
  { name: "Cut", text: "Each item is cut out of the mesh of the figure wearing it, so it fits the body it was made on." },
  { name: "Thin", text: "Every part drops to a fifth of its triangles, with its paint and relief baked back on." },
  { name: "Rig", text: "Twenty-one bones under standard humanoid names go in from joints found in the sprites. Items follow the bones under them, and skin under an item is hidden." },
  { name: "Animate", text: "Motions from a free humanoid library are carried over bone by bone." },
];

export function ModelsSection() {
  return (
    <section className="cast-section models-section" id="models">
      <div className="shell">
        <div className="section-heading models-status">
          <h2>Research you can turn in your hand.</h2>
          <p className="section-deck">
            Everything on this page came out of the scripts in the
            repository&apos;s <code>research</code> folder. None of it is a
            PixelKiln command yet. The models are real files a game engine
            imports, the numbers are measured, and the{" "}
            <TrackedLink className="text-link" id="models_research_notes" section="models" href="/docs/research-3d">research notes</TrackedLink>{" "}
            record every step, including the ones that failed.
          </p>
        </div>

        <div className="builder-block" id="mesh">
          <h3>A character in parts, on one skeleton.</h3>
          <p>
            The body and each thing it wears are separate meshes in one
            .glb, so a game can dress the same body differently. Take items
            off, pick a motion, switch the skeleton on. The file is the one
            the download link gives you: it opens in Godot with its bones,
            its animations and the list of which skin each item hides.
          </p>
          <MeshViewer subjects={["parts", "pixel", "knight", "hero"]} />
        </div>

        <div className="builder-block" id="paths">
          <h3>Two ways in, and what each costs.</h3>
          <p>
            The same pipeline runs from small sprites or from large ones.
            Small is not wrong: it is cheaper, lighter, and reads as pixel
            art. It has known limits, and they are listed here so you can
            choose. Both models above are in the viewer.
          </p>
          <figure className="models-figure">
            <Image src="/research/3d/two-paths.png" alt="The same knight twice from four directions. Above, made from 64 pixel sprites: stocky, with soft blocky colours. Below, made from 256 pixel sprites: an adult build with plates, trim and a visor painted in." width={1200} height={600} unoptimized />
            <figcaption>Above, from 64 pixel sprites. Below, from 256 pixel sprites. Same items, same skeleton, same motions.</figcaption>
          </figure>
          <div className="provider-table-wrap">
            <table className="provider-table models-table" aria-label="The pixel path and the painted path compared">
              <thead>
                <tr><th scope="col"></th><th scope="col">Pixel path</th><th scope="col">Painted path</th></tr>
              </thead>
              <tbody>
                <tr><th scope="row">Sprites</th><td>64 pixels, a body and one layer per item</td><td>256 pixels, a body and the body wearing each item</td></tr>
                <tr><th scope="row">Generations</th><td>About 53: 2 for the body, 10 a layer, under 1 for joints</td><td>About 110: 9 for the body, up to 25 a worn version, under 1 for joints</td></tr>
                <tr><th scope="row">Before meshing</th><td>The sprites, enlarged smoothly</td><td>Each sprite redrawn at 1024 pixels by an image model on your own GPU</td></tr>
                <tr><th scope="row">GPU time</th><td>About 45 minutes for a body and four items</td><td>About two hours</td></tr>
                <tr><th scope="row">Build</th><td>About four heads tall. A 64 pixel face needs a quarter of the height</td><td>About seven heads tall</td></tr>
                <tr><th scope="row">Surface</th><td>The sprite&apos;s colours, soft up close, meant for the pixel look</td><td>Plates, trim, faces and cloth painted in; reads without the pixel look</td></tr>
                <tr><th scope="row">The file here</th><td>9,300 triangles, 1.0 MB</td><td>16,500 triangles, 2.3 MB</td></tr>
                <tr><th scope="row">Known limits</th><td>Stocky proportions; thin items can come out ragged; detail tops out at what 64 pixels hold</td><td>Redrawn directions do not agree on every detail; colours can drift from the sprite; twice the cost</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="builder-block" id="pipeline">
          <h3>How a sprite becomes a model.</h3>
          <p>
            Seven steps, each a script that reads files and writes files.
            The first costs generations. The rest run on a machine with a
            12 GB graphics card and cost time.
          </p>
          <ol className="models-steps">
            {STEPS.map((step, index) => (
              <li key={step.name}>
                <span className="models-step-number">{index + 1}</span>
                <strong>{step.name}</strong>
                <span>{step.text}</span>
              </li>
            ))}
          </ol>
          <div className="review-links">
            <TrackedLink className="text-link" id="models_guide_docs" section="models" href="/docs/characters-3d">
              Read the 3D characters guide
            </TrackedLink>
            <TrackedLink className="text-link" id="models_research_docs" section="models" href="/docs/research-3d">
              Every experiment, in order
            </TrackedLink>
          </div>
        </div>

        <div className="builder-block" id="cards">
          <h3>Or keep the pixels and move them with bones.</h3>
          <p>
            A different answer to the same question. Nothing here is a
            painted mesh: each bone carries a flat card showing a piece of
            the drawn sprite, from whichever of eight directions fits how
            you see that bone. The pixels on screen are the sprite&apos;s
            own. The mesh is only there to say which pixel belongs to which
            bone.
          </p>
          <MeshViewer subjects={["cards"]} />
        </div>

        <div className="builder-block" id="turnaround">
          <h3>Sixteen directions from eight.</h3>
          <p>
            Where this started. The generator draws eight directions; the
            eight between come from carving a rough 3D shape out of the
            drawn views, rendering it from the angles between, and having an
            image model redraw each render.
          </p>
          <SpinViewer />
        </div>
      </div>
    </section>
  );
}
