# Characters

A `character` style holds one PixelLab character as three kinds of asset: a
base drawn facing 4 or 8 directions, states that apply a pose or an outfit
to every direction at once, and loops, one direction each. Each is an asset
with its own lockfile record and files, so `plan` prices the cast, one `gen`
runs it in waves, and `pack` writes every direction and loop for the engine.
This page is the reference for the manifest shapes; the [manifest
reference](./MANIFEST.md) covers the fields every asset shares.

## The three shapes

A cast in full, with a base, a state, and two loops. This is the robot on
the [site](https://pixelkiln.griffen.codes/#characters), drawn the way the
example says:

![The robot facing south, south-west, west, north-west, north, north-east, east, and south-east](../website/public/sprites/characters/robot-8dir.png)

```json
{
  "styles": {
    "cast": {
      "generator": "character",
      "outDir": "art/characters",
      "view": "side",
      "size": 96,
      "mode": "pro-flash",
      "template": "custom"
    }
  },
  "assets": {
    "bot": {
      "prompt": "small round orange robot with one blue eye, short jointed legs"
    },
    "bot.dented": {
      "prompt": "shell dented and scuffed, one arm hanging loose, eye dim",
      "state": { "of": "bot", "paletteFromReference": true }
    },
    "bot.walk": {
      "prompt": "walking forward in place, short legs stepping, body bobbing slightly",
      "animation": { "of": "bot", "direction": "south", "frames": 12, "fps": 12 }
    },
    "bot.jump": {
      "prompt": "crouching down, springing up into the air with legs tucked, landing with a small bounce",
      "animation": { "of": "bot", "direction": "south", "frames": 8, "fps": 12 }
    }
  }
}
```

![The robot's resting pose and twelve frames of it walking](../website/public/sprites/characters/walk-loop.png)

The robot is round, so its style names the `custom` skeleton template and
its loops come from a sentence each on the v3 engine; a biped on the
`mannequin` template could take a template loop instead
(`"animation": { "of": "bot", "template": "walk" }`), one generation per
direction. See [Animations](#animations).

### The base

A base is a prompt, wrapped in the style's prefix and suffix like any other
asset, that PixelLab draws facing 4 or 8 directions. `mode` picks the
engine: `standard` (1 generation, the skeleton template, `outline`,
`shading`, and `detail` as soft guidance, and `palette` sent as a colour
reference), `v3` (2 to 9 by size, the highest quality, up to 256px),
`pro` (20 to 40 by size), or `pro-flash` (6 to 17 by size: PixelLab's
newest image model draws the south sprite and v3 rotates it; sizes are
multiples of 4 up to 256, `template` may be `custom`, and a `reference`
pays for the rotations only, 1 at 64px). `size` is the character's size;
`view` is `low top-down` (the default), `high top-down`, or `side`;
`template` picks the body. Each direction lands as
`<asset>-<direction>.png`, south first.
Standard mode draws on a canvas 28px larger than `size`, 14px of room on
each side for animation (a 64px character comes back as 92px files, a
104px one as 132px); the lock records the size asked for, and the files
are what PixelLab drew.

### Proportions, guidance, and isometric view

Three more knobs shape a `standard` base. `proportions` is a preset
(`chibi`, `heroic`, and so on) or multipliers on the mannequin's head,
arms, legs, shoulders, and hips; it lives on the style and any base may
override it, and only the mannequin template has proportions to set.
`textGuidanceScale` (1 to 20, PixelLab's default 8) is how closely the text
is followed, and applies to template loops as well. `isometric` draws the
base and every loop in isometric view. The v3 and pro engines take none of
the three for a base; a v3 style may still set the last two for its loops.
A `v3` base takes `enhancePrompt` instead, which has PixelLab expand the
prompt into a fuller one before drawing.

### Starting from your own sprite

A base can also start from your own sprite. `reference` names a
manifest-relative PNG or JPEG of the character facing south, and PixelLab
draws the other directions from it, with the prompt as guidance:

```json
"bot": { "prompt": "small round orange robot with one blue eye", "reference": "refs/bot-south.png" }
```

That is how the robot above was made the second time: its own south
sprite handed back to pro-flash, which rotated it for 2 generations at 96px
and left the south file pixel for pixel as it was.

`standard` uses each image as it is, centred on its larger canvas, and
generates the rest, so the image must be the style's `size` exactly; it
accepts one image per direction
(`{ "south": ..., "east": ... }`), and a quadruped template needs south and
east. `v3` rotates one south image of up to 256px (its `template` must
match the body in the image). `pro` rotates one south image of up to 168px
through its `rotate_character` method. The reference's bytes are part of
the base's identity, so a redrawn file makes the base stale, and the file
is read again at submit time and refused if it changed since `plan`.
States, animations, and mirrors take their look from their parent and
cannot carry a reference.

### Concept images and style anchors (pro)

The pro engine has two more ways in. `concept` on a base names a concept
image (a painting, a photo, a sketch, up to 1024px) that seeds the design
in place of the prompt alone (PixelLab's `create_from_concept`); the
prompt still guides it. `styleCharacter`, on the style or a base, names a
generated 8-direction character in the same style whose look the base
follows (`style_character_id`); its south sprite becomes the style image
unless a style image is also given. The anchor is a dependency like a
loop's character: the base is `blocked` until the anchor is downloaded and
current, `gen` runs it in the wave after the anchor lands, and a
regenerated anchor makes every base drawn in its style `stale`. The anchor
itself ignores the setting, so a style can name its own first character.
PixelLab wants the base at least as large as the anchor's visible sprite
and fails the job fast otherwise. A base rotating its own `reference`
takes neither: the rotate method has one image slot and it is the
character.

### Style images (pro and pro-flash)

Style images on a `character` style are a pro input: one image of up to
168px that anchors the look of a `pro` base drawn from text or a concept
(`create_with_style` and `create_from_concept` both take it), or one of
up to 256px that a `pro-flash` base copies its look from, no larger than
the character's `size` on either side (crop it to its subject), with
`styleTraits` (`palette`, `outline`, `detail`, `shading`, each on by
default) choosing which traits it lends. `standard` and `v3` have no such
slot and refuse them; a base with a `reference` refuses them too, in
either engine.

### States

A state is a text edit of an existing character, `state.of`, applied to
every direction at once: a pose, an outfit, a held object. The prompt is
the edit and goes to PixelLab as written, without the style's prefix and
suffix, since the character already carries the look.
`paletteFromReference` snaps the result to the parent's colours; `canvas`
asks for a larger frame when the edit adds something big. A state costs 20
to 40 by canvas and keeps the parent's directions. A state may be a state
of another state.

### Animations

A template loop moves a skeleton, so it wants a body the skeleton fits: a
biped on `mannequin`, or one of the quadruped templates. A character that
is neither (a round robot, a slime) gets a walk from text on the v3
engine instead; a template on it either fails upstream (`custom`
template) or redraws the character as the biped it expected.

An animation is one loop of one character (`animation.of`, a base or a
state) in one `direction`. With a `template` (PixelLab's `walk`,
`breathing-idle`, `running-8-frames`, and so on) it costs 1 and the
template decides the frame count; without one the prompt is the motion and
PixelLab's v3 engine draws `frames` frames (4 to 16, even, default 8) for
`ceil(size² × frames / 65536)` generations, one at 64px. `keepFirstFrame`
(on by default) stores the resting pose as frame 0, so 8 frames land as 9
files, `<asset>-frame-00.png` onwards. `fps` is recorded with the frames
for the gallery, `pack`, and the Godot and Aseprite formats; PixelLab does
not keep one. An animation lands in review as an ordered set: `pick` shows
the loop and accepts or rejects it whole. One asset per direction; declare
another asset for another direction, or a [mirror](#mirrors) of this one
for the direction that faces the other way.

### Pose frames and other loop controls

A v3 loop can start and end where you say. `startFrame` is a
manifest-relative image of the pose to begin from instead of the
character's rotation; `endFrame` is a pose to reach, and with it the loop
interpolates from the start frame to that image (both up to 256px, and the
end frame the same size as the start frame or, without one, as the
character's rotation, which `plan` checks once the parent is on disk; the
frames can still come back on a taller canvas when the motion needs it, as
a 92px crouch did at 92×104). `subject` replaces the character's own description for this loop when it
would mislead the model (a state that took the armour off), and
`enhancePrompt` lets PixelLab expand the action into a fuller motion
description first. A template loop takes none of those; it takes
`outline`, `shading`, and `detail` overrides instead, over the character's
own. The style's `palette` goes to every loop as a colour reference, as it
does to a `standard` base, and `enforcePalette` still snaps the frames
afterwards. Pose images hash into the loop's identity and are read again
at submit time, like a base's `reference`.

```json
"bot.crouch": {
  "prompt": "folding down onto its legs until it rests on the ground",
  "animation": { "of": "bot", "direction": "south", "frames": 6, "endFrame": "poses/bot-crouched.png" }
}
```

### How the family depends on the base

States and animations depend on their parent the way a revision does. The
parent must be downloaded and current before the child is actionable;
`plan` reports the child as `blocked` and names the parent until then, and
one `gen` runs the waves in order: bases, then states, then animations,
under one budget. The
child's identity includes the parent's generated south-facing file, so
regenerating the parent makes every state and animation of it `stale`. A
hand edit of the parent does not, because PixelLab draws the child from the
character it holds, not from local bytes.

Regenerating an animation clears PixelKiln's own earlier take of that
direction on the character first, since PixelLab skips a direction that
already exists. The lock records the animation and group ids PixelLab
assigned, and the delete goes by those (PixelLab keeps the name PixelKiln
gives a loop only for text animations, not template ones). Nothing else on
the character is touched, and a base or state is never deleted by
PixelKiln.

### Palette and packing

`enforcePalette` snaps every direction and every frame. `pack --style cast
--format godot` writes a `SpriteFrames` with each direction of a base or
state as a still and each animation as a looping set at its fps;
`--format aseprite` does the same with `frameTags`.

### Adopting a character from the account

Characters that already exist on the account come under the manifest with
`adopt`. Declare the asset with `remoteId` (the character id, or
`<character id>#<animation group id>` for a loop; `get_character` in
PixelLab's own tools shows both) and run `pixelkiln adopt`: it records the
character, writes every direction and frame that is not on disk, and costs
nothing. A base can also be matched by the bytes of its south-facing file.
See [`adopt`](CLI.md#adopt).

## Mirrors

Each direction of a loop is its own generation, and a sprite walking east
is the sprite walking west flipped. A `mirror` asset is that flip, made
locally from the source asset's downloaded files:

```json
"bot.walk.west": {
  "prompt": "walking forward in place, short legs stepping, body bobbing slightly",
  "animation": { "of": "bot", "direction": "west", "frames": 12, "fps": 12 }
},
"bot.walk.east": { "mirror": "bot.walk.west" }
```

A full 8-direction set of one loop is then 5 generations (south, north,
west, south-west, north-west) and 3 mirrors; a 4-direction set is 3 and 1.
The mirror takes its shape from the source (a loop of the same character,
facing the other way, at the same fps), needs no prompt, and costs
nothing: `plan` lists it under the provider with a cost of 0 and `gen`
flips it in the wave after the source lands. It has its own lock entry and
files (`bot.walk.east-frame-00.png` onwards), so `pack`, the gallery, and
an engine see an ordinary loop. Nothing is sent to the provider, and the
account holds no east animation.

The lock records a hash over the source's output hashes when the flip was
made. A source that is regenerated, restored, or re-snapped makes its
mirrors `stale`, and the next `gen` flips them again for free. A mirror
whose files went missing is `stale` too; one that was hand-edited is
`orphaned`, like generated art. A source that is not downloaded, current,
and untouched blocks its mirrors.

A loop facing south or north cannot be mirrored: the flip would be the same
direction with its asymmetries swapped, not a new one. A single image or a
frame set from any generator can be mirrored, and so can a base or state
(every direction flipped and relabelled, so west becomes east). A tile set
cannot; its edges carry meaning. Mirroring swaps handedness, so a character
who holds a sword in the right hand holds it in the left when facing the
mirrored way. Most games accept that; if yours does not, generate both
sides. `adopt` skips mirrors, since there is nothing upstream to adopt.

Engines that flip sprites at draw time (Godot's `flip_h`, Unity's
`flipX`) do not need mirrored files at all. Declare only the directions
you generate and flip in the engine; mirrors are for pipelines that want
every direction on disk.

## Working with a cast

- `pixelkiln plan` shows a state or loop as `blocked` until its parent is
  downloaded and current, and one `pixelkiln gen` runs the waves in order
  (bases, then states, then loops and mirrors) under one budget; see
  [`gen`](./CLI.md#gen).
- Loops land in review as ordered sets; `pixelkiln pick` accepts or rejects
  a set whole.
- Characters that already exist on the account come under the manifest with
  [`adopt`](./CLI.md#adopt), by `remoteId` or by the bytes of a south file.
- A character edited in PixelLab's own editor comes back with
  [`fetch --refresh`](./CLI.md#fetch), which re-resolves the character's
  current URLs first.
- `pixelkiln gallery` shows the family: states under their base, loops with
  their direction, mirrors with their source; see
  [`gallery`](./CLI.md#gallery).
- `pack --format godot` and `--format aseprite` write each direction as a
  still and each loop as a looping set at its fps; see
  [engine formats](./ARTIFACTS.md).
- Costs per engine are in the [generator table](./GENERATORS.md#character),
  and what the live runs measured is in [Measured
  endpoints](./ENDPOINTS.md#characters-measured).
