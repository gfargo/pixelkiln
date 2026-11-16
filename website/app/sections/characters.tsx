import Image from "next/image";
import { CodeBody } from "@/app/ui/code-window";
import { SpriteCarousel } from "@/app/ui/sprite-carousel";
import { SpriteLoop } from "@/app/ui/sprite-loop";
import { TrackedLink } from "@/app/ui/tracked-link";

export function CharactersSection() {
  return (
        <section className="cast-section" id="characters">
          <div className="shell">
            <figure className="cast-strip" aria-label="One character facing eight directions">
              <div className="cast-strip-row">
                <Image src="/sprites/characters/robot-8dir.png" alt="A round orange robot drawn facing south, south-west, west, north-west, north, north-east, east, and south-east" width={796} height={96} unoptimized />
                <SpriteLoop strip="/sprites/characters/robot-8dir.png" width={796} frames={8} cell={96} stride={100} scale={2} seconds={2.4} label="The same robot turning through its eight directions" />
              </div>
            </figure>
            <div className="cast-grid">
              <div className="section-heading cast-copy">
                <h2>Draw the base once.</h2>
                <p className="section-deck">
                  A <code>character</code> style holds a base drawn facing 4 or 8
                  directions, states that apply a pose or an outfit to every
                  direction at once, and loops, one direction each. Every one is
                  an asset with its own record and files, so <code>plan</code>{" "}
                  prices the cast, one <code>gen</code> runs it in waves (bases,
                  then states, then loops), and <code>pack --format godot</code>{" "}
                  writes a SpriteFrames with every direction and every loop.
                </p>
                <p className="section-deck">
                  Start from a prompt on any of PixelLab&apos;s four engines, or
                  from your own south-facing sprite: <code>reference</code> hands
                  it over and pro-flash rotates it for one generation at 64px.
                  Regenerate the base and its states and loops go stale, never
                  silently mismatched. Characters already on your account come
                  under the manifest with <code>adopt</code>, and the gallery
                  shows the family: states under their base, loops with their
                  direction, mirrors with their source.
                </p>
                <ul className="check-list cast-list">
                  <li><span className="tick" aria-hidden="true" /> A loop facing east is the west loop flipped. <code>mirror</code> makes it locally for nothing; eight directions of one walk cost 5, not 8.</li>
                  <li><span className="tick" aria-hidden="true" /> Poses from a text edit, loops from a template or from text, with start and end poses you supply.</li>
                  <li><span className="tick" aria-hidden="true" /> Concept images and style anchors on pro, style images with chosen traits on pro-flash.</li>
                  <li><span className="tick" aria-hidden="true" /> Bust portraits and outfit transfer onto a loop, and one <code>directions</code> list that declares a loop and mirrors the rest.</li>
                </ul>
                <div className="review-links">
                  <TrackedLink className="text-link" id="cast_manifest_docs" section="characters" href="/docs/characters">
                    Read the character reference
                  </TrackedLink>
                  <TrackedLink className="text-link" id="cast_mirror_docs" section="characters" href="/docs/characters#mirrors">
                    How mirrors work
                  </TrackedLink>
                </div>
              </div>
              <div className="cast-visuals">
                <div className="lock-visual cast-manifest" aria-label="A character family in the manifest">
                  <div className="lock-label">pixelkiln.manifest.json</div>
                  <CodeBody language="json" code={`
"cast": {
  "generator": "character", "mode": "pro-flash",
  "template": "custom", "size": 96 },

"bot": {
  "prompt": "small round orange robot, one blue eye",
  "reference": "refs/bot-south.png" },
"bot.dented": {
  "prompt": "shell dented, one arm hanging loose",
  "state": { "of": "bot" } },
"bot.walk.west": {
  "prompt": "walking in place, short legs stepping",
  "animation": { "of": "bot", "direction": "west",
    "frames": 12, "fps": 12 } },
"bot.walk.east": { "mirror": "bot.walk.west" }
`} />
                  <div className="lock-callout top"><span>◇</span> 2 generations to rotate</div>
                  <div className="lock-callout bottom"><span>◇</span> 0 for the mirror</div>
                </div>
                <figure className="cast-loop" aria-label="Four moves of the robot, one at a time">
                  <SpriteCarousel
                    slides={[
                      { id: "walk", label: "walk", strip: "/sprites/characters/walk-loop.png", width: 1452, frames: 12, start: 1, generated: 12, cell: 108, stride: 112, fps: 12 },
                      { id: "jump", label: "jump", strip: "/sprites/characters/jump-loop.png", width: 1004, frames: 9, start: 0, generated: 8, cell: 108, stride: 112, fps: 12 },
                      { id: "power up", label: "power up", strip: "/sprites/characters/powerup-loop.png", width: 1452, frames: 12, start: 1, generated: 12, cell: 108, stride: 112, fps: 12 },
                      { id: "dance", label: "dance", strip: "/sprites/characters/dance-loop.png", width: 1452, frames: 12, start: 1, generated: 12, cell: 108, stride: 112, fps: 12 },
                    ]}
                  />
                  <figcaption>Four moves on the same robot, animated from a sentence each on the v3 engine: two generations per loop, the resting pose kept as frame 0. Each is reviewed as one set in <code>pick</code> and packed as one looping animation at the fps the manifest records. The arrows and dots are yours; it also cycles on its own.</figcaption>
                </figure>
              </div>
            </div>
          </div>
        </section>
  );
}
