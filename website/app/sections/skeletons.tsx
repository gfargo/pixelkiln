import Image from "next/image";
import { CodeBody } from "@/app/ui/code-window";
import { SpriteLoop } from "@/app/ui/sprite-loop";
import { TrackedLink } from "@/app/ui/tracked-link";

/** A GIF that holds still for people who ask for less motion. */
function Loop({ src, still, alt, size, caption }: { src: string; still: string; alt: string; size: number; caption: React.ReactNode }) {
  return (
    <figure className="skeleton-loop">
      <picture>
        <source media="(prefers-reduced-motion: reduce)" srcSet={still} />
        {/* Pixel art at its own size; next/image would resample it. */}
        <img src={src} alt={alt} width={size} height={size} loading="lazy" />
      </picture>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

const JOINTS: Array<[string, string, string]> = [
  ["nose", "NOSE", "0"],
  ["neck", "NECK", "1"],
  ["right shoulder, elbow, wrist", "RIGHT SHOULDER, RIGHT ELBOW, RIGHT ARM", "2, 3, 4"],
  ["left shoulder, elbow, wrist", "LEFT SHOULDER, LEFT ELBOW, LEFT ARM", "5, 6, 7"],
  ["right hip, knee, ankle", "RIGHT HIP, RIGHT KNEE, RIGHT LEG", "8, 9, 10"],
  ["left hip, knee, ankle", "LEFT HIP, LEFT KNEE, LEFT LEG", "11, 12, 13"],
  ["eyes", "RIGHT EYE, LEFT EYE", "14, 15"],
  ["ears", "RIGHT EAR, LEFT EAR", "16, 17"],
];

const SIZES: Array<[string, string, string, string]> = [
  ["64px", "6 × 5 px", "the wrist", "The 18 joints. Items are pinned a little past the wrist."],
  ["128px", "12 × 7 px", "which way the hand points", "18 + 1 per hand: turn a held sword the way the hand points."],
  ["256px", "24 × 14 px, thumb apart", "knuckles, fingertip, thumb", "18 + 4 per hand: close a hand around a handle; a 3D rig with a thumb and one finger chain."],
  ["larger", "each finger drawn", "every finger joint", "18 + 21 per hand (OpenPose, MediaPipe); 15 finger bones per hand (Godot, VRM)."],
];

const KINDS: Array<[string, string, string]> = [
  ["A keypoints file", "Committed JSON beside the manifest", "You, joint by joint"],
  ["An anchors file", "Committed JSON, one entry per frame", "Nobody: it records where the joints already are"],
  ["PixelLab's stored 3D skeleton", "Your PixelLab account, with a v3 character", "PixelLab, from a template or a sentence"],
  ["An OpenPose map", "A committed PNG per frame", "You, or a script"],
  ["A 3D rig", "The research's model files", "Motion data, retargeted"],
];

export function SkeletonsSection() {
  return (
    <section className="cast-section skeletons-section" id="skeletons">
      <div className="shell">
        <figure className="cast-strip" aria-label="A skeleton estimated from a sprite and moved into a wave">
          <Image src="/showcase/skeleton/base-wave-poses.png" alt="A bare figure nine times, each with an 18-joint skeleton drawn over it: the estimated pose with both arms at its sides, then eight poses raising its right arm into a wave" width={1768} height={200} unoptimized />
          <figcaption>
            <code>pixelkiln skeleton-preview</code>: the pose PixelLab estimated from the sprite, at full strength,
            with both arms down at its sides as they are in the picture, then the eight poses edited from it
            into a wave, each over a dimmed copy. Orange is the figure&apos;s right side, blue its left. Drawn
            locally, for nothing.
          </figcaption>
        </figure>

        <div className="cast-grid">
          <div className="section-heading cast-copy">
            <h2>One skeleton, everywhere a pose is needed.</h2>
            <p className="section-deck">
              A skeleton is 18 points: nose, neck, ears and eyes, and each shoulder, elbow, wrist, hip, knee
              and ankle. PixelKiln estimates one from any sprite, draws it over the art so you can check it,
              and keeps it as a JSON file you can edit and commit.
            </p>
            <p className="section-deck">
              The same 18 points then do several jobs. They pose an animation frame by frame. They find the
              hand to pin a sword to in every frame of every walk. As an OpenPose map they pose frames drawn
              on your own GPU, and in the 3D research they become a rig. Each tool reads the skeleton the same
              way.
            </p>
            <ul className="check-list cast-list">
              <li><span className="tick" aria-hidden="true" /> <code>estimate-skeleton</code> reads the 18 joints from a square sprite (16 to 256px) for 0.1 generation.</li>
              <li><span className="tick" aria-hidden="true" /> <code>skeleton-preview</code> draws every pose over the art, locally, so a wrong elbow is caught before anything is paid for.</li>
              <li><span className="tick" aria-hidden="true" /> An <code>animate-skeleton</code> revision turns 3 to 15 poses into frames: eight at 64px billed 3 generations.</li>
              <li><span className="tick" aria-hidden="true" /> A <code>skeleton-v3</code> loop poses the 3D skeleton PixelLab keeps for a v3 character, from a template or a sentence: 3 generations a direction.</li>
              <li><span className="tick" aria-hidden="true" /> <code>anchors</code> records the skeleton of every frame once per character, and every held item reads it.</li>
            </ul>
            <div className="review-links">
              <TrackedLink className="text-link" id="skeletons_guide_docs" section="skeletons" href="/docs/skeletons">
                Read the skeletons guide
              </TrackedLink>
              <TrackedLink className="text-link" id="skeletons_revisions_docs" section="skeletons" href="/docs/revisions#skeleton-driven-animation">
                Animating from poses
              </TrackedLink>
            </div>
          </div>
          <div className="cast-visuals">
            <div className="lock-visual cast-manifest" aria-label="Estimating a skeleton and animating from it">
              <div className="lock-label">terminal, then pixelkiln.manifest.json</div>
              <CodeBody language="json" code={`
// pixelkiln estimate-skeleton base-south.png \\
//   --out poses/estimate.json --frames 8
// (edit the eight poses, check them with skeleton-preview)

"base-wave": {
  "prompt": "wave",
  "revision": {
    "mode": "animate-skeleton",
    "from": "base",
    "keypointsFile": "poses/wave.json",
    "direction": "south",
    "description": "bald figure in grey briefs" } }
`} />
              <div className="lock-callout top"><span>◇</span> 0.1 to estimate</div>
              <div className="lock-callout bottom"><span>◇</span> 3 for eight frames</div>
            </div>
            <div className="skeleton-loops">
              <figure className="skeleton-loop">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/showcase/skeleton/base-south.png" alt="The bare figure standing with both arms at its sides" width={256} height={256} loading="lazy" />
                <figcaption><b>The sprite.</b> The paperdoll&apos;s bare base, facing south, 64×64. Nothing on its back for the estimate to mistake for an arm.</figcaption>
              </figure>
              <Loop
                src="/showcase/skeleton/base-wave.gif"
                still="/showcase/skeleton/base-wave-still.png"
                alt="The same figure raising its right arm and waving, following the edited poses"
                size={256}
                caption={<><b>From your poses.</b> The eight skeletons above, sent with <code>animate-skeleton</code>. 8 frames at 64×64, 3 generations.</>}
              />
            </div>
          </div>
        </div>

        <div className="builder-block" id="uses">
          <h3>Where the skeleton is used.</h3>
          <p>
            These are the places a skeleton turns up in PixelKiln, in the order a character usually meets them.
            The first two are free; the rest say what they cost.
          </p>
          <ol className="skeleton-uses">
            <li>
              <h4>Estimate and correct</h4>
              <p>
                <code>pixelkiln estimate-skeleton</code> writes the pose and copies of it to move; the gallery&apos;s{" "}
                <b>+ Skeleton animation</b> form does the same and declares the revision. Check the starting
                pose first: PixelLab redraws it to learn the sprite&apos;s colours, and a pose that does not match
                the picture degrades every frame without an error.
              </p>
              <TrackedLink className="text-link" id="skeletons_use_estimate" section="skeletons" href="/docs/skeletons#estimate-one">Estimating a skeleton</TrackedLink>
            </li>
            <li>
              <h4>Animate from your poses</h4>
              <p>
                An <code>animate-skeleton</code> revision draws one frame per pose you set. You control the
                motion exactly; the poses are yours to commit and review.
              </p>
              <TrackedLink className="text-link" id="skeletons_use_animate" section="skeletons" href="/docs/skeletons#animate-from-poses">Animating from poses</TrackedLink>
            </li>
            <li>
              <h4>Animate through the character&apos;s own skeleton</h4>
              <p>
                A <code>skeleton-v3</code> loop poses the 3D skeleton PixelLab keeps with a character drawn on
                the v3 engine. A <code>standard</code> base has none, so <code>plan</code> refuses it. You never see
                those joints; PixelLab moves them from a template or a sentence.
              </p>
              <TrackedLink className="text-link" id="skeletons_use_v3" section="skeletons" href="/characters">Characters and loops</TrackedLink>
            </li>
            <li className="skeleton-use-wide">
              <div>
                <h4>Pin items to a hand</h4>
                <p>
                  A held item in a paperdoll is a sprite placed on the hand, a little past the wrist, in every
                  frame. <code>pixelkiln anchors</code> estimates each frame&apos;s skeleton once per character: 56
                  frames cost 5.6 generations, placing costs nothing, and the sword stayed in the right hand in
                  all 56.
                </p>
                <TrackedLink className="text-link" id="skeletons_use_anchors" section="skeletons" href="/paperdoll">Paperdoll layers</TrackedLink>
              </div>
              <SpriteLoop strip="/sprites/paperdoll/showcase-walk-knight.png" width={572} frames={6} cell={92} stride={96} scale={2} seconds={0.75} label="An armoured knight walking toward the viewer, the greatsword pinned to its right hand in every frame" />
            </li>
            <li>
              <h4>Pose frames on your own GPU</h4>
              <p>
                With ComfyUI, an OpenPose ControlNet poses each frame from an OpenPose map: the same 18 joints
                drawn as coloured limbs. A recipe for this is in progress; the maps have to keep scale, camera
                and ground line fixed across a set.
              </p>
              <TrackedLink className="text-link" id="skeletons_use_comfyui" section="skeletons" href="/docs/skeletons#pose-frames-you-draw-yourself">Pose maps</TrackedLink>
            </li>
            <li>
              <h4>Rig a 3D model</h4>
              <p>
                The 3D research builds a mesh from the eight drawn directions, binds it to a skeleton and drives
                it with motion. It is research, not a command yet, and the notes show every step.
              </p>
              <TrackedLink className="text-link" id="skeletons_use_3d" section="skeletons" href="/docs/research-3d">3D research notes</TrackedLink>
            </li>
          </ol>
        </div>

        <div className="builder-block" id="resolution">
          <h3>More pixels, more skeleton.</h3>
          <p>
            The 18 joints stop at the wrist, and on a 64px sprite that is all a hand has room for. At 128px a
            hand points somewhere; at 256px, the size of the bodies the 3D work starts from, it has knuckles and
            a separate thumb. So the skeleton should grow with the sprite: hands matter for a character that
            grips a sword or a staff, and for one drawn as the source of a 3D model. Hand points are not
            estimated by anything yet; the yellow ones below were read off the drawing.
          </p>
          <figure className="skeleton-resolution">
            <Image src="/showcase/skeleton/resolution.png" alt="The same kind of figure at 64, 128 and 256px with its estimated 18-joint skeleton, and each right hand enlarged: at 64px only the wrist, at 128px the wrist and a fingertip, at 256px the knuckles, the fingertip and the thumb" width={1176} height={632} unoptimized />
            <figcaption>
              A native 64px figure and a native 256px one from PixelLab; the 128px figure is the 256px drawing
              reduced. The body skeletons are each a real <code>estimate-skeleton</code>. Even at 256px the four
              fingers are one block, so four hand points is what it can honestly carry.
            </figcaption>
          </figure>
          <div className="provider-table-wrap skeleton-table-wrap">
            <table className="provider-table skeleton-table" aria-label="How much of a hand each sprite size can carry">
              <thead>
                <tr><th scope="col">Sprite</th><th scope="col">Hand past the wrist</th><th scope="col">It can carry</th><th scope="col">Skeleton that fits</th></tr>
              </thead>
              <tbody>
                {SIZES.map(([size, hand, carry, fits]) => (
                  <tr key={size}><th scope="row">{size}</th><td>{hand}</td><td>{carry}</td><td>{fits}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="skeleton-subhead">Finding the hand points.</h3>
          <p>
            Two tools were tried on the same three hands. PixelLab&apos;s custom skeleton (a beta MCP tool,
            1 generation) adds a hand, fingers and a thumb to the rig by itself when told the figure grips
            something. MediaPipe&apos;s Hand Landmarker runs on your own machine for nothing. At 256px MediaPipe
            was closest, missing by 7 to 9% of the hand&apos;s length against PixelLab&apos;s 10%, and found the hand
            every time. At 128px it found it only at the sprite&apos;s own size or doubled. At 64px it found
            nothing, and PixelLab&apos;s points were close to a guess.
          </p>
          <figure className="skeleton-resolution skeleton-trial">
            <Image src="/showcase/skeleton/hand-trial.png" alt="The right hand at 64, 128 and 256px with the hand-placed points as white rings, PixelLab's points in orange and MediaPipe's in green; MediaPipe finds no hand at 64px" width={794} height={730} unoptimized />
            <figcaption>
              White rings: placed by eye. Orange: PixelLab&apos;s custom skeleton. Green: MediaPipe at the
              sprite&apos;s own size, on white. One T-posed figure per size with open hands, the easiest case;{" "}
              <TrackedLink className="text-link" id="skeletons_hand_trial" section="skeletons" href="/docs/skeletons#finding-hand-points-pixellab-or-mediapipe">the guide</TrackedLink>{" "}
              has every enlargement and both grounds.
            </figcaption>
          </figure>
          <p className="skeleton-after">
            Which libraries and engines take which skeleton, with their licenses, is in{" "}
            <TrackedLink className="text-link" id="skeletons_formats" section="skeletons" href="/docs/skeletons#formats-libraries-and-rigs">the guide&apos;s formats table</TrackedLink>:
            OpenPose and MediaPipe use 21 points a hand, Godot and VRM 15 finger bones, and PixelLab none.
          </p>
        </div>

        <div className="builder-block" id="props">
          <h3>Staffs, swords, capes and hats.</h3>
          <p>
            A body skeleton knows nothing about what a character carries or wears, yet those parts decide how
            it animates: a staff is rigid and follows the hand, a cape hangs from the shoulders and bends.
            Asked about a wizard swinging a staff or a knight with a cape, PixelLab&apos;s custom skeleton (a
            beta MCP tool, 1 generation) added joints for every prop by itself. MediaPipe, free on your own
            machine, knows only bodies, but its masks separate the body from a cape and clothes from
            accessories: a first guess at what may bend.
          </p>
          <figure className="skeleton-resolution skeleton-props">
            <Image src="/showcase/skeleton/rigging-tools.png" alt="Four characters in rows: an adventurer, a caped figure, a knight and a mage. Columns: PixelLab's 18 joints; MediaPipe's 33-point body; the extra joints PixelLab's custom skeleton added for capes, a sword, a shield, horns, a staff and a hat; and MediaPipe's segmenter colouring skin, clothes and accessories" width={1166} height={1106} unoptimized />
            <figcaption>
              PixelLab&apos;s 18 joints misread the adventurer&apos;s pack as raised arms, and MediaPipe found no body
              at all. MediaPipe got the knight wrong but scored it 0.44 against 0.99 on good figures, so its
              own score tells you to discard it. The custom rig hung the sword and staff from the wrist and the
              capes from the shoulders.
            </figcaption>
          </figure>
          <ul className="check-list cast-list skeleton-findings">
            <li><span className="tick" aria-hidden="true" /> Props and capes: PixelLab&apos;s custom skeleton. Rigid items hang from the wrist, capes from the shoulders and hips.</li>
            <li><span className="tick" aria-hidden="true" /> Bodies at 256px: MediaPipe, free. Its Holistic model returned body, both hands and 478 face points in one call.</li>
            <li><span className="tick" aria-hidden="true" /> Depth for 3D: MediaPipe gives every body point a 3D position; PixelLab&apos;s joints are flat.</li>
            <li><span className="tick" aria-hidden="true" /> Dressed characters fool both. Check every estimate over the art before animating from it.</li>
          </ul>
          <p className="skeleton-after">
            <TrackedLink className="text-link" id="skeletons_props" section="skeletons" href="/docs/skeletons#props-capes-and-hats">The full comparison</TrackedLink>{" "}
            covers every figure, how each part maps onto 3D rigs and engines, and what was not tried.
          </p>
        </div>

        <div className="builder-block" id="joints">
          <h3>The 18 joints.</h3>
          <p>
            PixelLab and OpenPose name the same 18 points, so a pose made for one converts to the other.
            PixelLab keeps each as <code>{"{label, x, y, z_index}"}</code> with <code>x</code> and <code>y</code> from 0 to 1;
            OpenPose draws them as an image, telling left from right by colour. Right is the character&apos;s own
            right: facing you, its right hand is on your left. <code>ARM</code> is the wrist and <code>LEG</code> the ankle.
          </p>
          <div className="provider-table-wrap skeleton-table-wrap">
            <table className="provider-table skeleton-table" aria-label="The 18 joints in PixelLab and OpenPose">
              <thead>
                <tr><th scope="col">Joint</th><th scope="col">PixelLab label</th><th scope="col">OpenPose index</th></tr>
              </thead>
              <tbody>
                {JOINTS.map(([joint, label, index]) => (
                  <tr key={joint}><th scope="row">{joint}</th><td><code>{label}</code></td><td>{index}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="builder-block" id="which">
          <h3>Which skeleton is which.</h3>
          <p>
            Five skeletons share those 18 joints, and they are kept in different places. The files are local, so
            PixelKiln hashes and checks them. A stored 3D skeleton never leaves PixelLab, so PixelKiln cannot show
            or edit it.
          </p>
          <div className="provider-table-wrap skeleton-table-wrap">
            <table className="provider-table skeleton-table" aria-label="The kinds of skeleton, where each lives, and what moves it">
              <thead>
                <tr><th scope="col">Skeleton</th><th scope="col">Where it lives</th><th scope="col">Who moves it</th></tr>
              </thead>
              <tbody>
                {KINDS.map(([kind, where, who]) => (
                  <tr key={kind}><th scope="row">{kind}</th><td>{where}</td><td>{who}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
