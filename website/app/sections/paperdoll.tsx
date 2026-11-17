import Image from "next/image";
import { CodeBody } from "@/app/ui/code-window";
import { CharacterBuilder } from "@/app/ui/character-builder";
import { SpriteCarousel } from "@/app/ui/sprite-carousel";
import { SpriteLoop } from "@/app/ui/sprite-loop";
import { TrackedLink } from "@/app/ui/tracked-link";

export function PaperdollSection() {
  return (
        <section className="cast-section paperdoll-section" id="paperdoll">
          <div className="shell">
            <figure className="cast-strip" aria-label="A base, three layers, and the dressed character">
              <div className="cast-strip-row">
                <Image src="/sprites/paperdoll/showcase-stack.png" alt="A bare figure in underwear, black plate armour with no body in it, a horned helm and a fur-collared cape with no body in them, a runed greatsword and a shield, and all of them stacked into a dark knight" width={476} height={92} unoptimized />
                <SpriteLoop strip="/sprites/paperdoll/showcase-8dir.png" width={764} frames={8} cell={92} stride={96} scale={2} seconds={2.4} label="The dressed character turning through its eight directions" />
              </div>
              <figcaption>Left to right: the bare base in its underwear layer; plate armour for the legs and the chest; a horned helm and a war cape; a greatsword and a shield; and all of them drawn in order. Eight layers, each its own asset and its own PNG per frame.</figcaption>
            </figure>
            <div className="cast-grid">
              <div className="section-heading cast-copy">
                <h2>Every outfit is a layer.</h2>
                <p className="section-deck">
                  A <code>layer</code> asset draws its prompt over frames you
                  already have and returns only what it added: a transparent
                  PNG for every frame of every animation, each one lined up
                  with the frame it was painted on. A shirt, trousers, a hat
                  and a sword are four separate layers, so a game can switch
                  each one on its own.
                </p>
                <p className="section-deck">
                  Every frame goes onto one sheet and is repainted in one
                  masked inpaint, which is what keeps an outfit the same
                  across a walk and across eight directions. The skin is
                  keyed cyan first so it can be told from the clothes
                  afterwards, and part of every figure is masked off so the
                  poses cannot move. Each step leaves its file on disk, and a
                  mask you paint yourself replaces the computed one.
                </p>
                <ul className="check-list cast-list">
                  <li><span className="tick" aria-hidden="true" /> 56 frames dressed by one request: 8 rotations and a walk in 8 directions, for 25 generations.</li>
                  <li><span className="tick" aria-hidden="true" /> The character on this page: a base, four walks, fifteen drawn layers and five held items, 32 frames each, for about 445 generations.</li>
                  <li><span className="tick" aria-hidden="true" /> <code>region</code> picks what may change: the body for clothing, the head for hats, the space around the body for capes and packs.</li>
                  <li><span className="tick" aria-hidden="true" /> <code>attach</code> pins a sprite you already have to the hand in every frame, for nothing, so it is the same item in every frame and always in the same hand. <code>grasp</code> adds one small inpaint that closes the fingers around it.</li>
                  <li><span className="tick" aria-hidden="true" /> A drawn layer recolours for nothing: one <code>derive</code> turns a crimson cape blue in every frame and leaves its fur collar grey.</li>
                  <li><span className="tick" aria-hidden="true" /> <code>offset</code> nudges a layer by the pixel, for every frame or one loop, and changing it costs nothing: the frames are moved again at download.</li>
                  <li><span className="tick" aria-hidden="true" /> <code>clean</code> on a loop strips the ghost pixels an animation model leaves, at download, for nothing: 608 stray pixels down to 2 on this walk.</li>
                  <li><span className="tick" aria-hidden="true" /> Regenerate the base or a loop and its layers go stale, like everything else drawn from it.</li>
                </ul>
                <div className="review-links">
                  <TrackedLink className="text-link" id="paperdoll_guide_docs" section="paperdoll" href="/docs/paperdoll">
                    Read the paperdoll guide
                  </TrackedLink>
                  <TrackedLink className="text-link" id="paperdoll_limits_docs" section="paperdoll" href="/docs/paperdoll/cost-and-limits">
                    What it costs and where it stops
                  </TrackedLink>
                </div>
              </div>
              <div className="cast-visuals">
                <div className="lock-visual cast-manifest" aria-label="A base, a cleaned walk, two drawn layers and a placed sword in the manifest">
                  <div className="lock-label">pixelkiln.manifest.json</div>
                  <CodeBody language="json" code={`
"hero": {
  "prompt": "bald bare humanoid base body, plain skin" },
"hero.walk": {
  "animation": { "of": "hero", "template": "walking",
    "clean": true, "directions": ["south", "east"] } },

"hero.leather": {
  "prompt": "Dress every masked cyan mannequin in the
    same leather ranger armour. Keep the skin cyan.",
  "layer": { "of": ["hero", "hero.walk.south",
    "hero.walk.east"] } },
"hero.hat": {
  "prompt": "The same feathered ranger hat on every head.",
  "layer": { "of": ["hero", "hero.walk.south",
    "hero.walk.east"], "region": "head", "padding": 10 } },
"hero.sword": {
  "layer": { "of": ["hero", "hero.walk.south",
    "hero.walk.east"], "attach": {
      "item": "items/sword-{direction}.png",
      "anchors": "anchors/hero.json" } } }
`} />
                  <div className="lock-callout top"><span>◇</span> one request per layer</div>
                  <div className="lock-callout bottom"><span>◇</span> one PNG per frame</div>
                </div>
                <figure className="cast-loop" aria-label="The same walk as the base and with layers added">
                  <SpriteCarousel
                    slides={[
                      { id: "dark knight", label: "dark knight", strip: "/sprites/paperdoll/showcase-walk-knight.png", width: 572, frames: 6, start: 0, generated: 6, cell: 92, stride: 96, fps: 8 },
                      { id: "archmage", label: "archmage", strip: "/sprites/paperdoll/showcase-walk-mage.png", width: 572, frames: 6, start: 0, generated: 6, cell: 92, stride: 96, fps: 8 },
                      { id: "assassin", label: "assassin", strip: "/sprites/paperdoll/showcase-walk-assassin.png", width: 572, frames: 6, start: 0, generated: 6, cell: 92, stride: 96, fps: 8 },
                      { id: "dragonborn", label: "dragonborn", strip: "/sprites/paperdoll/showcase-walk-dragonborn.png", width: 572, frames: 6, start: 0, generated: 6, cell: 92, stride: 96, fps: 8 },
                    ]}
                  />
                  <figcaption>One template walk, drawn once, then dressed four ways from the same twenty layers. Armour, robes, hair, headwear, wings, capes and the quiver were each drawn by one masked inpaint over all 32 frames. The greatsword, staff, dagger, shield and torch were each drawn once as an object and pinned to a hand, which is why they never change sides; four of them then had the hand redrawn around the handle.</figcaption>
                </figure>
              </div>
            </div>
            <div className="builder-block" id="paperdoll-builder">
              <h3>Dress one yourself.</h3>
              <p>
                Every button below switches one layer on or off. Each layer
                is its own asset in the manifest and its own PNG per frame,
                made without knowing about the others: armour, robes, hair,
                headwear and what is worn on the back were each drawn by one
                masked inpaint, and what is held is one sprite pinned to the
                hand, most with the fingers redrawn around it. The ones marked
                recoloured cost nothing: they are a drawn layer with its hue
                turned. So do the skins: the bare base recoloured, with every
                layer going over it unchanged and the fingers on a held item
                recoloured to match. The page
                stacks them and steps them through the same 32 frames, which
                is all a game has to do. The nudge moves the headwear by whole
                pixels, the way <code>offset</code> does in a manifest.
              </p>
              <CharacterBuilder />
            </div>
          </div>
        </section>
  );
}
