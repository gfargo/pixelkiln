# 3D models from directional sprites

This is a research note, not a feature: nothing here is a PixelKiln command, and the scripts are rough. PixelKiln already generates an object or a character from eight directions. This note records every attempt to turn those eight pictures into a 3D model: what was tried, with what, and what came out.

Last updated 17 November 2026.

## Summary

| # | Approach | Tool or model | Result | Verdict |
|---|---|---|---|---|
| 1 | Carve a voxel model from the eight silhouettes | Our script | 92 to 96% on round objects, 39 to 68% on long ones | The long objects were drawn tilted. See 2. |
| 2 | Ask for the object standing upright | PixelLab 8-direction object | Sword 66% to 94%, torch 68% to 93% | Keep. The prompt wording matters more than the algorithm. |
| 3 | Detect tilted views and carve without them | Our script | Greatsword 98% from six views | Keep. The model fills in the views the generator got wrong. |
| 4 | Smooth, colour and render the carved model | Our script | Readable from 16 sides | Keep for shape. Colour is still rough between the drawn views. |
| 5 | Carve a character | Our script | 95% | Keep. |
| 6 | Triangulate a 3D skeleton from 2D joints | PixelLab skeleton estimate + our script | 18 joints, 1.3 px mean error | Keep. This is a rig. |
| 7 | Build the body from tubes around the bones | Our script | 79% | Drop. Carving is better. |
| 8 | Generate a mesh from four views | Hunyuan3D-2mv in ComfyUI, RTX 3060 12 GB | About two minutes a mesh; 70 to 83% | Cleaner geometry, looser match. Needs its own texture step. |
| 9 | Unwrap the mesh and texture it from the sprites, in stages | Our script, with xatlas for the unwrap | Colour error down by a fifth to a half against one-pass colouring, on all five | Keep. The texture is now a picture that can be repaired. |
| 10 | Let the views vote on each texel's colour | Our script | Colour error down another 1 to 4 on every subject and shape | Keep, as the default. |
| 11 | Texture the carved shape the same way | Our script, marching cubes | Better than the mesh on the character and torch, worse on the two swords | Keep both shapes. Which is better depends on the object. |
| 12 | Carved shape cut back to the mesh | Our script | No better than carving alone | Drop. |
| 13 | Have an image model redraw the model's rough renders | PixelLab `edit_image`, `inpaint_image`, `correct_pixelart` | Clean sprites at angles the generator never drew: sixteen directions from eight, for 10 generations | Keep. This is the best result so far, and it changes what the 3D model is for. |
| 14 | Paint the redrawn views back onto the model | Our script | Smoother, still muddy | Drop for now. The model is a guide, not the final picture. |
| 15 | Flatten the texture to a few materials and light it in the renderer | Our script | No blotches, and no detail either | Partly. The lighting is worth keeping; the flattening loses too much. |
| 16 | Put the skeleton in the mesh, skin it, add a walk, export a rigged `.glb` | Our script | Valid glTF with 15 bones and a walk, for both characters | Keep. This is the first file here a 3D game can import and animate. |
| 17 | Install Hunyuan3D's paint stage on the RTX 3060 | Second ComfyUI, community node | Runs in 12 GB after one patch; about 40 seconds a pass | Keep. |
| 18 | Flat base with trusted sprite pixels laid back on top | Our script | Eyes and trim return; the tearing does not change | Drop. The tearing is in the shape, not the shading. |
| 19 | Use the Hunyuan3D mesh for the knight, not the carved shape | Hunyuan3D-2mv | Real horns, separate arms and legs; the same texturing reads far better | Keep for complex characters. No gain on the bare character. |
| 20 | Paint the mesh with the paint stage, once per sprite direction | Hunyuan3D-2 paint | Each sprite redrawn to fit the mesh; a clean texture from every side | Keep. The best texture in this note. |
| 21 | Redraw the character in an A-pose before meshing | PixelLab character state | Arms clear of the body in all eight views, for 10 generations a character | Keep. The mesh and the rig both need it. |
| 22 | Round the pixel edges off the pictures the mesh model sees | Our script, Hunyuan3D-2mv | The bare character goes from a figure made of boxes to a sculpted body with a face | Keep. The largest gain in shape since step 8. |
| 23 | Bake the painted views on this machine, with side views and colour correction | Our script | 24 views from 8 passes, no visible seams; the rim and colour-matching ideas made it worse | Keep the side views and the correction. Drop the other two. |
| 24 | Measure skin weights through the inside of the mesh | Our script | The cape hangs from the shoulders, not the legs; the walk lowers the arms | Keep. |
| 25 | Carry the sprites' palette in the file and snap to it when drawing | Our script, a shader in the viewer | Renders at sprite size read as sprites; the colour score still prefers the stitched texture | Keep the look. The score is the wrong judge. |
| 26 | A leaner bare body, with each item drawn as its own layer | PixelLab v3 character, PixelKiln layers | A slim figure in underwear and four clean item layers; the mesh is still stocky | Keep. The mesh inherits the sprite's four-heads-tall build. |
| 27 | Mesh each item on its own, or mesh the body wearing it and cut the item out | Hunyuan3D-2mv, our scripts | Alone, thin items collapse into slabs; cut from the worn mesh, all four hold their shape | Cut from the worn mesh. |
| 28 | The body and four items as separate meshes on one skeleton | Our script | One .glb, items switch on and off, all walk together | Keep. Painted in step 29. |
| 29 | Paint the body and each worn mesh before cutting the item out | Hunyuan3D paint stage, our bake | Clean armour, cape and skin in place of speckle; colours drift cooler and the gold is duller | Keep. The colour drift is handled in step 30. |
| 30 | Hide the skin under what is worn, and bake each item in its own colours | Our script | The body is six pieces, each hidden while its item is on; orange flecks in the walk turned out to be dulled gold snapped to skin colour, and are gone | Keep. |
| 31 | Draw the character as sprite cards on the skeleton, with no textured mesh shown | Our script, three.js | Crisp drawn pixels from any angle, walking, with items that switch off | Keep as a second way to show a character. Eight directions and open joints are the limits. |
| 32 | Redraw the sprites large with a local image model, and paint from those | SDXL with a tile control model, Hunyuan3D paint stage | Painted armour with real detail in place of enlarged pixels; 768 pixel views fit in 12 GB | Keep. The eight redraws do not agree on details, and colours move. |
| 33 | Make the redraws agree: one sheet for all eight, or each alone with the sprite's colours held | SDXL with a tile control model | Holding colours fixes the drift and keeps the detail; the one-sheet redraw agrees but is soft | Keep the colour hold. Drop the sheet. |
| 34 | Mesh from redrawn pictures in place of smoothed sprites | SDXL redraw, Hunyuan3D-2mv | A round skull, a face, ears, arms and legs with shape, where there were flat facets | Keep. The largest gain in the mesh since step 22. |
| 35 | Rebuild the body and all four items from redrawn pictures, end to end | SDXL redraw, Hunyuan3D-2mv and its paint stage, our scripts | A sculpted body and detailed helm, armour and cape on the same skeleton; one sleeve short, a gap at the hip, a teal fur collar | Keep as the viewer's model. The item masks still come from the sprites and no longer fit exactly. |
| 36 | Move each item's edge to where the paint puts it, and stop the bake shifting colours | Our scripts | Skin scraps and the hip gap are gone; the collar is grey again, the helm black, the underwear grey | Keep. One sleeve still ends at mid forearm. |
| 37 | Open the parts model in a game engine | Godot 4.7.2, headless | Ten skinned meshes, fifteen named bones, the walk, and each body piece's hide list all arrive | Keep. The first check outside three.js. |
| 38 | A second painter, MV-Adapter | MV-Adapter on SDXL, our own guide pictures | It runs and its front view is sharp and faithful; one pass takes 11 minutes and overfills the 12 GB card; the sides it invents are wrong | Drop on this card. Keep the scripts. |
| 39 | Sprites drawn at 256 pixels at the source | PixelLab v3 character and four states | An adult-proportioned figure and four worn versions, each agreeing across eight directions | Keep. The best source art so far; not yet meshed. |
| 40 | Rebuild everything from the 256 pixel sprites | PixelLab, SDXL redraw, Hunyuan3D-2mv and its paint stage, our scripts | An adult-proportioned, painted body and four detailed items on one skeleton; imports into Godot | Keep as the viewer's model. Still 80,000 triangles and one home-made skeleton. |
| 41 | Thin every part and bake the paint and a normal map onto the light mesh | Our script | 16,496 triangles for 79,819 and 2.1 MB for 6.3, with no visible loss in an unlit render | Keep. The viewer's model is the light one. |
| 42 | A standard humanoid skeleton | Our script, Godot's humanoid profile | Twenty-one bones; every bone Godot's profile requires is found by name, under the right parent | Keep. No stock animation has been put on it yet. |
| 43 | Put stock animations on the skeleton | Quaternius's Universal Animation Library (CC0), our script | Eleven library animations play on the knight: idle, walk, jog, sprint, sword attack, death and others | Keep. The character now moves like a game character. |
| 44 | Paint views from above and below as well | Hunyuan3D paint stage, our bake | The dark streaks on arm tops, shoulders and heads are gone | Keep. The viewer's model is rebuilt with it. |
| 45 | Bones for the cape, and a simulation that swings them | Our scripts | Twelve cape bones in three chains; the cape streams in a sprint, hangs in an idle and falls in a roll, baked into every animation | Keep. It works in any engine with no physics set up. |
| 46 | Put the first body's items on a second, heavier body | PixelLab, our scripts | The same four items fit a much broader man, after reshaping each to his bones and thickness | Keep. Scaling by ratio failed; adding the difference in thickness works. |
| 47 | Finger bones, and a sword in the hand | PixelLab, Hunyuan3D-2mv, Quaternius's library, our scripts | A thumb and one finger chain a hand, found on the mesh; the library's fists and sword grip carry over; a generated sword sits in the closed right hand | Keep for 256 pixel sources. A 64 pixel hand and a hand drawn as a fist get no finger bones. |
| 48 | A grip for a hand drawn as a fist | Our scripts | The heavier second body holds the same sword: the fist and its wrist are found on the mesh, the grip runs through the fist. No new generations | Keep. A fist holds but cannot open, and which way it faces is assumed, not measured. |
| 49 | The left hand, and a shield | PixelLab, Hunyuan3D-2mv, our scripts | The sword sits in either body's left hand with no change; a generated shield is strapped to the left forearm of both and stands upright through the library's motions | Keep. The shield is carried, not used: the library has no shield or left-handed motions. |
| 50 | Two hands on one grip | PixelLab, Hunyuan3D-2mv, our scripts | A generated greatsword in both hands of both bodies through all twelve motions, by pulling the grip in front of the body and solving both arms at every moment | Keep as a baked fallback. Wrists bend past what a wrist can in some motions; real two-handed animations would be better. |
| 51 | Motions made for two hands | Our scripts | Four two-handed motions (a guard, a walk, a jog and a cut) made by writing down the sword's path and solving both arms to it. Wrists stay within 52 degrees on the first body, where the bent one-handed motions reached 100 | Keep. Use these where a motion exists, and step 50's bent ones for the rest. |
| 52 | Footwork for the two-handed attack | Our scripts | The cut now has a step: the hips wind up, the left foot steps out as the blade lands, and both legs are solved again. Feet stay on the ground and wrists are unchanged | Keep. |
| 53 | A spear, hands apart | PixelLab, Hunyuan3D-2mv, our scripts | A generated spear held left hand forward with the right behind it on the shaft, and four motions made for it: a guard, a walk, a jog and a thrust with a step | Keep for the first body. The second body's rear wrist bends 82 to 86 degrees, and stock motions fit a shaft poorly. |
| 54 | The spear's rear elbow | Our scripts | The rear arm's elbow moved from back and up to out at the side, found by trying 37 places for it on both bodies | Keep. The second body's rear wrist went from 82 to 86 degrees down to 8 to 19, the first body's from 47 to 72 down to 15 to 20. |
| 55 | A side-on spear stance | Our scripts | The spear motions rewritten with the hips turned (45 degrees standing, 28 walking, 14 jogging), the feet split and the head looking along the shaft | Keep. Both bodies hold it with wrists under 36 degrees and both feet on the ground. The walk's legs still walk straight under turned hips. |

**How the percentages are measured.** The model is projected back to each of the eight camera positions and its outline is compared with the sprite's outline. The score is the area the two share divided by the area either covers, averaged over the views. 100% means the model casts exactly the sprite's shadow from every side. It measures shape only, not colour. It also favours carving, which is built from those same outlines.

## What we start from

- **Sprites.** PixelLab's `create_8_direction_object` gives eight 64px views of one object, at 45 degree steps: south, south-east, east, north-east, north, north-west, west, south-west. It costs 10 generations per object at this size. Characters come from `create_character` with the same eight directions.
- **Camera.** The views are drawn from slightly above, not level. PixelLab's `view` option sets this: `low top-down` (the default), `high top-down` or `side`. The carving script does not assume the angle; it tries 0, 10, 20, 30 and 40 degrees and keeps the one whose model matches the sprites best. It landed on 20 to 30 degrees for default views.
- **Subjects.** A lantern, a round shield, a kite shield, a torch, a sword, a greatsword, a treasure chest, and the bare character used for the paperdoll work.

## 1. Carving from eight silhouettes

**Question.** Is the shape recoverable from the outlines alone, with no model?

**Setup.** Start with a solid 64×64×64 block of voxels. For each of the eight views, remove every voxel that falls outside that view's outline. What is left is the largest shape consistent with all eight views (a visual hull). The camera height and a small per-view shift are fitted by trying values and keeping the best score. Script: [`scripts/carve.ts`](../research/scripts/carve.ts).

**Result.** Each block of three rows is one object: the sprites, the model from the same eight directions, and the model from the eight directions in between.

![First carving attempt: lantern, round shield, kite shield, torch, sword and greatsword](../website/public/research/3d/carve-first-attempt.png)

| Object | Match |
|---|---|
| Lantern, round shield, kite shield | 92 to 96% |
| Torch | 68% |
| Sword | 66% |
| Greatsword | 39% |

The lantern and shields hold their shape. The torch, sword and greatsword are carved down to stumps. Look at their sprite rows: in the diagonal views the object is leaning over. The generator drew a tilted picture of the sword instead of turning it in space, so the eight views describe eight different poses and almost nothing is consistent with all of them.

The surfaces are also ragged and the colours speckled, because eight hand-drawn pictures do not agree with each other pixel for pixel.

**Verdict.** The method works when the views agree. The problem is the input.

## 2. Asking for upright objects

**Question.** If the output is going to be 3D, can the generator be told to draw the object standing straight up, so the views agree?

**Setup.** Same tool, with this added to the description: "standing perfectly upright and vertical, blade pointing straight up, spinning in place around its vertical axis like a turntable model". Tried with `view: side` and with the default.

**Result.** The inputs, one row per object:

![Upright inputs: sword, ornate greatsword, torch, chest](../website/public/research/3d/upright-inputs.png)

The sword, torch and chest stand upright in every view. The ornate greatsword (second row) ignored the wording and leans on all four diagonals.

| Object | Before | With upright wording |
|---|---|---|
| Sword, `view: side` | 66% | 94% |
| Sword, default view | 66% | 89% |
| Torch | 68% | 93% |
| Treasure chest | not tried | 93% |
| Ornate greatsword | 39% | 28% |

**Verdict.** Keep the wording. It fixes plain objects and is not a guarantee for detailed ones.

## 3. Finding tilted views and carving without them

**Question.** Can a tilted view be detected automatically, and can the model be built from the good views only?

**Setup.** Two parts.

- *Tilt check.* For each view, find the long axis of the outline and measure how far it leans from vertical. Script: [`scripts/tilt.py`](../research/scripts/tilt.py). Good objects leaned 0 to 2 degrees in every view. Every bad view leaned 36 to 46 degrees. There is nothing in between, so a threshold anywhere around 10 to 20 degrees separates them.
- *Second greatsword.* Generated again with the good sword passed as `style_object_id`. It came back upright in six views and tilted in two. (The first try at this failed outright: the new object's size must be at least the style object's content size.)
- *Carving with views left out.* The script takes a list of views to skip. A skipped view neither carves nor gives colour.

**Result.** The greatsword carved from its six upright views. Top row: the sprites, with the two tilted ones still shown. Below: the model from the same directions and from in between.

![Greatsword carved from six upright views](../website/public/research/3d/carve-six-views.png)

It matched the six views it was built from 98%. Rendered from the two directions that were left out, it stands upright there as well.

**Verdict.** Keep both. The tilt check is a cheap gate before spending anything further, and the model can supply the views the generator got wrong.

## 4. Smoothing, colouring and rendering

**Question.** Can the carved model be made presentable?

**Setup.** Three changes to the script.

- *Smoothing.* Each voxel is kept or removed by a majority vote of its 26 neighbours, twice. This fills pits and removes spikes.
- *Colour.* Each surface voxel takes its colour from the view that faces it most squarely and can actually see it. Outline pixels (the sprites' near-black edge) are avoided, because they were landing on the surface as dark speckle.
- *Render.* One ray is marched per output pixel, so there are no holes, and a one-pixel dark outline is drawn around the result.

**Result.** All the upright subjects, three rows each as before:

![Carved models from upright views: sword, greatsword, torch, chest, character](../website/public/research/3d/carve-upright.png)

The directions that have a sprite come out close to it. The directions in between are recognisable but rougher: the colour there is borrowed from a neighbouring view and stretched.

**Verdict.** Good enough for shape. Colouring per voxel straight from the sprites is the weak part, which is the reason for step 9.

## 5. A character

**Setup.** The bare character base, its eight rotations, same script.

**Result.** 95% match, with the camera fitted at 20 degrees above level. It is the last block in the picture above. Arms and legs survive; the gap between the legs partly fills in, because a gap is only carved if some view can see through it.

**Verdict.** Keep.

## 6. A 3D skeleton from 2D joints

**Question.** PixelLab's skeleton estimate gives 18 joints in each 2D view. Do the eight views agree on where those joints are in space?

**Setup.** For each joint, solve for the one 3D point that best explains its eight 2D positions, using the camera fitted in step 1. The estimator sometimes names left and right by the picture and not by the body; the script tries both namings for each view and keeps the one that agrees with the others.

**Result.** All 18 joints placed, with a mean error of 1.3 pixels and a worst case of 2.1 at an elbow. Left and right came out consistent in every view.

**Verdict.** Keep. This is a rig for the carved model, from data PixelKiln already stores in the anchors file.

## 7. A body from tubes

**Question.** A Discord thread described building characters from tubes or capsules around a skeleton. Is that better than carving?

**Setup.** One tube per bone (upper arms, forearms, thighs, shins, torso, shoulders, hips, head), with each tube's radius taken from the carved voxels nearest that bone.

**Result.** Top three rows are carving, bottom three are tubes:

![Character: carving above, tubes below](../website/public/research/3d/character-carve-vs-tubes.png)

Tubes matched 79% against carving's 95%. The result is a blob with limbs: no hands, feet, face or shoulders.

**Verdict.** Drop tubes as the shape. Carving for the shape with the skeleton from step 6 as the rig is the combination worth keeping.

## 8. Hunyuan3D multi-view meshes

**Question.** Does a model trained to make meshes from pictures do better than carving, and does it run on hardware we have?

**Setup.**

- *Model.* Tencent Hunyuan3D-2mv, the `hunyuan3d-dit-v2-mv` checkpoint in fp16, 4.93 GB, from the `tencent/Hunyuan3D-2mv` repository on Hugging Face.
- *Runner.* ComfyUI 0.34.0, which has Hunyuan3D nodes built in. No custom nodes. PyTorch 2.13 with CUDA.
- *Hardware.* A desktop with an RTX 3060, 12 GB.
- *Graph.* `ImageOnlyCheckpointLoader` → `ModelSamplingAuraFlow` (shift 1.0). Four `LoadImage` → `CLIPVisionEncode` (crop none) → `Hunyuan3Dv2ConditioningMultiView`. `EmptyLatentHunyuan3Dv2` (resolution 3072) → `KSampler` (30 steps, cfg 5, euler, normal) → `VAEDecodeHunyuan3D` (8000 chunks, octree 256) → `VoxelToMesh` (surface net, threshold 0.6) → `SaveGLB`. Script: [`scripts/hunyuan3d.py`](../research/scripts/hunyuan3d.py).
- *Inputs.* The model takes four views: front, left, back, right. Those are south, west, north and east of the eight. Each 64px sprite was scaled to 512px with hard pixel edges and put on white:

![The four inputs for the character](../website/public/research/3d/hunyuan-inputs.png)

**Result.** 106 to 119 seconds per mesh. Each block of three rows below is one subject (character, chest, sword, torch; the greatsword is not pictured): the sprites, the carved model, and the Hunyuan3D mesh. The mesh was turned into voxels and coloured from the sprites the same way as the carved model, so the two can be compared directly.

![Sprites, carved model, and Hunyuan3D mesh for each subject](../website/public/research/3d/mesh-vs-carve.png)

| Subject | Carved | Hunyuan3D mesh |
|---|---|---|
| Bare character | 95% | 83% |
| Chest | 93% | 82% |
| Sword | 94% | 80% |
| Greatsword | 98% | 72% |
| Torch | 93% | 70% |

- **Better than carving:** the geometry is real. The character's legs are separate, the sword blade is thin from the side, the chest has a lid.
- **Worse than carving:** the model redraws the object in its own proportions. The mesh does not line up with the sprites pixel for pixel, so colour taken straight from the sprites lands a pixel or two off.
- **Lost:** the torch's flame. A flame is not a solid object and the mesh leaves it out.
- **Caveat on the numbers:** the mesh was lined up with the sprites crudely (scaled to the same height, tried at each quarter turn). A better fit would close some of the gap. Carving also has a built-in advantage on this score.
- **Not measured:** the same run on an Apple M1, so there is no speed comparison.
- **Licence:** the Hunyuan3D community licence does not apply in the EU, the UK or South Korea.

**Verdict.** Use it when clean geometry matters more than matching the sprite exactly. It needs a texture step of its own.

## 9. Texturing in stages

**Question.** Steps 4 and 8 coloured the model in one pass, straight from the sprites onto voxels. Does splitting the work into stages (fit, unwrap, project, fill, render) give a better result on the Hunyuan3D meshes?

**Setup.** Script: [`scripts/texture.py`](../research/scripts/texture.py). It takes about six seconds a mesh on a laptop. Libraries: trimesh, xatlas, fast-simplification, numpy, scipy.

1. **Fit.** The mesh is simplified to 30,000 triangles, then lined up with the sprites' cameras by searching for the turn, the camera height, a scale for each of the three axes, and a one or two pixel shift per view that make its outline match the sprites best. Step 8 only tried quarter turns and one scale.
2. **Unwrap.** xatlas flattens the surface into a 256×256 texture.
3. **Project.** Every texel is given the colour of the sprite pixel it lands on, from the one view that faces it most squarely and can see it. Outline pixels are never used. Texels then agree with their neighbours on which view to use, so the surface does not speckle where two views meet.
4. **Fill.** A texel no view could see takes the colour of the nearest texel that was seen, measured across the surface in 3D.
5. **Render.** Unlit, at sprite size, each pixel taking the most common colour among the texels in front, with a drawn outline.

It also writes a textured `.glb` that opens in Blender or any glTF viewer.

**Result.** Four rows per subject: the sprites; the same mesh coloured in one pass (step 8); the mesh textured in stages; and the staged model from the eight directions in between.

![Sprites, one-pass colouring, staged texture, and staged texture from between views, for five subjects](../website/public/research/3d/texture-staged.png)

The texture itself, for the chest. Left: the unwrapped texture. Right: which of the eight sprites each texel took its colour from, one colour per view; dark grey was seen by none and filled in.

![The chest's unwrapped texture and its view map](../website/public/research/3d/texture-atlas-chest.png)

Three numbers per method. *Shape* is the outline match used throughout. *Colour error* is the mean difference per colour channel, out of 255, over the pixels where model and sprite overlap; lower is better. *Close* is the share of those pixels within 24 of the sprite's colour on every channel. All three are measured on the rendered pictures by [`scripts/score.py`](../research/scripts/score.py), which first slides each render to where it overlaps its sprite best, so the shape numbers here are a little lower than the ones in the earlier steps.

| Subject | Method | Shape | Colour error | Close |
|---|---|---|---|---|
| Character | Carved, one pass | 92% | 40.5 | 42% |
| | Mesh, one pass | 85% | 49.4 | 37% |
| | Mesh, staged | 88% | 42.9 | 46% |
| Chest | Carved, one pass | 92% | 42.3 | 41% |
| | Mesh, one pass | 85% | 49.2 | 30% |
| | Mesh, staged | 90% | 32.0 | 54% |
| Sword | Carved, one pass | 91% | 36.3 | 50% |
| | Mesh, one pass | 79% | 52.2 | 37% |
| | Mesh, staged | 89% | 31.3 | 60% |
| Torch | Carved, one pass | 89% | 35.4 | 48% |
| | Mesh, one pass | 76% | 53.3 | 25% |
| | Mesh, staged | 83% | 28.6 | 59% |
| Greatsword | Carved, one pass | 94% | 18.4 | 72% |
| | Mesh, one pass | 71% | 22.3 | 70% |
| | Mesh, staged | 89% | 13.9 | 81% |

- **The better fit closed most of the shape gap.** The meshes went from 71 to 85% to 83 to 90%, with no change to the meshes themselves. Carving is still ahead on shape by 2 to 6 points.
- **Staged texturing beat one-pass colouring on every subject,** and beat the carved model's colour on four of five. The character is the exception: the mesh's hands, head and chest are a different shape from the sprite's, so muscle lines land in the wrong place.
- **The torch has a flame again.** The mesh has no flame, but the sprite's flame pixels land on the top of the basket.
- **The greatsword's two tilted views were left out,** and the model is upright from those directions with the runes in place.
- **A mirror image cannot be told apart by outline.** For every subject the mirrored fit scored within a tenth of a point of the true one. The script assumes the mesh is not mirrored, which held for all five. Front and back are nearly as close on symmetric objects (83.2 against 83.1 for the chest), so the result should be looked at, not trusted.

**Tried and dropped,** on the character, none of which moved the colour error by more than a point or two:

- Blending views by weight and snapping to the palette, instead of one view per texel: 48% close against 54%. Blending muddies the pixel art.
- Letting a texel that lands just outside the sprite take the nearest pixel inside it: slightly worse.
- Refusing colour from pixels beside a jump in the mesh's depth (its outer edge, an arm in front of the body): no better, and a quarter of the texels left to fill.

The remaining error on the character is the mesh's shape, not the texturing.

**Verdict.** Keep. Staging is the better way to colour a mesh, and it leaves a texture file that can be repaired as an ordinary picture.

## 10. Letting the views vote

**Question.** After step 9 the remaining flaws are dark specks where one sprite has a contour line and its neighbour has plain colour. The eight sprites are eight separate drawings and do not agree. Can the texture take the consensus instead of trusting one view?

**Setup.** Three rules for choosing a texel's colour, all in `texture.py`:

- `MODE=best` (step 9): the one view that faces the texel most squarely.
- `MODE=vote`: when three or more views can see the texel, take the colour closest to the middle of what they all say, leaning toward views that face it. Colours still come straight from a sprite, so the palette is kept.
- `DESPECKLE`: after colouring, replace any texel much darker than the surface around it.

**Result.** Voting lowered the colour error on all five subjects, on both shapes, by 1 to 4 points (table under step 11). It loses a little crispness on a face seen head-on. Despeckling made the numbers slightly worse at every threshold tried (25, 40, 60) and removed wanted detail with the specks.

**Verdict.** Vote is the better default. Despeckle is dropped.

## 11. Texturing the carved shape

**Question.** Carving matches the sprite's outline best and staged texturing colours best. Do they combine?

**Setup.** `carve.ts` with `DUMP=1` writes its voxels and its fitted camera. `texture.py` with `VOX` and `CAMERA` turns the voxels into a mesh with marching cubes and runs the same unwrap, project, fill and render on it, using the carve's camera so nothing needs fitting.

Two things had to be right before the numbers meant anything, and both are easy to get wrong again:

- **Where the surface is cut.** The carve treats each voxel as a point at its centre. A mesh cut half a voxel outside those centres (the usual setting) renders a pixel fatter than the sprite all round. The surface is cut through the outermost centres instead (`LEVEL=0.9`).
- **Half a pixel.** The carve drops a voxel into a pixel by rounding down. In views whose centre falls on a half pixel, that puts every voxel half a pixel to the right of where its cube really is. The camera is corrected for this on import. Before the fix the carved sword scored 86%; after, 89%.

**Result.** Four rows per subject: the sprites; the Hunyuan3D mesh with one view per texel (step 9); the same mesh with voting (step 10); the carved shape with voting.

![Sprites, mesh with one view per texel, mesh with voting, and carved shape with voting](../website/public/research/3d/texture-shapes.png)

These numbers come from `texture.py` itself, which scores its render in place, so they differ by a point or two from the table in step 9.

| Subject | Shape and rule | Shape | Colour error | Close |
|---|---|---|---|---|
| Character | Mesh, one view | 88.0% | 37.7 | 54% |
| | Mesh, vote | 88.0% | 35.9 | 56% |
| | Carved, vote | 90.5% | 34.5 | 53% |
| Chest | Mesh, one view | 91.2% | 31.1 | 56% |
| | Mesh, vote | 91.2% | 28.5 | 56% |
| | Carved, vote | 91.0% | 28.1 | 57% |
| Sword | Mesh, one view | 89.6% | 32.7 | 56% |
| | Mesh, vote | 89.6% | 29.1 | 58% |
| | Carved, vote | 88.6% | 32.7 | 52% |
| Torch | Mesh, one view | 82.2% | 28.2 | 59% |
| | Mesh, vote | 82.2% | 25.7 | 60% |
| | Carved, vote | 88.0% | 25.6 | 58% |
| Greatsword | Mesh, one view | 88.7% | 14.4 | 79% |
| | Mesh, vote | 88.7% | 13.5 | 81% |
| | Carved, vote | 86.9% | 21.9 | 70% |

- **Carving wins where the object is bulky or not solid.** The character gains 2.5 points of shape and the best colour so far. The torch gains 6 points of shape and gets its whole flame back, because carving keeps anything the sprites show.
- **The mesh wins on thin, flat objects.** Both swords are better as Hunyuan3D meshes. A blade two voxels thick is at the limit of what a 64-voxel grid can hold, and the greatsword was carved from only six views.
- **The chest is a tie.**
- Neither shape is better everywhere, so the choice should be made per object, by score.

**Verdict.** Keep both. The useful rule so far: carve characters, soft or hollow things and anything with parts that are not solid; use a generated mesh for thin rigid objects.

## 12. Carved shape, cut back to the mesh

**Question.** Carving cannot see a gap that no view looks through, such as between the legs. The generated mesh has those gaps. Does keeping only the carved voxels that are near the mesh give the best of both?

**Setup.** `HYBRID=2`: the Hunyuan3D mesh is fitted into the carve's camera and filled in, grown by two voxels, and intersected with the carved voxels. Also tried at one and three voxels.

**Result.** No gain. On the character it changed the scores by a tenth of a point. On both swords the grown mesh covered the whole carved shape, so the result was identical to carving. On the torch it cut part of the flame away (shape 86.3% against 88.0%).

**Verdict.** Drop. The gaps it was meant to open are small at this size, and the mesh does not line up closely enough with the sprite to cut safely.

## 13. Redrawing the rough renders with an image model

**Question.** Everything up to step 12 tries to make the textured model look right by itself. What if the model only has to be roughly right, and an image model draws the final sprite from it?

**Setup.** The carved, vote-textured character from step 11, rendered from sixteen directions: the eight the generator drew and the eight halfway between. Four ways of repairing the sixteen rough renders, all through PixelLab:

| Method | Call | Cost |
|---|---|---|
| Tidy | `correct_pixelart`, strength 0.4, 16 frames | 0.1 |
| Edit by instruction | `edit_image`, 16 frames in one call, told to remove specks and torn patches and keep pose and direction | 10 |
| Edit by reference | `edit_image` with the true south sprite as the reference, 15 frames | 10 |
| Guide sheet | `inpaint_image` on a 256×256 sheet: each true sprite beside the rough view next to it, only the rough ones masked open | 10 |

**Result.** Ten rows. 1: the true sprites. 2 to 5: the model at those same eight directions, as rendered, tidied, edited by instruction, edited by reference (which has no first frame; it was the reference). 6 to 10: the eight directions in between, as rendered, tidied, edited by instruction, edited by reference, and from the guide sheet.

![Four repair methods on the character, at the drawn directions and between them](../website/public/research/3d/repair-methods.png)

- **Tidying does nothing useful.** It is built for stray pixels, not for a torn surface.
- **The two edits and the guide sheet all return clean sprites,** at directions the generator never drew, in the same style and proportions as the eight it did. These are the first in-between views in this note that look like finished art.
- **The outline survives.** Each redraw kept 93 to 100% of the rough render's outline, so the model is deciding the pose and the image model the surface.
- **Edits move the figure.** `edit_image` re-centred some frames by up to six pixels; the guide sheet moved none. A redrawn frame has to be slid back to where its render was.
- **The score does not see the improvement.** Against the true sprites, the instruction edit scores 36.3 colour error where the rough render scores 37.6, and fewer pixels within tolerance (39% against 49%), because the image model picks its own shades. The number says "no better"; the picture says otherwise. Colour error against one drawing was the wrong measure for this step.

**A dressed character.** The same thing on a clothed one: the bare base with greaves, plate, cape and helm composited from the paperdoll layers, on an 80px canvas. It carved at 92%. Held items had to be left off: a sword is held at a different angle in every view, so the carve removes it.

Top pair of rows: directions 1 to 8 as rendered from the model, then after `edit_image` by instruction. Bottom pair: directions 9 to 16. Every second figure is one the generator drew; the ones between are new.

![The dressed knight in sixteen directions, rough and redrawn](../website/public/research/3d/repair-knight-turnaround.png)

The redrawn in-between views are a clean, recognisable knight. They are also a little squat next to the drawn ones: the carve loses some of the horns' height and the head sits lower, and the redraw keeps the model's proportions. Editing by reference cleaned less than editing by instruction here.

The sixteen directions are on the website as a viewer that turns the character, on the [3D characters page](https://pixelkiln.griffen.codes/3d#turnaround), with a switch to the raw model.

**Verdict.** Keep, and change direction. The 3D model does not have to look good. It has to put the right shapes and rough colours in the right place from any angle, and an image model does the drawing. Eight new directions cost 10 generations.

## 14. Painting the redrawn views back onto the model

**Question.** If the redrawn in-between views are clean, does projecting all sixteen onto the model give a clean texture?

**Setup.** `EXTRA` in `texture.py` adds the eight redrawn views as extra cameras, so each texel has sixteen views to vote among.

**Result.** Pairs of rows (drawn directions, then between): the eight-view texture; with the guide-sheet views added; with the instruction edits added; with the reference edits added.

![The model textured from eight views and from sixteen](../website/public/research/3d/repair-reprojected.png)

Slightly smoother, still blotchy, and the score against the sprites got worse (colour error 39 against 34.5), since the new views bring their own shades.

**Verdict.** Drop for now. Sixteen separate drawings disagree as much as eight did. A texture stitched from separate drawings of a 64-pixel figure comes out muddy however the stitching is done, which is the lesson of steps 9 to 14 together.

## 15. Flat materials and light from the renderer

**Question.** The blotches on the stitched texture are each sprite's own hand-drawn shading. If the texture is reduced to flat colour and the light is added by the renderer instead, the same from every side, do they go?

**Setup.** `FLAT=<k>` in `texture.py` sorts the texels into k materials by colour (mostly hue, a little brightness), lets neighbours on the surface agree, and paints each material one colour taken from its lit side. The render then adds three flat bands of light from the upper left, using normals from a smoothed copy of the mesh, since the carved surface is bumpy at the scale of a voxel and raw normals break the bands into noise. `TOON=1` adds the same light without flattening.

**Result.** Each pair of rows is the model from the eight drawn directions and the eight between. Top pair: the bare character as two materials. Middle pair: the knight as nine materials. Bottom pair: the knight with its full stitched texture and the same light.

![Flat materials with toon lighting, and the full texture with the same lighting](../website/public/research/3d/flat-toon.png)

- **The blotches are gone, and so is everything else.** The bare character is a clean clay figure with no face or muscle. The knight keeps its cape and fur and loses its trim, eyes and armour detail; skin and gold run together as orange patches.
- **Black armour came out brown at five materials** and dark grey at nine. Sorting by hue has little to work with on dark, unsaturated colours.
- **The full texture with renderer light (bottom pair) reads best of the three.** The light gives the form a consistent shape that helps hide the stitching.

**Verdict.** Keep the lighting, drop the flattening as a default. Flat colour would suit a simple object or a deliberately flat style. For a character, the detail has to come from somewhere better than eight disagreeing drawings, which is what step 17 is for.

## 16. A skeleton in the mesh

**Question.** Can the carved, textured character leave here as something a 3D game can animate?

**Setup.** [`scripts/rig.py`](../research/scripts/rig.py).

- **Bones.** The 18 joints from step 6 become fifteen bones named the way engines name a humanoid: Hips, Spine, Head, and Upper Arm, Lower Arm, Hand, Upper Leg, Lower Leg, Foot on each side. For the knight, the joints estimated on the bare character were triangulated again in the knight's own frame (mean error 1.4 pixels).
- **Skin weights.** Each vertex follows up to four bones, weighted by how close it is to each. Distance alone would bind an arm hanging at the side to the spine, so a bone is penalised when the straight line from the vertex to it leaves the body.
- **A walk.** One nine-key loop: thighs and upper arms swing against each other, knees bend on the back swing.
- **The file.** A `.glb` in metres, y up, 1.8 m tall, with the texture inside it set to hard pixel edges, the skin, and the animation named `Walk`.

**Result.** Which bone each part of the surface follows most, from four sides:

![Skin weights on the bare character, one colour per bone](../website/public/research/3d/rig-weights.png)

The walk, posed here with the file's own bones and weights and drawn from the front, three-quarters and side. Top three rows: the bare character. Bottom three: the knight.

![Eight frames of the walk for both characters from three angles](../website/public/research/3d/rig-walk.png)

- **Both files pass the Khronos glTF validator** with no errors or warnings.
- **Sizes:** the bare character is 7,571 vertices and 10,460 triangles in 562 KB; the knight is 10,433 vertices and 15,120 triangles.
- **They load and play in three.js**, which is what the viewer on the [3D characters page](https://pixelkiln.griffen.codes/3d#mesh) uses. They were not opened in Blender, Unity, Godot or Unreal here.
- **The knight's cape follows the legs,** because it is bound to the nearest bones like everything else. A cape wants bones of its own or cloth simulation.
- **Dark patches open up on the inner thighs** as the legs part: that surface was never seen by any sprite and was filled in.
- **The hands, feet and head are single bones.** There are no fingers, toes, jaw or eyes.

**Verdict.** Keep. The rig is the part of this note closest to the goal: characters that can be animated and imported into 3D games. The mesh and skeleton are sound. The texture is what is holding the result back.

## 17. Hunyuan3D's paint stage, installed

**Question.** Hunyuan3D has a second stage that textures a mesh from a reference image, consistently from every side. Can it run on the RTX 3060 used in step 8?

**Setup.** The ComfyUI already on that machine could not run it: its built-in Hunyuan3D nodes make shapes only, and the community node that adds the paint stage, [ComfyUI-Hunyuan3DWrapper](https://github.com/kijai/ComfyUI-Hunyuan3DWrapper), ships its compiled renderer for Python 3.12, where that install is Python 3.13. So a second ComfyUI went in beside the first, which was not touched:

- Python 3.12 in its own virtual environment, PyTorch 2.6.0 for CUDA 12.6, and the node's renderer wheel built for that pair.
- ComfyUI pinned to v0.3.27. The current release needs a newer PyTorch than the wheel was built for and fails on start.
- The paint model, `hunyuan3d-paint-v2-0`, which the node downloads on first use: 9.2 GB. The delight model was not used; the sprites carry no photographic lighting to remove.

**Result.**

- **The prebuilt renderer has no GPU code for this card.** It fails with "no kernel image is available for execution on the device": the wheel was compiled for a newer GPU generation. The same library has a CPU path that gives the same result, so one line in `custom_rasterizer/render.py` was changed to move its inputs to the CPU and its outputs back. Rasterising a 1024-pixel view on the CPU takes well under a second. No compiler or CUDA toolkit was installed.
- **It fits in 12 GB.** A full pass, six views at 512 pixels and 25 steps, takes about 40 seconds once the model is loaded, and about two minutes cold.
- **Given one front view, it invents the rest, and gets the back wrong.** The six views it painted for the knight from the south sprite alone: front, side, back, side, top, bottom. The back has a second face and chest where the cape should be.

![Six views painted from one front reference; the back view shows a second face](../website/public/research/3d/paint-single-reference.png)

**Verdict.** Keep. It runs, it is fast, and its front view is the first picture in this note that is both faithful to the sprite and fitted to the mesh. Step 20 uses that.

## 18. A flat base with the sprites laid back on top

**Question.** Step 15's flat materials were clean and featureless. If the flat texture is the base, and the sprites' own pixels are put back only where they can be trusted, is the result both clean and detailed?

**Setup.** `OVERLAY=<0 to 1>` in `texture.py`, with `FLAT`. A texel takes its sprite colour back when the surface faces the view at least that squarely, it is not on the sprite's rim or beside a jump in depth, the views that see it agree within `AGREE`, and its colour differs from the flat material by at least `DEV` (so soft painted shading stays out and eyes and trim come back).

**Result.** On the carved knight, 58% of texels were trusted. Colour error: 22.5 for the full stitched texture, 30.6 flat, 24.6 with the overlay.

- **The eyes, belt and gold trim come back** over a cleaner cape.
- **The torn areas look the same as before.** They sit exactly where the overlay trusts the sprites least, so they fall back to flat patches of the wrong material.
- **The flat row shows why.** With the detail gone, the carved knight is a lump: arms fused to the torso, legs fused together, horns reduced to stubs. Eight silhouettes cannot carve the gap between an arm and the body. No way of laying colour on that shape gives a clean arm.

**Verdict.** Drop. The tearing is in the shape, not the shading. This sent the work back to the mesh, in step 19.

## 19. The generated mesh for the knight

**Question.** Step 11 found the carved shape better than the Hunyuan3D mesh for bulky subjects. Is that still true for a character with horns, a cape and limbs?

**Setup.** The knight's south, west, north and east sprites through the Hunyuan3D-2mv graph from step 8 (147 seconds), then the same staged texturing, fitted into the carve's camera.

**Result.** The drawn sprite, then the model from the front, a drawn diagonal and three in-between directions. Row 1: carved shape. Row 2: generated mesh. Row 3: generated mesh, flat. Row 4: generated mesh with step 18's overlay.

![The knight on the carved shape and on the generated mesh, with full, flat and overlaid textures](../website/public/research/3d/mesh-source-overlay.png)

- **The generated mesh has what carving cannot give:** curved horns, arms away from the body, two legs, a cape that hangs behind.
- **The same texturing reads far better on it,** though it scores lower on shape (82% against 87%), because the model's proportions are its own.
- **On the bare character there is no gain.** Shape 86.8% against 90.5%, colour error 36.3 against 34.5, and more stray dark specks. A simple body carves well.
- **The rig script needed one fix for it.** Horns that reach past the carved hull were following the arm bones; everything above the ears is now bound to the head.

**Verdict.** Keep, for anything with parts that stand away from the body. The carved shape stays the better choice for simple, solid subjects, and its camera is still what fits the mesh to the sprites.

## 20. The paint stage, once for each sprite

**Question.** Step 17's model paints a faithful, well-fitted front and a wrong everything else. There are eight sprites. Can each one be the front?

**Setup.** [`scripts/hunyuan3d_paint_turn.py`](../research/scripts/hunyuan3d_paint_turn.py). For each of the eight directions the mesh is turned to face the camera, that direction's sprite is the reference, the model paints its six views, and only the first is kept. Asked for one view alone the model returns grey noise; it was trained to paint six together. The eight kept views are then baked onto the unturned mesh with the node's own baking, each from the angle it was painted at, and the gaps are filled. About six minutes for a character.

**Result.** Top row: the eight sprites. Middle: the mesh turned to face each. Bottom: what the model painted.

![Eight sprites, the mesh turned to each, and the eight painted views](../website/public/research/3d/paint-turn-views.png)

Every painted view is its sprite, redrawn to sit exactly on the mesh: the cape is on the back, the emblem is on the chest, the arms are where the mesh's arms are. This is the image-model redraw of step 13 with one thing added, which is that the model is told the shape.

The baked result against the stitched texture of step 10, on the same meshes, drawn large from the front, an in-between angle, a diagonal, the side, an in-between angle and the back. Top of each pair: stitched. Bottom: painted.

![Stitched and painted textures on the knight and the bare character from six angles](../website/public/research/3d/paint-vs-stitched.png)

- **The tearing is gone.** Armour, belt, face and limbs are continuous from every angle, including the ones no sprite was drawn from.
- **The scores do not show it.** At sprite size, against the drawn sprites, the painted knight scores a colour error of 37.8 where the stitched one scores 31.1. The painted texture is a redraw, not a copy, and a render of it shrunk to 80 pixels picks up noise the stitched texture, made at that size, does not. The measure rewards copying pixels; step 13 met the same limit.
- **It is no longer pixel art on the surface.** The views are 512 pixels with soft-edged blocks. The texture is 1024 pixels, shrunk to 512 in the rigged files.
- **Light rims on the cape's edges,** where the grey ground of a painted view was baked onto the silhouette.
- **Seams where two views meet,** most visible on the bare character's arms and head, as blocks that do not line up.
- **Both characters were rigged again from the painted meshes** and pass the glTF validator: 23,565 vertices and 2.0 MB for the knight, 21,327 vertices and 1.9 MB for the bare character. These are the files in the viewer on the [3D characters page](https://pixelkiln.griffen.codes/3d#mesh).
- **Licence.** The paint model is published with the shape model, under the same Tencent licence and regional exclusion. The source files of its renderer name a non-commercial licence in their headers. Which terms apply to textures made with it was not settled here: treat these as a research result, and read the licence before shipping one in a game.

**Verdict.** Keep. A generated mesh, fitted to the sprites' camera, painted once per sprite and rigged is the best route found so far from eight sprites to an animated 3D character.

## 21. An A-pose, drawn by the generator

**Question.** Every mesh so far was made from a character standing with its arms at its sides, so the arms fuse to the body or sit against it, and the rig has to guess where one ends and the other begins. 3D characters are modelled with the arms held out for this reason. Can the generator redraw ours that way?

**Setup.** PixelLab's `create_character_state` on each character, with the edit "standing in an A-pose: both arms straight and held out to the sides, 45 degrees away from the body, hands open and well clear of the hips, legs straight and slightly apart with a clear gap between them", and the palette locked to the source. The knight is a composite of paperdoll layers, not a PixelLab character, so its eight sprites were first imported as one with `create_character` (a reference image plus seven direction images; nothing is generated). Cost: 10 generations for each state, 0.25 for the import.

**Result.** Each pair is the character as it was and its A-pose.

![The knight and the bare character, standing and in an A-pose, in eight directions](../website/public/research/3d/apose-sprites.png)

- **The character survives.** Helmet, horns, fur, cape, emblem and palette are the same; only the pose moved.
- **The eight views do not agree on the pose.** The knight's back view came out as a T-pose, arms level, while the other seven have them at 45 degrees. Triangulating the joints shows it: about 1.8 pixels of mean error on both characters, against 1.3 to 1.4 standing, and 4.5 at the wrists.
- **The generated mesh tolerates it.** Carving needs the views to agree; the mesh model reads four views as hints, and built one consistent pose from them.

**Verdict.** Keep. It is cheap, and steps 22 and 24 depend on it.

## 22. Smooth pictures for the mesh model

**Question.** The first A-pose mesh of the bare character came out as a figure made of boxes, with a cube for a head. Why?

**Setup.** Since step 8 the four input pictures have been the 64 pixel sprites enlarged with hard edges, so every sprite pixel is a square eight pixels wide. Here they are enlarged with bicubic filtering instead, and the outline is cut through a blurred copy of the transparency so the stair steps round off. Nothing else changes. The fit in [`scripts/texture.py`](../research/scripts/texture.py) also gained `TURNS=0`: a bare, symmetric figure has the same outline from the front and the back, and the fit put this one in backwards until it was told the mesh already faces the way the south sprite does.

**Result.** Each pair is the mesh from hard-edged inputs, then from smooth ones. Top pair: the bare character. Bottom pair: the knight.

![Meshes from hard-edged and from smoothed inputs, for both characters](../website/public/research/3d/mesh-hard-vs-smooth.png)

- **The model took the squares literally.** Given blocks, it built a block figure, 0.56 units deep where the smooth one is 0.61, with flat panels for a chest. Given a smooth picture it sculpts a head with a brow, ears, a chest, hands with fingers.
- **The knight changes less,** because its hard-edged mesh was already recognisable, but the cape gains folds and the limbs round off.
- **This was true all along.** The bare character's mesh in steps 8 and 19 was the block figure; step 19's finding that the generated mesh was "no gain" for it was measured on that.

**Verdict.** Keep. One resize, and the largest gain in shape since step 8.

## 23. Baking the painted views here, with side views

**Question.** Step 20 left three faults in the texture: light rims on the cape, seams where two views meet, and only eight views to cover the whole surface. Baking was done inside the paint node, which offers no control over any of them.

**Setup.** [`scripts/bake.py`](../research/scripts/bake.py) does the bake on this machine in seconds. It finds where the mesh sits in each painted view from the node's own render of it (the two agree on 99% of pixels), then gives each texel a blend of the views that see it, weighted by how squarely the surface faces each view. Four things were tried on top:

- **Side views.** The paint model always paints six views at once, and step 20 threw five away. With `SPREAD=22` in [`scripts/hunyuan3d_paint_turn.py`](../research/scripts/hunyuan3d_paint_turn.py) two of the six cameras sit 22 degrees to either side of the sprite's own, and those are kept too: 24 views from the same eight passes, at no extra time.
- **Colour correction.** Each painted view is moved back to its sprite's mean and spread per channel, because the model redraws the sprite a little lighter and warmer than it is.
- **Rims.** Give a view no weight within a few pixels of its outline or of a jump in depth.
- **Colour matching.** Shift each view's colour so views agree where they overlap.

**Result.** The knight from the front, a diagonal, the side and the back. Top: eight views, colour corrected. Middle: 24 views. Bottom: eight views with the rim rule.

![The knight baked from eight views, from 24 views, and with the rim rule](../website/public/research/3d/bake-settings.png)

- **Side views smooth the joins.** With 24 views no two neighbours are more than 23 degrees apart, and the cape and collar lose the blocks that did not line up.
- **The rim rule made it worse.** It pushes good views out near every edge and what replaces them is a view from the side, which has only its dark outline to offer there: speckles on the legs and helmet. The light rims of step 20 are gone without it. They came from the node's bake, not from the views.
- **Colour matching made it worse too.** The sprites are lit from the front, so back views are darker on purpose. Matching them moved colours by up to 34 levels, and the bare character's colour error went from 36.5 to 38.5.
- **Colour correction is a small gain:** colour error 37.4 to 36.5 on the bare character.

The result against step 20's, each pair the old model then the new, from the front, a diagonal, the side and the back:

![Step 20's painted models and the new ones, for both characters](../website/public/research/3d/apose-painted.png)

**Verdict.** Keep the local bake, the side views and the colour correction. Rims and matching are still in the script, off.

## 24. Skin weights measured through the mesh

**Question.** Step 16 bound each vertex to the nearest bones in a straight line, with a penalty when the line left the carved shape. The cape, which hangs beside the legs, followed the legs. And the rest pose is now an A-pose, so a walk that only swings the arms walks with them held out.

**Setup.** Three changes to [`scripts/rig.py`](../research/scripts/rig.py), used when it is given `-` in place of the carved voxels:

- **The mesh is filled in** on a grid of half sprite pixels, and distance from a vertex to a bone is the shortest path through the inside of the body. A cape is a long way from a leg by that measure: up to the collar and back down.
- **Elbows, wrists, knees and ankles move to the middle of the mesh's own limbs.** The joints were found on the sprites and the mesh is a redraw of them.
- **The walk lowers the arms first,** turning each upper arm from where it rests to hanging 12 degrees out from straight down, and swings them from there.

**Result.** Top row: which bone owns each part, by straight-line distance. Second row: through the mesh. Below: the walk from the front, three-quarters and the side.

![Skin weights by straight line and through the mesh, and the knight's walk](../website/public/research/3d/rig-through-the-mesh.png)

- **The cape is one piece now,** owned by the spine at the top and the hips below, where the straight-line weights cut it into strips that followed each leg bone.
- **It is also rigid.** A leg swinging back passes through it. It wants bones of its own.
- **Both files pass the glTF validator** with no errors or warnings: 1.8 MB for the knight, 1.7 MB for the bare character.

**Verdict.** Keep.

## 25. The pixel look, in the renderer

**Question.** The painted texture is a 512 pixel painting. Drawn small it should still read as pixel art, in the sprites' colours. Does that belong in the texture or in the renderer?

**Setup.**

- *In the file.* `PALETTE=<dir>:<name>` in `rig.py` stores 24 of the sprites' colours on the material, as glTF extras. The colours are picked by spreading them across everything the sprites use. Pillow's median cut was tried first and gave the knight eight near-blacks and no gold.
- *In the viewer.* The pixel look draws the scene into a small picture, then onto the screen with each pixel moved to the nearest stored colour and a dark line drawn inside the outline.
- *In the score.* [`scripts/render.py`](../research/scripts/render.py) gained `SAMPLE=mean`: each sprite-size pixel is the average of the surface under it, then snapped to the palette, which is what a renderer that filters its texture shows. Before, it took the commonest single colour, which is noise on a detailed texture.

**Result.** The bare character at sprite size. Row 1: the drawn sprites. Row 2: the stitched texture of step 10. Rows 3 and 4: the painted texture from the drawn directions and from the eight between.

![The bare character at sprite size: sprites, stitched texture, painted texture](../website/public/research/3d/sprite-size-hero.png)

The knight: sprites, the painted model from the same directions, and from the eight between.

![The knight at sprite size: sprites and the painted model](../website/public/research/3d/sprite-size-knight.png)

| | Stitched | Painted, commonest colour | Painted, averaged and snapped |
|---|---|---|---|
| Bare character, colour error | 30.0 | 36.7 | 35.1 |
| Knight, colour error | 30.7 | 37.3 | 36.7 |

- **The painted renders are shaded like sprites,** with a face and a lit side, in directions nobody drew. The stitched ones are flat.
- **The score still says the opposite.** It compares pixel against pixel, and the mesh's arms are not where the sprite's arms are (the outlines agree 83% and 78%), so a clean shaded arm one pixel over scores worse than a flat smear in the right place.
- **Snapping the texture itself was not pursued.** The texture's islands lie at every angle on the surface, so texture pixels cannot line up with screen pixels. The renderer is the place for it.

**Verdict.** Keep the palette in the file and the snap in the renderer. The score needs replacing before it can steer anything.

## 26. A body made to be dressed

**Question.** Steps 19 to 25 meshed the knight with its armour on, as one piece. A game that swaps gear needs the reverse: one bare body, and each item a mesh of its own that any body can wear. That starts with a body. The bare character used so far also read as an infant once meshed: short, round and unclothed.

**Setup.**

- *The body.* PixelLab's v3 character at 64 pixels, through a PixelKiln manifest, with the base prompt from the [paperdoll guide](./PAPERDOLL.md) plus the pose: "bald adult human figure with adult proportions, slim and lean with a small head, broad shoulders and long legs ... standing straight in an A-pose with both arms held straight and out to the sides at 45 degrees". 2 generations.
- *The items.* Five PixelKiln `layer` assets over the body's eight directions: underwear, leg armour, a cuirass, a horned helm and a cape. Each is one masked inpaint that returns only the pixels it added. 10 generations each. The helm's first job failed at PixelLab and passed on a retry.
- *The joints.* `pixelkiln anchors`, 0.8 generations for the eight views.

**Result.** Row 1 is the body, rows 2 to 5 the layers for underwear, leg armour, cuirass and cape, and row 6 the body wearing the first three.

![The bare body in eight directions, four item layers, and the body dressed](../website/public/research/3d/parts-layers.png)

- **The arms came out level in all eight views,** a T-pose and not the 45 degrees asked for. The views agree with each other, which step 21 could not get from an edit.
- **The layers are clean.** Nothing but the item in each, in every direction.

The body in underwear, meshed from smoothed inputs (step 22) and textured by stitching (step 10):

![The body mesh from five directions](../website/public/research/3d/parts-body.png)

- **It no longer reads as an infant,** but it is stockier than the sprite. The sprite is about four heads tall, as pixel characters are so that a face fits in a dozen pixels, and the mesh model fills that build out. The outline matches the sprites 82.1%.

**Verdict.** Keep the body. An adult's seven or eight heads would need a sprite too tall to be a game sprite, so the build is the style's, not a fault to fix here.

## 27. An item as its own mesh: alone, or cut from the body wearing it

**Question.** What is the best way to get a mesh of one item that fits the body?

**Setup.** Two routes, on the same four items.

- *Alone.* The item's layer, with no body, enlarged to fill the picture ([`scripts/smooth_inputs.py`](../research/scripts/smooth_inputs.py) with `FILL=1`), meshed by Hunyuan3D-2mv.
- *Cut from the worn mesh.* The body wearing that one item is meshed. A second set of sprites with the same outline is painted green where the item's layer has a pixel and magenta elsewhere. Texturing the mesh from those says which triangles are the item, and [`scripts/cut_item.py`](../research/scripts/cut_item.py) keeps them.

Every mesh is fitted in the body's camera frame, so each lands where it is worn. `texture.py` now starts a fit at the point in space where the item's sprites are, since a helm is nowhere near the middle of the frame.

The cut for the helm: the worn mesh, the same mesh textured from the mask sprites, and what is kept.

![The body wearing the helm, the same mesh in green and magenta, and the helm alone](../website/public/research/3d/parts-cut-helm.png)

**Result.** Left: each item meshed alone. Right: each cut from the worn mesh. Rows are helm, cuirass, leg armour, cape.

![Four items meshed alone, and the same four cut from the body wearing them](../website/public/research/3d/parts-alone-vs-cut.png)

| Item | Outline match, alone | Outline match, worn | Triangles kept by the cut |
|---|---|---|---|
| Helm | 71.2% | 74.9% | 8,992 of 29,999 |
| Cuirass | 76.5% | 81.4% | 10,811 |
| Leg armour | 62.5% | 82.3% | 11,830 |
| Cape | 61.7% | 84.3% | 15,427 |

The two outline columns are not like for like: alone, the mesh is compared with the item's layer, and worn, the whole dressed figure with its sprites.

- **Alone, the model does not know what it is looking at.** The leg armour became two flat boards and the cape three separate slabs. The helm became a box with horns, and the cuirass a solid torso.
- **Worn, the body tells it.** The leg armour wraps two legs, the cape hangs as one sheet from a collar, and the helm is round.
- **The cut is ragged at the edges** and leaves a fringe of skin-coloured triangles where an outline pixel was shared. Each cut also leaves 25 to 40 loose pieces, most of them crumbs.
- **A cut item is a shell.** It has no inside, which is what a game wants from clothing.

**Verdict.** Cut from the worn mesh. It costs one mesh per item either way, about two minutes each.

## 28. A character assembled from parts

**Question.** Do a body and items made separately go together, and move together?

**Setup.** [`scripts/rig.py`](../research/scripts/rig.py) gained `ITEMS`: a list of item meshes to put on the body's skeleton.

- *Fit.* An item is drawn one pixel outside the body and meshed from a different run, so parts of it land inside the body's mesh: the first helm showed the face through its front. Each item vertex closer than 0.6 sprite pixels to the skin is moved out along the body's surface direction until it is that far above it. Triangles buried deep in the body that face inward are dropped.
- *Weights.* An item vertex takes the bone distances of the nearest point inside the body (step 24), so tight armour moves as the skin under it does. A slot can name the bones it may follow: the helm follows the head only, the cape the hips and spine only.
- *File.* One .glb with five meshes on one skeleton and one walk. The viewer shows a switch per mesh.

**Result.**

![The body wearing all four items, from five directions](../website/public/research/3d/parts-assembled.png)

- **It reads as the knight,** from parts that were never meshed together. Nothing pokes through in the rest pose.
- **Items come off one at a time** in the viewer on the [3D characters page](https://pixelkiln.griffen.codes/3d#mesh), and the body under them is whole.
- **The file is 3.6 MB:** five meshes of up to 30,000 triangles and five 256 pixel textures. It passes the glTF validator with no errors or warnings.
- **The textures are the stitched ones of step 10,** noisy on the armour. Step 29 paints them.

Not checked: whether skin shows through armour at the extremes of the walk, an item on a second body, two items in the same slot, and any engine other than three.js.

**Verdict.** Keep. This is the shape a game can use: a body, a rack of items, one skeleton.

## 29. Painting the parts

**Question.** Step 28's textures are stitched from the sprites and noisy. Does the paint stage of steps 20 and 23 work on parts?

**Setup.** The body and each of the four worn meshes went through `hunyuan3d_paint_turn.py` with `SPREAD=22` and `bake.py` at 1024 pixels, exactly as in step 23, each with its own sprites as references. The item is cut out afterwards with the same mask as before: painting changes the texture and not the triangles, so `cut_item.py` takes the painted mesh and the mask mesh from step 27 unchanged. About 40 seconds a direction, five to six minutes a mesh.

**Result.** The body, stitched and then painted:

![The body with a stitched texture and with a painted one](../website/public/research/3d/parts-body-painted.png)

The assembled character, stitched and then painted:

![The assembled knight with stitched textures and with painted ones](../website/public/research/3d/parts-painted.png)

- **The speckle is gone.** The armour has plates and trim, the cape has folds, the helm is one metal, and the body's black outline flecks are gone.
- **Colours drift.** The helm and underwear turn blue-grey, and the gold is duller with the chest crest fainter. Step 23's colour correction is on and does not hold them. The viewer's palette snap pulls them part of the way back.
- **Painting the worn mesh paints the item in context,** so the cuirass is shaded as something on a chest. The price is that each item's texture is 1024 pixels of which the item uses a third.
- **Orange flecks appear on the leg armour during the walk** in the viewer with the pixel look on. They were first taken for skin showing through. Step 30 shows they are not.
- **The file grew to 5.6 MB** with five 512 pixel textures. It passes the glTF validator with no errors or warnings.

**Verdict.** Keep the painted parts.

## 30. Hiding the skin under an item

**Question.** Games hide the body under clothing so that skin cannot show through it in motion. Can the file say which skin each item hides?

**Setup.** `rig.py` now writes the body as one mesh per set of items that cover it.

- *Covered.* A body vertex is covered by an item when the item's surface is within 1.2 sprite pixels of it (`COVER`). A triangle is hidden by the item only when its corners and all their neighbours are covered, which leaves a rim of skin under the item's edge.
- *Loose items.* A third field in an item's entry, `loose`, marks one that hides nothing. The cape is loose: it swings away from the back it hangs behind.
- *In the file.* Each body piece is a node whose extras carry `"hiddenBy": ["Cuirass"]`. A piece is hidden while any item in its list is worn. The pieces share one material and texture.

**Result.** The body came out as six pieces:

| Piece | Triangles |
|---|---|
| Never hidden (face, neck, hands, edges) | 6,359 |
| Under the leg armour | 9,222 |
| Under the cuirass | 8,988 |
| Under both | 1,602 |
| Under the helm | 3,714 |
| Under the cuirass and the helm | 115 |

- **It works in the viewer.** With everything worn, 79% of the body is not drawn. Taking the cuirass and helm off brings the chest and head back.
- **The orange flecks of step 29 were still there,** which showed they were never skin. With the pixel look off there were none. The paint stage had dulled the gold trim, and the viewer's palette snap moved the dulled gold to the nearest stored colour, which was a skin tone.
- **Baking each item in its own colours fixes that.** `bake.py` already had `PALETTE`; each worn mesh is baked snapped to the 32 colours of that item's own layer, so the item carries no colour its sprite lacks. Top row: before. Bottom row: after. The helm is steel again and not blue.

![The assembled knight before and after baking each item in its own sprite colours](../website/public/research/3d/parts-own-colours.png)

- **The gold is darker than the sprite's** after the snap, closer to olive on the arms. The paint stage's drift is reduced, not undone.
- **The file is 5.4 MB.**

Not checked: whether the rim of skin kept under an item's edge is enough when a limb bends far, and whether an engine reads the extras (three.js does; Godot and Unity each have their own way).

**Verdict.** Keep both. A wrong guess about the flecks cost a step, and the test that settled it was turning the pixel look off.

## 31. Sprite cards on the skeleton

**Question.** Steps 26 to 30 show a painted mesh, and every flaw in the paint is on screen. The Cor Mundi Studios short (see [what other people are doing](#what-other-people-are-doing)) shows the sprites themselves, as a flat card per body part moved by a rig, with a mesh underneath that is never seen. Do the pieces made so far add up to that?

**Setup.** No new art and no generations.

- *Cutting.* [`scripts/cards.py`](../research/scripts/cards.py) draws the body mesh into each of the eight sprite views, coloured by the bone that owns each point (`rig.py` writes that with `SKIN=<file>`). Every sprite pixel takes the bone of the mesh under it, or of the nearest pixel that has one. Each sprite and each item layer is then cut into one piece per bone, reaching two pixels into its neighbours to cover the joints. The helm goes whole on the head and the cape whole on the spine.
- *The sheet.* 259 pieces from five layers pack into one 512 by 128 picture of 45 KB, with a list of where each piece is and how far its corner is from its bone's joint.

![The packed pieces: capes and helms whole, then bodies, limbs and armour cut by bone](../website/public/research/3d/cards-atlas.png)

- *Drawing.* In the viewer each bone carries a card turned to face the camera. The camera's direction is taken into the bone's own frame, and the card shows the piece from the drawn view that best matches it. A view is preferred when it sees the bone as end-on or as side-on as the camera now does: an arm drawn sticking out sideways and then lowered by the walk is seen side-on from the character's side, so it uses the front view's arm, turned to hang down. The plain "nearest direction" rule picked the side view's arm, which is a foreshortened stub.
- *Order.* Cards sit at their bones, so the near arm is in front of the body and the far arm behind it with no rule. Item layers sit a few millimetres nearer the camera than the body. The cape moves behind or in front with the side the camera is on.
- *Motion.* The same fifteen bones and walk as the mesh. The file that carries them is the body mesh with a 64 pixel texture, 1.3 MB, most of which a real use would drop.

**Result.** Front, side and back standing, and the side walking, in the viewer with the pixel look on:

![The knight drawn as sprite cards, from the front, side, back, and walking](../website/public/research/3d/cards-viewer.png)

- **It is the sprite, in motion, from any angle.** The emblem, the trim and the helm's eyes are the drawn pixels, with none of the paint stage's blur or colour drift.
- **Items switch on and off** as layers, as in the 2D builder, and the walk moves all of them.
- **It worked on the first run,** which says the camera fit, the joints and the bone ownership from the earlier steps agree with each other.
- **Between the eight directions the picture is one of the eight,** turned to face the camera, so the character snaps from view to view as it turns.
- **Pieces are rotated pictures,** so a lowered arm is the raised arm's pixels on a slant, and the joints overlap or open a little as limbs swing.
- **There is no lighting.** The short lights its cards from the hidden mesh; that was not tried.

Not checked: sixteen directions (step 13 could supply them), any engine other than three.js, and poses far from the drawn one.

**Verdict.** Keep, beside the painted mesh and not instead of it. The cards are sharper today; the mesh is the only one that can be lit, seen from above, or posed freely.

## 32. Larger references, redrawn locally

**Question.** The goal from here is the best painted surface, not pixel art. The survey says the reference picture is the first cap: the paint stage has been shown a 46 pixel figure enlarged with hard edges. Can the sprites be redrawn large, for nothing, and does the paint improve?

**Setup.**

- *Redraw.* [`scripts/redraw.py`](../research/scripts/redraw.py) cuts the figure out of each sprite, enlarges it smoothly to 1024 pixels and has SDXL redraw it on the ComfyUI already used for meshes. The checkpoint (`sd_xl_base_1.0`) and a tile control model (`controlnet-union-sdxl-promax`) were already on the machine, so nothing was downloaded and no generations were spent. About 25 seconds a direction.
- *Settings.* A tile control held at 0.8 for every step, with the model allowed to change half the picture, returned the blurry enlargement unchanged. Letting the model change 90% while the control applies at 0.6 for the first half of the steps gives a redraw that keeps the layout. Left to right: the sprite, a cautious setting, the setting kept, and an anime checkpoint that flattened it.

![The sprite and three redraws of it](../website/public/research/3d/hd-redraw-settings.png)

- *Paint.* The body wearing the cuirass, the same mesh as step 29, painted from the eight redraws and baked at 2048 pixels. Once with 512 pixel views as before, once with 768.

**Result.** The eight redraws:

![Eight redrawn directions of the body wearing the cuirass](../website/public/research/3d/hd-redraws.png)

The mesh painted from the sprites (step 29), from the redraws at 512 pixel views, and from the redraws at 768:

![The same mesh painted from sprites, from redraws, and from redraws with larger views](../website/public/research/3d/hd-painted.png)

- **The paint now has things in it:** plate edges, a collar, a crest with a shape, a face with brows and ears. Before, it was the sprite's pixels enlarged.
- **768 pixel views fit in 12 GB** and are a little sharper, at about 110 seconds a direction against 40.
- **The redraws do not agree with each other.** Each direction is redrawn alone, so the crest, the shoulder plates and the face differ from view to view, and the bake averages them. The back view came back still pixelated.
- **Colours move.** The black armour became grey steel and the skin paler. Nothing ties a redraw to the sprite's palette.
- **The mesh is now the limit you see.** Flat facets show on the head and limbs under a detailed texture.

Not done: the other items, the bare body, and the assembled model in the viewer, which still carries step 30's textures.

**Verdict.** Keep. The largest gain in texture quality so far, for no cost but GPU time. The next gains are in making the eight redraws agree and in a smoother mesh.

## 33. Making the redraws agree

**Question.** Step 32's eight redraws each invent their own details and their own colours. Two fixes were tried.

**Setup.** Both are options of [`scripts/redraw.py`](../research/scripts/redraw.py).

- *One sheet* (`SHEET=1`). All eight figures are put on one 2048 by 1024 picture and redrawn together, so the model sees one character from eight angles. Each figure is then enlarged and sharpened alone, with the model allowed to change 35%.
- *Colours held* (`COLOUR=1`, now the default). The redraw's broad colour is swapped for the sprite's, region by region: a blurred copy of the redraw is taken out and a blurred copy of the enlarged sprite put in, leaving only the redraw's detail. The blur is a fortieth of the picture wide.

**Result.** The same mesh painted from: step 32's redraws; redraws made alone with colours held; one-sheet redraws with colours held.

![The mesh painted from three sets of redraws](../website/public/research/3d/hd-painted-agree.png)

- **Holding the colours is the fix.** The armour is black again and the skin is the sprite's, with the plates, crest and face of step 32 intact. Because every view now shares the sprite's colours, the views also disagree less where they meet.
- **The sheet agrees and loses the rest.** At a quarter of the pixels a figure, the model drew a soft suit with gold swirls in place of plates, and a child's face. The sharpening pass cannot put back a design that was never drawn.

**Verdict.** Keep the colour hold, drop the sheet. Details still differ between directions; the bake blends them.

## 34. A mesh from redrawn pictures

**Question.** The mesh model has been shown the sprites, enlarged smoothly (step 22). Its meshes have a faceted skull and lumpy limbs. Is that the model, or the pictures it is given?

**Setup.** The bare body's front, left, back and right sprites were redrawn at 1024 pixels as in step 32, with `OUTLINE=own`. By default a redraw is cut with the sprite's own enlarged outline, which keeps its stair steps: a head drawn in a dozen pixels has corners. `OUTLINE=own` keeps the outline the model drew, taking as ground whatever is near the ground colour and joined to the picture's border. The four redraws went to Hunyuan3D-2mv with nothing else changed.

Top: what the mesh model was given before. Bottom: the redraws.

![The four smoothed sprites, and the four redraws, given to the mesh model](../website/public/research/3d/hd-mesh-inputs.png)

**Result.** Top: the mesh of step 26. Bottom: the mesh from the redraws.

![The body mesh from smoothed sprites and from redrawn pictures](../website/public/research/3d/hd-mesh.png)

- **It was the pictures.** The new mesh has a round skull, a brow, nose and ears, a chest, shoulder blades, arms that taper, calves. The old one is a figure of flat panels.
- **The redraw's outline matters as much as its inside.** The model builds what the outline shows, and the sprite's outline is a staircase.
- **The back view's outline is still partly stepped,** where the redraw kept the sprite's edge.

Not done: fitting this mesh to the sprites, painting it, the worn meshes, or anything in the viewer. The redraws are no longer pixel for pixel on the sprites, so the fit of step 9 and the item cut of step 27 need checking against them.

**Verdict.** Keep. Next is to rebuild the body and items from redrawn pictures end to end.

## 35. Everything rebuilt from redrawn pictures

**Question.** Steps 32 to 34 each improved one piece. Does the whole chain of steps 26 to 30 still hold when it starts from redrawn pictures?

**Setup.** One script ran, for the bare body and for the body wearing each of the four items:

1. `redraw.py` on all eight directions, with the model's own outline and a white ground (`OUTLINE=own GROUND=255`). 25 to 45 seconds a direction.
2. Hunyuan3D-2mv on the front, left, back and right redraws. About two minutes a mesh.
3. `texture.py` to fit each mesh into the body's camera, against the sprites as before.
4. The paint stage from the eight redraws with 768 pixel views, and `bake.py` at 2048 pixels. About 15 minutes a mesh.
5. `cut_item.py` with the mask sprites of step 27, then `rig.py` as in step 30.

About two hours of GPU time, unattended, and no generations.

Two faults in our own scripts surfaced and were fixed:

- **The cut was throwing away good triangles.** It drops loose crumbs by counting connected triangles, but the unwrap splits vertices along its seams, so every patch of the unwrap counted as a separate piece and small patches were dropped as crumbs. It now joins vertices that are in the same place first. The four items went from 25 to 60 "pieces" each to 1 to 3. Steps 27 to 30 had this fault too; their holes were blamed on a ragged cut.
- **`rig.py` gained `ALIGN`,** which slides an item until it is evenly spaced round the body. Here it moved items less than half a sprite pixel, so the separate fits already agree; it is kept as a safeguard.

**Result.** The bare body, before and after:

![The body of step 29 and the body rebuilt from redrawn pictures](../website/public/research/3d/rebuilt-body.png)

The cape, leg armour and helm, cut from their rebuilt worn meshes:

![The rebuilt cape, leg armour and helm on their own](../website/public/research/3d/rebuilt-items.png)

The assembled character with hidden skin left out, step 30 above and the rebuild below:

![The assembled knight of step 30 and the rebuild](../website/public/research/3d/rebuilt-assembled.png)

- **The body is sculpted and painted,** with a face, ears, muscle and a round skull. Dark smears run along the tops of the arms, where the redraws' outlines were baked in.
- **The helm and leg armour are the best pieces so far:** plates, rivets, trim and a visor, on smooth shapes.
- **One sleeve of the cuirass ends at mid forearm,** and there is bare skin at one hip between the cuirass and the leg armour. The item masks are still the sprites' layers, and a redrawn figure is not pixel for pixel where the sprite was, so the mask lands a pixel or two off on the new mesh.
- **The fur collar is teal.** This was first put down to the colour hold of step 33 not reaching outside the sprite. Step 36 shows the redraw is grey and the bake is what turns it teal.
- **The cuts carry scraps of skin** at the hands and neck, for the same reason as the short sleeve.
- **The file is 6.0 MB** with 512 pixel textures (10.8 MB at 1024), and passes the glTF validator with no errors or warnings.

In the viewer the rebuilt model loads, walks, and its items switch off. It is shown smooth by default now, with the pixel look as a switch.

**Verdict.** Keep as the viewer's model. The next fault to fix is the masks: they should be made from the redraws, not the sprites.

## 36. Item edges from the paint, and a colour fault in the bake

**Question.** Step 35 left three faults: skin where an item should be, scraps of skin on the items, and a teal collar. Are the masks to blame, as supposed?

**Setup.**

- *Edges.* [`scripts/cut_item.py`](../research/scripts/cut_item.py) takes the bare body's painted mesh as `BODY`. The mask from the sprites still says roughly where the item is. Within three sprite pixels of the mask's edge the paint decides: a triangle painted as skin is left out, and a triangle is taken in when it is not skin and is painted unlike the bare body at the same place. Skin is learned from the body's own texture, as a spread of colour with brightness left out. Both meshes are in the same frame, so "the same place" is the nearest point of the body.
- *Why two tests.* The first version took in anything near the edge that was not skin, and the cuirass grew a skirt of underwear. The underwear is on both meshes, so comparing against the body leaves it alone.
- *Colour.* The collar was traced from sprite to redraw to painted view to texture. It is grey in all but the last.

**Result.** The cuirass cut with the sprite mask alone, and with the edge moved:

![The cuirass cut by the sprite mask, and with its edge moved to where the paint puts it](../website/public/research/3d/masks-cuirass.png)

The assembled character: step 35 with the new edges, the same with the bake corrected, and the bare body.

![The assembled knight with new edges, then with the bake's colour shift off, and the bare body](../website/public/research/3d/masks-and-colour.png)

- **The scraps of hand and neck are gone,** and so is the bare patch at the hip. Each cut moved about a thousand triangles each way.
- **The teal was `bake.py`'s `TONE`,** not the redraw. `TONE` moves each painted view's colours to match its reference's average, one channel at a time. It was added in step 23, when the references were sprites, as a small gain. A painted view of the back shows more red cape than its reference does, so matching averages takes red out of everything else and grey fur goes teal. With it off the collar is grey, the helm is black and not blue, and the underwear is grey. The blue cast noted in steps 29 and 32 was the same fault. `TONE` is now off unless asked for.
- **One cuirass sleeve still ends at mid forearm.** The worn mesh's arm is thinner than the body's there, and the edge rule only reaches three pixels.

**Verdict.** Keep both. The viewer's model is rebuilt with them, 6.0 MB.

## 37. The model in a game engine

**Question.** Every check so far has been three.js or the glTF validator. Does a game engine read the file the way it was meant?

**Setup.** The viewer's `parts.glb` of step 36 in an empty Godot 4.7.2 project, imported headless (`--headless --import`), then a script that loads the scene and lists what it finds.

**Result.**

- **It imports with no errors or warnings.**
- **One skeleton of fifteen bones,** with their names: Hips, Spine, Head, and upper, lower and end bones for each arm and leg.
- **Ten meshes, all skinned to it:** six pieces of body and four items, 79,216 triangles in all.
- **The walk arrives** as an animation named Walk, 0.9 seconds, eight tracks.
- **The hide lists survive.** Godot puts each node's glTF extras in its metadata, so `"hiddenBy": ["Cuirass"]` can be read by a script, as in step 30.

Not checked: how it looks drawn in Godot (this ran with no screen), Godot's humanoid retargeting against these bone names, Unity, and Unreal.

**Verdict.** Keep. The file is a working rigged character in one engine. What it lacks to be an asset is in the survey below: triangle count, unwrap, a standard skeleton, materials.

## 38. A second painter: MV-Adapter

**Question.** The survey named MV-Adapter as the likeliest local step up from Hunyuan3D's paint stage. Does it run on a 12 GB card, and is it better?

**Setup.**

- *Install.* A clone of [MV-Adapter](https://github.com/huanngzh/MV-Adapter) in its own folder and Python 3.12 environment on the same machine, with PyTorch 2.6 and diffusers 0.31, and three downloads: SDXL base in half precision, a fixed VAE, and the adapter `mvadapter_ig2mv_sdxl`. Its requirements list nvdiffrast, which needs a compiler, and CV-CUDA, which is Linux only; the machine is Windows with neither. Both were left out.
- *What replaces them.* The model is guided by six pictures of where the mesh's surface is and which way it faces. [`scripts/mvadapter_paint_turn.py`](../research/scripts/mvadapter_paint_turn.py) draws those itself, with MV-Adapter's own six cameras, and [`scripts/mvadapter_remote.py`](../research/scripts/mvadapter_remote.py) runs only the model. The bake is `bake.py`, as for the other painter.
- *Run.* The body wearing the cuirass, turned to face the front, with the front redraw of step 35 as the reference. 30 steps.

**Result.** The reference, the four views round the figure that the model painted, and one of the guide pictures:

![A reference picture, four views painted by MV-Adapter, and a guide picture](../website/public/research/3d/mvadapter-views.png)

- **It works with our guide pictures.** The painted front view sits on the mesh and follows the reference closely: plates, crest, face.
- **It does not fit.** At 768 pixels it filled all 12 GB and made no progress in 25 minutes. Its option to keep parts of the model off the GPU failed inside its own reference step. At 640 pixels it finished one pass in 689 seconds with 12.9 GB in use, more than the card has, so part of it ran from ordinary memory. Hunyuan3D's paint stage takes 110 seconds for a pass at 768.
- **The sides it invents are wrong,** as with the other painter in step 17: a black head from the side and the back, and the chest's crest repeated on the back. The one-direction-at-a-time trick would discard them, at eight passes and an hour and a half a mesh.

Not done: a bake from its views, its smaller SD2.1 variant, or a comparison against Hunyuan3D on the same finished mesh.

**Verdict.** Drop on this card. Its front view is no better than what step 35 has, and it is six times slower. The scripts stay for a machine with 16 GB or more.

## 39. Sprites drawn larger at the source

**Question.** Steps 32 to 36 enlarge 64 pixel sprites with an image model that redraws each direction alone. The generator that drew the sprites can draw them four times larger itself. Is that a better start?

**Setup.** PixelLab's v3 character at 256 pixels, with step 26's body prompt, underwear included and a T-pose asked for: 9 generations. Then four states of that character, one for each item ("wearing a black steel plate cuirass ...", and so on), which keep the same figure and redraw all eight directions.

**Result.** The bare body, then the cuirass, leg armour, cape and helm:

![Five sets of eight directions at 256 pixels: the body and four worn versions](../website/public/research/3d/sprites-256.png)

- **The figure is an adult,** about seven heads tall, where the 64 pixel one is four. Step 26 put the squat build down to the style; it was the size. At 64 pixels a face needs a quarter of the height.
- **The eight directions agree,** in pose and in detail, because one model drew them together. That is what step 33 could not get from redraws.
- **Each worn version is the same figure in the same pose,** so comparing it with the bare one says where the item is.
- **These are whole figures, not layers.** The items are not separate pictures as in step 26.
- **The helm's horns are short.** A state cannot have a canvas larger than 256 pixels, and the head is near the top.

Not done: meshing, painting or rigging from these.

**Verdict.** Keep. Rebuild from these next.

## 40. Everything rebuilt from the 256 pixel sprites

**Question.** Step 39's sprites are larger, adult in build and agree across directions. Does the chain of steps 35 and 36 give a better character from them?

**Setup.** The same script as step 35, with these differences:

- *Sources.* The five 256 pixel sets of step 39. They are redrawn at 1024 pixels by `redraw.py` with its usual settings; a gentler setting that let the model change little kept the pixel edges. Left to right: the sprite, the gentle redraw, the one used.

![A 256 pixel sprite and two redraws of it](../website/public/research/3d/redraw-256.png)

- *Fitting.* Carving and fitting ran on half-size copies, 128 pixels, to keep the carve to a few seconds. Distances given in sprite pixels were scaled to match: items sit 1.5 above the skin, skin counts as covered within 3, and an item's edge may move 7.
- *Masks.* There are no item layers here, only worn figures. A pixel is the item where the worn sprite differs from the bare one by more than 70 across red, green and blue, tidied and with specks under 150 pixels dropped. Step 36's edge rule does the rest.
- *Joints.* PixelLab's skeleton estimate on the eight bare sprites, 0.8 generations.

About two hours of GPU time, unattended.

**Result.** The assembled character with hidden skin left out, and the bare body:

![The rebuilt knight and the bare body from five directions](../website/public/research/3d/rebuilt-256.png)

The four items on their own:

![The cuirass, leg armour, cape and helm cut from their worn meshes](../website/public/research/3d/rebuilt-256-items.png)

- **The body is an adult.** Long legs, a small head, shoulders, a face, with muscle painted and shaped. Compare step 36's.
- **The armour reads as armour:** separate plates on the legs, a shaped helm with a visor, trim that follows edges.
- **The fits are no worse:** the meshes match the sprites' outlines 81 to 86%.
- **The masks needed the edge rule.** It took in 1,000 to 4,300 triangles an item, most on the cape, and left out up to 900 of skin.
- **Dark streaks run along the tops of the arms** on the bare body, and the cape has a few pinholes.
- **In the viewer it loads, walks and its items switch off.** Seen there with the cuirass and helm off: the head, chest and arms come back whole.
- **In Godot 4.7.2 it imports as before:** fifteen bones, ten skinned meshes, 79,819 triangles, the walk.
- **The file is 6.3 MB** with 512 pixel textures, 11.4 MB with 1024. It passes the glTF validator with no errors or warnings.

Not checked: the walk from every side, whether items clip at the extremes of the stride, the pixel look on this model.

**Verdict.** Keep as the viewer's model. The look is no longer the weakest part. What separates this from an asset is now in the survey: triangle count, unwrap, skeleton, materials.

## 41. A light mesh with the paint and relief baked on

**Question.** The survey's first gap is triangle count: step 40's model is about 30,000 triangles a part, spread evenly, in an unwrap of hundreds of pieces. How much can go without the picture changing?

**Setup.** [`scripts/thin.py`](../research/scripts/thin.py), on the body and on each cut item of step 40.

- *Thin.* The mesh's split vertices are joined, then it is reduced to a target count with quadric decimation: 6,000 triangles for the body, 3,000 for the cuirass and the leg armour, 2,500 for the cape, 2,000 for the helm.
- *Unwrap.* A fresh xatlas unwrap of the light mesh, told to grow each piece four times as readily as its default, with six pixels of padding.
- *Bake.* Every texel of the light mesh takes the colour of the nearest point on the dense mesh that faces the same way, from three million points sampled on it. Facing the same way keeps the two sides of the cape from swapping.
- *Relief.* The same lookup gives the dense mesh's smooth normal, stored against the light mesh's own normal and tangent as a normal map in the OpenGL convention glTF asks for. `rig.py` writes matching tangents, and now keeps the normals a part arrives with.
- *File.* `rig.py` gained `JPEG`: textures as JPEG at a given quality. Colour is 1024 pixels for the body and 512 for items, normal maps 512, quality 90.

The body's colour texture and normal map after thinning:

![The light body's colour texture and its normal map](../website/public/research/3d/thin-maps.png)

**Result.** The assembled character, dense above and light below, drawn unlit:

![The dense and the light model from five directions](../website/public/research/3d/thin-dense-vs-light.png)

| | Dense (step 40) | Light |
|---|---|---|
| Triangles, body and four items | 79,819 | 16,496 |
| Unwrap pieces, body | not counted | 157 |
| File | 6.3 MB | 2.1 MB |

- **The two are hard to tell apart** in an unlit render. The fur collar is a little softer.
- **It takes seconds:** about seven for the body.
- **In the viewer it loads and walks,** lit with the normal map. In Godot 4.7.2 it imports with the same skeleton and walk.
- **It passes the glTF validator** with no errors or warnings.
- **The normal map is nearly flat,** with facet-sized speckle. The dense mesh has little relief the light one lacks, and what it has is partly the generator's noise. A real gain here needs relief from somewhere else, such as a normal map drawn from the paint.
- **The unwrap is still many pieces,** 44 to 224 a part. It is automatic, and no artist would call it clean.

Not checked: the lit look beside the dense model, how the light mesh bends at elbows and knees compared with the dense one, and a hand-made or quad retopology.

**Verdict.** Keep. A fifth of the triangles and a third of the file for no visible cost.

## 42. A standard humanoid skeleton

**Question.** The skeleton of step 16 has fifteen bones. Engines put stock animations on a character by matching its bones to a standard humanoid. Is ours one?

**Setup.** `rig.py` now builds twenty-one bones unless told `BONES=15`. The six added are the ones a standard humanoid has besides: Chest, Neck, a Shoulder for each arm and Toes for each foot. They are placed from the joints already known: the spine is split in three, the neck runs from the neck joint to under the ears, each shoulder from near the neck to the shoulder joint, and the toes from the ball of the foot forward. The names are those Unity's and Godot's humanoid profiles use. Weights come as before, measured through the mesh.

The check is Godot's own `SkeletonProfileHumanoid`, which lists 56 bones (fingers, eyes and jaw among them) and marks which are required. A script asks whether each is in the imported skeleton by name, and whether it hangs from the parent the profile gives.

**Result.**

- **All seventeen bones the profile requires are found,** by name, with no mapping written.
- **Four optional ones are found too:** Chest, Neck and both Toes.
- **Every bone found hangs from the parent the profile expects.**
- **The walk still plays.** The thinned body on the new skeleton:

![The light body walking on the twenty-one bone skeleton](../website/public/research/3d/humanoid-walk.png)

Not done: putting a stock animation on it. That needs an animation library to test with, which means a download, and Godot's retargeting also resets each bone's rest direction, which was not run. Fingers, eyes and jaw are not built. Unity and Unreal were not tried.

**Verdict.** Keep. The names and the tree are right for one engine's profile. Whether a stock animation looks right on it is the next test.

## 43. Stock animations on the skeleton

**Question.** Step 42 says the skeleton has the right names. Does an animation made for another character look right on it?

**Setup.**

- *The library.* [Quaternius's Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html), standard edition: 43 animations on a 65 bone humanoid named as Unreal's mannequin is (`pelvis`, `spine_01`, `upperarm_l`), as one .glb. CC0. A 15 MB download from itch.io. It is not in this repository.
- *The problem.* The two skeletons differ in bone count, proportions and rest pose, and the library's bones carry rotations at rest where ours carry none. Keyframes cannot be copied.
- *The method.* [`scripts/retarget.py`](../research/scripts/retarget.py) pairs our 21 bones with 21 of the library's. For each bone at each moment it takes the library bone's turn away from its rest pose, in world space, and gives it to our bone. Before that, each of our limbs is turned to point the way the library's points at rest, so the two rest poses need not agree. The hips also travel, by the library's hip movement scaled to our hip height (1.023 here). Sampled 30 times a second.
- *The viewer* gained a picker for whatever animations a file carries.

**Result.** Idle, walk, jog, sword attack and death, in the viewer:

![The knight in five stock animations](../website/public/research/3d/stock-animations.png)

- **They read as what they are.** The idle stands with arms at the sides, the walk and jog stride, the attack lunges, the death falls and lies on the ground.
- **Eleven animations add 220 KB** to the file, which is 2.3 MB with them.
- **The armour and cape follow** through all of them, since items are skinned to the same bones.
- **It passes the glTF validator** with no errors or warnings.

Not checked: feet sliding on the ground, hands (the character has no finger bones, so a grip is a flat hand), the cape through a roll, the animations in Godot, and the other 32 in the library.

**Verdict.** Keep. A standard skeleton plus a retarget gives the character a library of motion for nothing.

## 44. Views from above and below

**Question.** Since step 23 the body has had dark smears along the tops of its outstretched arms, and dark patches on shoulders and the top of the head. Why, and can the painter fix them?

**Setup.**

- *The cause.* Every camera in a paint pass is level with the character. Nothing looks down on the top of a level arm, so its texels are seen only edge-on, where a painted view shows the figure's dark outline.
- *The fix.* Each pass paints six views and three were kept (the sprite's, and one to each side). Two of the spare cameras now look from 45 degrees above and below the sprite's direction: `TOP=45` in `hunyuan3d_paint_turn.py`, five views kept a pass, forty a mesh. The paint node takes only 20, 45 or 90 degrees; 40 fails.
- *The bake.* `bake.py` reads each view's tilt. It tries the tilt both ways up when it places a view, as it already does for mirroring, and keeps the one that matches the node's own render.

A pass for the south sprite: the level view, the view from above, the view from below, and the node's render of the mesh from above.

![A level painted view, one from above, one from below, and the mesh seen from above](../website/public/research/3d/top-views-painted.png)

**Result.** The body seen from 35 degrees above, before and after:

![The body from above with level views only, and with views from above and below](../website/public/research/3d/top-views-body.png)

The assembled character from the same height, before and after:

![The assembled knight from above, before and after](../website/public/research/3d/top-views-assembled.png)

- **The smears are gone** from the arms and shoulders, and the top of the head is skin.
- **The model invents the top views plausibly:** the reference shows a front, and it paints the same figure seen from above.
- **Time is unchanged,** about 110 seconds a direction, since the six views were being painted anyway.
- **The viewer's model is rebuilt from these textures,** thinned and animated as in steps 41 to 43: 16,498 triangles, 2.3 MB, valid, and it imports into Godot 4.7.2 with twelve animations.
- **Godot found a clash.** It drops a trailing `_Loop` from animation names, so the library's `Walk_Loop` collided with our own `Walk`. `retarget.py` now renames ours `First_Walk`.

Not checked: the rebuilt model in the browser, and undersides such as the soles and under the chin.

**Verdict.** Keep. `TOP=45` should be the usual setting.

## 45. A cape that swings

**Question.** The cape has been one stiff sheet since step 24, turning with the spine. Can it hang and swing like cloth, in a file any engine can play?

**Setup.**

- *Bones.* `CHAINS="Cape=3x4"` in `rig.py` gives the item called Cape three columns of four links, named `Cape1_1` to `Cape3_4`, each column hung from the chest. The top fifth of the item, the fur collar, stays on the body. Below it each vertex follows the two links it lies between in the two columns it lies between, so the sheet bends smoothly down and across with at most four bones a vertex.
- *Motion.* Engines swing such bones live with spring bones, each its own way, and glTF has no standard for it. [`scripts/sway.py`](../research/scripts/sway.py) does it once and stores the answer: for every animation in the file it simulates each chain as a string of points and writes the result as rotation keys for the cape bones.
- *The simulation.* The top point is pinned to the chest. The rest fall under gravity, keep nine tenths of their speed each step, keep their distance from the point above, are pulled slightly towards where they hang at rest, and are pushed out of capsules round the legs and the trunk. Four steps a frame at thirty frames a second. A looping animation is run three times round and the last pass kept, so the end meets the start.

**Result.** In the viewer: idle, two frames of the sprint from the side, and the roll.

![The cape hanging in an idle, streaming behind a sprint, and falling during a roll](../website/public/research/3d/cape-sway.png)

| Animation | How far the cape's hem swings from rest |
|---|---|
| Idle, sword idle, walk | 4 to 6 cm |
| First walk | 13 cm |
| Sprint, jog | 38 and 42 cm |
| Roll, death | 48 and 49 cm |
| Jump start | 71 cm |
| Sword attack | 92 cm |

- **It reads as cloth.** The cape trails a sprint, settles in an idle, and hangs towards the ground through a roll.
- **The legs no longer pass through it** in the frames looked at; the capsules hold it off them.
- **It costs 12 bones and about 130 KB** of keys over twelve animations. The file is 2.5 MB and passes the glTF validator with no errors or warnings.
- **Godot 4.7.2 imports it:** 33 bones, twelve animations, and the humanoid profile still finds its seventeen.

Not checked: the cape against the arms, which have no capsules; every frame of every animation; and how a live spring bone set-up in an engine compares. The stiffness and damping were set by eye in two tries.

**Verdict.** Keep. Baking the swing into the animations is the portable choice; an engine's own cloth can replace it where wanted, since the bones are there.

## 46. The same items on a second body

**Question.** Parts are separate so that they can be reused. Every item so far has been worn only by the body it was cut on. Does one fit another body?

**Setup.**

- *The body.* PixelLab's v3 character at 256 pixels: "heavyset and broad with a barrel chest, a thick waist, wide shoulders, thick strong arms and thick legs". It came back with the arms down, which fuses them to the trunk when meshed, so a state of it was asked for in a T-pose and used. 9 generations, then 10 to 25 for the state (not read back), and 1.6 for joints, 0.8 of them wasted on the arms-down drawing.

![The second body in eight directions, in a T-pose](../website/public/research/3d/second-body-sprites.png)

- *His mesh.* Redrawn, meshed, painted with views from above and below, thinned and rigged as in steps 40 to 44. Nothing was drawn or meshed for him but his own body.
- *The items.* The thinned cuirass, leg armour, cape and helm of step 44, made on the first body. [`scripts/refit.py`](../research/scripts/refit.py) describes each point of an item against the first body's bones, as how far along a bone and how far out from it, and puts it the same share of the way along the second body's bone. `rig.py` then fits the item to his skin and gives it his weights, as for any item.
- *How far out.* The second body's limbs are measured as thicker than the first's, by the typical distance of each bone's own vertices from its line: 3.0 sprite pixels at a typical bone.

**Result.** The first try scaled each point's distance from the bone by the ratio of the two bodies' thickness, about two here:

![The items scaled by the ratio of thickness: a collar blown up, a torn cape, bent horns](../website/public/research/3d/second-body-scaled.png)

- **Scaling by ratio fails for anything that stands off the body.** The fur collar, already well clear of the shoulders, doubled in size. The cape tore as it was pushed back to the skin, and the helm's horns bent, pulled at by the neck and shoulder bones.

The second try moves each point out by the difference in thickness, so an item keeps its clearance from the skin, and describes the helm against the head alone and the cape against the trunk alone (`ONLY`). The bare body above, dressed below:

![The second body bare, and wearing the first body's four items](../website/public/research/3d/second-body.png)

- **All four items fit.** The cuirass spans the barrel chest, the leg armour wraps the thick legs, the collar sits on the shoulders at its own size, and the helm keeps its shape.
- **The items moved 6 to 13 sprite pixels** typically to get there, on a figure about 117 tall.
- **It animates like the first:** the same twelve motions, the cape on its chains. In the viewer it loads, walks, and is the "Second body" model.
- **It is one file of 2.4 MB,** 16,495 triangles, valid, and imports into Godot 4.7.2 with 33 bones.
- **The cuirass is stretched,** not remade: its trim lines are wider apart on him, and the crest is larger.
- **The forearm guards stop short of the wrists,** as on the first body.

Not checked: a body that differs in height more than build, a woman's build, a child's, and whether hidden skin is right under every item on him.

**Verdict.** Keep. One set of items, two bodies, for the cost of one more body. This is the claim the design rests on, and it holds for a body this different.

## 47. Finger bones, and a sword in the hand

**Question.** The skeleton stopped at the hand, so a grip was a flat hand and nothing could be held (steps 42 and 43). Do the hands of a mesh from 256 pixel sprites carry enough to close round a handle, and can a separately made item be put in one?

**Setup.**

- *What the mesh has.* The first body's hand is a mitten: the four fingers as one slab, and a thumb standing apart. That matches what the [skeletons guide](./SKELETONS.md) measured on the sprites: a 256 pixel hand carries a wrist, knuckles, a fingertip and a thumb, and no more.
- *Finding the bones.* `rig.py` measures each hand on the filled mesh. Going back from the fingertips the hand is one piece, then two once the thumb's tip is passed, then one again at the web between thumb and fingers. The web is taken as 58% of the hand's length back from the fingertips, which gives the wrist, the knuckles at 56% and three finger joints. The thumb's line runs from near the wrist to its tip.
- *The bones.* Three for the thumb and three for the fingers' one chain, a hand, under the names Godot's and Unity's humanoid profiles give the thumb and the middle finger. A seventh, `LeftGrip` or `RightGrip`, carries no skin: it marks where a grip goes, just under the palm.
- *Motion.* The animation library poses its fingers: fists in the walk and idle, a closed right hand and an open left in the sword animations (read from its file). `retarget.py` now turns a hand as a whole so that its palm faces the way the library's does, then carries the library's thumb and middle finger over.
- *The sword.* One PixelLab object, a longsword upright in eight directions at 128 pixels, for 25 generations. Its front, left, back and right went to Hunyuan3D-2mv (six and a half minutes), the mesh was coloured from the eight sprites and thinned from 29,999 triangles to 1,499.

![A longsword in eight directions](../website/public/research/3d/sword-sprites.png)

- *Holding it.* A new kind of item in `rig.py`, `Sword=sword.glb:RightHand:held`. The item's longest line is laid across the palm, leaving on the thumb's side. Its grip, half way between one end and the guard (the widest place near an end), goes to the hand's grip point. It is made half the body's height long and follows the hand bone alone.

**Result.** The left hand at rest with its bones, from above and from the front, and closed by the library's idle:

![A hand with a thumb chain and a finger chain, and the same hand closed into a fist](../website/public/research/3d/hand-bones.png)

- **The hands were found** on the first body: 9.9 and 10.8 sprite pixels long, on a figure 113 tall. The wrist joint estimated on the sprites sat in the palm, and moved 2.0 and 2.7 pixels back.
- **A fist closes** with a tunnel between fingers and thumb, which is where a handle goes.
- **The sword is held.** In the library's sword attack the knight lunges with the blade forward, the grip in his closed right hand between pommel and guard:

![The dressed knight lunging with the sword, and the hand on the grip](../website/public/research/3d/held-sword.png)

- **It is one file of 2.6 MB,** 17,997 triangles, valid, with the sword as a sixth separate mesh. The viewer loads it, plays the sword attack, and lists the sword among the things worn.
- **Godot 4.7.2 imports it** with 47 bones: 21 for the body, 14 for the hands, 12 for the cape. Its humanoid profile finds the twelve finger bones by name, as optional bones.
- **The 64 pixel body gets none.** Its hand has no thumb apart, and `rig.py` says so and leaves the skeleton as it was.
- **Nor does the second body** of step 46: PixelLab drew his hands as closed fists. A held item needs the finger bones' measurements, so he cannot be given the sword yet.
- **`refit.py` now uses the bones two bodies share,** since one may have finger bones and the other not. The helm it gives the second body is unchanged; the cuirass differs by 3 pixels at most, at the wrists that moved.

Flaws:

- **The sword's colour has black patches,** where the sprites' outlines were projected onto it.
- **The grip is thicker than the fist's tunnel** and the pommel is large: the sword is scaled by its length alone.
- **The two hands differ in length** by a pixel, since each is measured on its own.
- **The closed hand is coarse.** A hand is about fifty triangles a bone after thinning, so knuckles crease unevenly.
- **The fingers stay closed when the sword is taken off** in the viewer: the grip is part of each animation.

Not checked: the left hand holding something, two-handed grips, a shield, the held sword in Godot's own renderer, and whether Godot's or Unity's retargeting drives a one-chain hand sensibly.

**Verdict.** Keep, for the painted path. A thumb and one chain is what the mesh shows, and it is enough to hold a sword through a stock attack.

## 48. A sword in a hand drawn as a fist

**Question.** Step 47 left the second body without a sword: his hands are closed fists, with no thumb to find and so no finger bones. Does a fist need finger bones to hold something?

**Setup.**

- *What a fist is on the mesh.* Along the arm, the second body's cross-section shrinks towards the wrist, grows into a ball 13.8 sprite pixels across and 10 thick, and ends. The wrist joint estimated on the sprites sat in the middle of that ball.
- *Finding it.* When `rig.py` finds no thumb, it now walks back from the end of the hand through slices one pixel thick: to the thickest slice, then on to the narrowest before the forearm widens again. That narrowest slice is the wrist. A ball at least 1.4 times the wrist's cross-section counts as a fist; anything less gets nothing, as before.
- *The grip.* The middle of the fist, with the handle running through it from back to front and the blade leaving to the front. That is the thumb's side of a fist held out palm down, which is how the first body's open hands were drawn and what the animation library expects. The fist's wider side is used for the handle's line where it runs front to back (it does on this body, within 12 degrees); a fist too round to have one takes straight ahead.
- *The guard.* A handle half way through a fist 13.8 pixels across would bury the guard, so a held item in a fist is slid along its handle until the guard clears the fist's side.
- *Bones.* `LeftGrip` and `RightGrip` only. There are no finger bones, and the fist is skinned to the hand bone as drawn.
- *Nothing new was generated.* The sword, the body and the refitted items are those of steps 46 and 47.

**Result.** The second body at rest, in the library's sword idle, and in its sword attack:

![The heavy armoured man with a sword through his right fist, at rest, on guard and lunging](../website/public/research/3d/fist-sword.png)

- **Both fists were found:** 10.5 and 9.5 sprite pixels long and 13.8 and 13.7 across. The wrists moved 7.5 and 6.7 pixels back along the arm, out of the fist, so the hand now bends at the wrist and not through the knuckles.
- **He holds the sword** through the same eleven library animations, pommel behind the fist and guard in front of it. The handle is inside the fist's mesh, so its thickness does not show.
- **The first body is unchanged:** its hands measure 9.9 and 10.8 pixels as in step 47.
- **One file of 2.6 MB,** 17,994 triangles, valid, 35 bones (21 for the body, 2 grips, 12 for the cape). Godot 4.7.2 imports it with no errors and finds every bone its humanoid profile requires.
- **The 64 pixel body's hands count as fists too:** 7.5 pixels long and 6.8 across. Its bare body holds the sword through the sword idle, though the blade points lower than on the other two. The site's 64 pixel model was not rebuilt.

Flaws:

- **A fist cannot open.** He cannot let go, and with the sword taken off he keeps his fists, which is at least how he was drawn.
- **Which way the fist faces is assumed.** Palm down, thumb to the front. A fist drawn thumb up would get the handle the wrong way through.
- **The handle passes through solid mesh.** Nothing shows from outside, but a cut-away or a transparent body would show it.
- **The sword is small on him.** It is half his height, like the first body's, and he is short and very broad.

Not checked: the left fist holding something, the item fit at the moved wrists beyond the views above, and the sword on the dressed 64 pixel model.

**Verdict.** Keep. A hand that is already closed needs a wrist and a grip point, not finger bones.

## 49. The left hand, and a shield

**Question.** Steps 47 and 48 put a sword in the right hand of both bodies. Does the same work on the left, and can the other arm carry a shield?

**Setup.**

- *The left hand.* Nothing new: `Sword=sword.glb:LeftHand:held` on each bare body.
- *The shield.* One PixelLab object, a heater shield upright with its face to the viewer in eight directions at 128 pixels, for 25 generations. Its front, left, back and right went to Hunyuan3D-2mv (eight and a half minutes), the mesh was coloured from the eight sprites and thinned from 29,999 triangles to 1,500.

![A black and gold heater shield in eight directions, its wooden back with two straps](../website/public/research/3d/shield-sprites.png)

- *Carrying it.* A shield is not gripped like a sword: it is strapped to the forearm. A new kind of item in `rig.py`, `Shield=shield.glb:LeftLowerArm:strapped`. The item's thinnest direction is its face's normal. That goes to the back of the forearm, the side away from the palm the hand measurement found. Its top goes towards the elbow, so it is upright when the arm hangs. Its back is set 0.4 sprite pixels off the arm's surface, 60% of the way from elbow to wrist. It is made 0.36 of the body's height tall and follows the forearm bone alone.
- *Which way is its front.* Unlike the sword, a shield has a front and a top that its shape does not give away, so the file has to keep the frame of its sprites: upright, face to the viewer. `texture.py` fits the mesh to the sprites and leaves it in that frame.

**Result.**

- **The left hand holds the sword** on both bodies, the first with its finger bones and the second in its fist, with no change to the script:

![Each bare body with the sword in its left hand](../website/public/research/3d/left-hand-sword.png)

- **The shield stands upright on the left forearm** of both, face outward, through the sword idle, the walk and the sword attack (first body above, second below):

![Both armoured bodies with sword and shield: on guard, walking from the front and the side, and lunging](../website/public/research/3d/sword-and-shield.png)

- **Each file is valid:** 19,497 triangles and 2.8 MB for the first body, 19,494 and 2.7 MB for the second, with the shield as a sixth separate item. Godot 4.7.2 imports both with no errors. The viewer lists the shield among the things worn on both.
- **The shield's paint is cleaner than the sword's.** Its broad flat faces take the sprites' colours well; the silhouette matches the sprites 92%.

Flaws:

- **The shield is carried, not used.** The library has no block or shield motions, so the left arm does what it does with nothing on it.
- **A sword in the left hand cuts through the thigh in the idle,** for the same reason: every sword motion in the library is right-handed.
- **The left hand does not grip anything.** The shield hangs from the forearm, and the straps on its back are paint.

Not checked: whether the shield passes through the cape or the body in motions that bring the arm across (nothing keeps a rigid item out of other meshes), a shield on the right arm, a round shield or a buckler held in the fist, the shield on the 64 pixel body, and both items in Godot's own renderer.

**Verdict.** Keep. Two kinds of rigid item now cover the common cases: `held` for what a hand closes round, `strapped` for what an arm carries.

## 50. Two hands on one grip

**Question.** Steps 47 to 49 hold things in one hand. A greatsword needs two. The animation library has no two-handed motions, so can its one-handed ones be made to carry a second hand?

**Setup.**

- *The greatsword.* One PixelLab object in eight directions at 128 pixels, for 25 generations, asked for with a grip long enough for two hands. Meshed by Hunyuan3D-2mv in a little over two minutes, coloured from the sprites (89.5% silhouette match) and thinned from 30,000 triangles to 1,499.

![A greatsword in eight directions](../website/public/research/3d/greatsword-sprites.png)

- *Where the hands go.* A new kind of item in `rig.py`, `Greatsword=greatsword.glb:RightHand:two-handed`. The hand named leads and sits just under the guard. The other goes under it, towards the pommel, by the breadth of the two hands: 70% of an open hand's length, or the width of a fist. That place is written into the file as a bone with no skin, `RightGrip2`, on the leading hand. The sword was made 0.8 of the body's height long.
- *What the file now carries.* Each grip bone's node has the hand's grip line and palm direction in its `extras`, and `RightGrip2` has the handle's line and the name of the hand that belongs there, so a later step or an engine needs nothing else.
- *Moving the other hand.* A new script, [`scripts/offhand.py`](../research/scripts/offhand.py), run on the animated file. At each of thirty moments a second it turns the other hand so its grip lies along the handle, thumb towards the guard, tries 48 rolls round the handle and keeps the one that bends the wrist least without jumping from the moment before. Each arm is then a triangle of two fixed sides from shoulder to wrist.
- *The other hand's fingers* copy the leading hand's, mirrored, where both have finger bones.

**Result.**

- **Moving one arm is not enough.** The first version left the leading hand where the library put it. The other hand reached the grip in none of the twelve motions, falling 23 to 38 centimetres short: a one-handed sword is carried at the hip, further from the other shoulder than an arm is long.
- **Pulling the grip to wherever both arms could reach** put the sword behind the back, arms crossed behind the body, in the sword idle.
- **What works:** the whole grip is pulled the least distance that lets both arms reach it with both hands at least 22 centimetres in front of the spine, and each elbow is pointed down, outwards and a little back instead of where the one-handed motion had it. Sword idle, walk and sword attack, the first body above and the second below:

![Both armoured bodies holding a greatsword in two hands: on guard from the front and side, walking, and lunging](../website/public/research/3d/two-hands.png)

- **The first body's other hand is on the grip at every moment of all twelve motions.** The grip is pulled 43 to 67 centimetres from where the one-handed motion had it.
- **The second body's fists overlap a little:** the handle is 28.3 sprite pixels and his two fists need 29. His hand is on the grip throughout ten motions, falls up to 1.2 centimetres short in 4% of the sword attack, and up to 7 centimetres short through most of the dance.
- **The file is valid:** 17,997 triangles and 2.7 MB for the first body, 48 bones. Godot 4.7.2 imports it with no errors. The viewer has it as "Two hands on a greatsword".

Flaws:

- **Wrists bend too far in some motions.** On the first body the other wrist stays within 15 degrees in the sword idle and 50 in the walk and the attack, but reaches about 100 in the jog and sprint and 129 in the roll. A wrist manages about 80.
- **The motions are still one-handed ones.** The body's weight, the swing and the footwork are those of a light sword; only the arms were changed.
- **Nothing keeps the blade out of the body, the cape or the ground.**
- **The old keys stay in the file** as unused data, which the validator notes and which adds a few tens of kilobytes.

Not checked: the left hand leading, a staff or a spear, the two-handed file in Godot's own renderer, and how the pulled grip looks through the whole of each motion beyond the three shown.

**Verdict.** Keep as a fallback that works in any engine. An engine with an arm solver should use the `RightGrip2` bone live, and real two-handed animations would beat both.

## 51. Motions made for two hands

**Question.** Step 50 bent one-handed motions until the second hand reached the grip, and the wrists paid for it. Its verdict was that real two-handed motions would be better. Where do they come from?

**Looked for first.** A free library that has them. [Quaternius's second animation library](https://quaternius.com/packs/universalanimationlibrary2.html) (CC0) lists sword combos, shield idles, farming and parkour in its free edition, and no two-handed weapon. The greatsword packs a search turned up are paid and made for one engine's skeleton. Nothing was downloaded.

**Setup.** A new script, [`scripts/wield.py`](../research/scripts/wield.py), makes them. It goes the other way round from step 50: the path of the sword is written down, and both arms are solved to it.

- *What is written.* For each motion, a few moments: where the grip is and which way the handle points, in a frame that rides on the chest and is measured in arm lengths, and how far the spine leans. The script draws a smooth curve through them.
- *What is taken.* The legs, hips, spine and head of a stock motion the file already carries: the idle, the walk and the jog.
- *What is solved.* At thirty moments a second the leading hand goes on the grip and the other on the `RightGrip2` bone of step 50. Each hand may still roll round the handle. The leading hand's roll is chosen for a straight wrist and a blade whose edge, not its flat, faces the way it is swung; the other's for a straight wrist. A loop is solved twice round so that it ends on the roll it starts with. If an arm cannot reach, the grip is pulled in by what it fell short.
- *The four motions.* `Great_Idle`, a guard with the blade upright before the body; `Great_Walk` and `Great_Jog`, the same guard carried; `Great_Attack`, 1.4 seconds: the sword goes up over the right shoulder, cuts down to the front with the trunk leaning 24 degrees into it, and returns.
- *How the poses were picked.* Each key pose was tried against a few dozen neighbours on both bodies, and the one with the straightest wrists kept.

**Result.**

![Both armoured bodies with a greatsword in two hands: on guard, walking, the sword raised over the shoulder, and the cut landed](../website/public/research/3d/two-handed-motions.png)

How far a wrist bends at most, in degrees. Step 50's figures are for the motion the new one replaces, as measured then.

| | Step 50, first body | First body | Second body |
|---|---|---|---|
| Idle on guard | 15 (sword idle) | 28 | 56 |
| Walk | 50 | 29 | 58 |
| Jog | about 100 | 52 | 56 |
| Attack | 50 | 42 | 69 |

- **Both hands are on the grip throughout,** on both bodies. The second body's grip is pulled in 5 centimetres in the guard and 10 in the jog, because his chest is broad for his arms; his hand is 2 millimetres short at one point of the attack.
- **The loops close:** the arms at the last moment are within 4 degrees of the first.
- **The files are valid.** The first body's is 17,997 triangles and 2.9 MB with sixteen motions; the four new ones add about 200 KB. Godot 4.7.2 imports both bodies' files with no errors and finds the 17 bones its humanoid profile requires. The viewer's greatsword model now opens on the new walk.

Three things were learned on the way:

- **A closed hand cannot lay a handle along its forearm.** The first attack ended with the arms out and the blade level, and the leading wrist bent 90 degrees. The cut now lands with the blade rising from the hands, and wrists stay within 42.
- **This body cannot raise a sword over its head.** Its arms are short for its head, so hands "above the head" were at its chin and the blade went through the helm. The sword is raised over the leading shoulder instead, which also gave straighter wrists (16 degrees on the first body, against 33 or more before the brow).
- **A fist's shape does not say how it holds a handle.** Step 48 took the grip's line from the fist's widest side. On the second body that line leaned 25 degrees towards the elbow, the wrong way, and the motions bent his wrist 60 to 90 degrees. `rig.py` now sets a fist's hold 80 degrees to the forearm, thumb end away from the elbow (`FIST_LEAN`). His wrists came down to the figures above, and step 50's bent motions improved with it: the sword attack from 1.2 centimetres short to 0.8, the dance from 7 to 4. His sword-and-shield model on the site is rebuilt with the new hold; his sword sits a little flatter in the idle.

Flaws:

- **The blade is not edge-on.** It sits 25 to 30 degrees off its edge on the first body and 40 to 50 on the second, because a straight wrist and a true edge pull against each other and the script splits the difference (`EDGE`).
- **The second body's raised blade passes through the fur on his shoulder,** and nothing keeps the blade out of the body, the cape or the ground on either.
- **Only the arms and the lean of the spine were made.** The attack stands on the idle's feet: there is no step, no turn of the hips, no weight. The jog carries the guard; it has no carry of its own.
- **Four motions.** Death, the roll, the hit and the jump are still step 50's bent ones.
- **The poses were picked on these two bodies.** A body with other proportions gets the pull-in and whatever wrists follow.

Not checked: how the motions read in play in an engine, the whole of each motion beyond the four moments pictured and the script's own figures, the left hand leading, and a staff or spear.

**Verdict.** Keep. For a motion that exists in this form, it beats bending a one-handed one: the wrists stay inside what a wrist does and the sword goes where it was told. It is not a replacement for an animator or for captured motion.

## 52. Footwork for the two-handed attack

**Question.** Step 51's attack moved the arms and leaned the spine over the idle's feet. Can the same written-down approach give it a step and a turn of the hips?

**Setup.** `wield.py` takes one more list for a motion, `feet`: at a few moments, how far the hips move forward and down, how far they turn towards the leading side, and how far the foot on the other hand's side steps forward and lifts, in leg lengths. The hips are moved and turned first, so the chest, and the sword that rides on it, turn with them. Both legs are then solved again from hip to ankle, knees forward. The standing foot keeps the place and facing the idle gave it; the stepping foot keeps its facing.

For `Great_Attack`: the hips turn 18 degrees towards the raised sword and shift back, the left foot lifts, and as the cut lands it comes down 0.45 leg lengths ahead with the hips forward, 0.14 leg lengths lower and turned 14 degrees the other way. Then everything returns.

**Result.**

![The two-handed attack with a step on both bodies: wound up, the foot leaving the ground, and the cut landed in a lunge](../website/public/research/3d/attack-footwork.png)

- **Both feet reach their places at every moment** on both bodies, and the standing foot does not slide, since it is put where the idle had it.
- **The arms are as they were:** wrists within 42 degrees on the first body and 69 on the second, both hands on the grip.
- **The files are valid** and Godot 4.7.2 imports both with no errors and finds its 17 required bones. The first body's file is the same size, 2.9 MB.

Flaws:

- **A first try left a foot 2 centimetres short at rest.** The leg solver had the arms' limit of 97% of full reach, and a standing leg is straighter than that. Legs now get their full length.
- **The stepping foot's toe does not roll.** It lifts and lands flat.
- **The step is in place.** The character returns to where it stood; a game that wants the attack to carry it forward needs root motion, which is not written.
- **The numbers were set once and looked at,** not searched as the arm poses were.

Not checked: the motion in play in an engine or in the site's viewer, and the idle, walk and jog, which have no footwork of their own beyond the stock legs.

**Verdict.** Keep. The attack reads as a lunge now, and the `feet` list is there for other motions.

## 53. A spear, hands apart

**Question.** The greatsword of steps 50 to 52 has both hands together under a guard. A spear or staff has no guard and the hands go apart on the shaft. Does the same approach carry it?

**Setup.**

- *The spear.* One PixelLab object in eight directions at 128 pixels. The first try (25 generations) came back short, with a head half its length. A second (25 more) that asked for a pole taking up almost the whole height, with a small tip, gave a long spear with a ribbon under the head. It was meshed by Hunyuan3D-2mv in 145 seconds, coloured from the sprites and thinned from 30,000 triangles to 1,499.

![A spear in eight directions](../website/public/research/3d/spear-sprites.png)

- *Where the hands go.* Two settings for `rig.py`'s `two-handed` kind. `GRIP_AT` says where the leading hand's middle is, as a share of the item's length from its butt, and `GRIP_APART` how far below it the other hand is. Here 0.45 and 0.2, on a spear 1.1 times the body's height: the hands are about 40 centimetres apart. The spear is given to the left hand, `Spear=spear.glb:LeftHand:two-handed`, so the left hand is forward and the right is at the rear, as a right-hander holds one. That is also the first time the left hand has led.
- *The motions.* `wield.py` with `SET=spear` makes `Spear_Idle`, `Spear_Walk` and `Spear_Jog`, the spear level with its butt outside the right hip and its point ahead, and `Spear_Thrust`, 1.2 seconds: drawn back, then driven out with a step of the left foot, the hips 0.15 leg lengths lower and the trunk leaning 17 degrees. A shaft has no edge, so the blade term is off.

**Result.**

![Both armoured bodies with a spear: on guard, walking, drawn back, and the thrust landed in a lunge](../website/public/research/3d/spear.png)

- **Both hands are on the shaft and both feet reach, at every moment of the four motions, on both bodies,** with no pull-in needed.
- **First body:** the forward wrist bends at most 28 degrees and the rear one 48 to 51, and 72 in the thrust.
- **Second body:** the forward wrist at most 41, the rear one 82 to 86 in all four. That is past what a wrist does.
- **The files are valid.** The first body's is 17,997 triangles and 2.9 MB with sixteen motions. Godot 4.7.2 imports both with no errors and finds its 17 required bones. The viewer has the first body as "Two hands on a spear" and opens it on the spear walk.

Three things went wrong on the way:

- **The spear went on backwards.** `rig.py` takes an item's widest place for a sword's guard and puts that end in the hand. A spear's widest place is its head. With `GRIP_AT` set the item is now turned the other way.
- **The butt went through the body.** The first guard had the rear hand 15 centimetres from the middle of the body. The shaft now angles across so that the rear hand is outside the hip.
- **The rear wrist bent 100 degrees.** With its elbow down, as every arm here has had it, the rear forearm lies along the shaft. A motion can now say where the other arm's elbow goes (`elbow`), and the spear motions put it back and up, so the forearm hangs to the shaft as on a cue. That brought the first body's rear wrist to the figures above.

Flaws:

- **Stock motions fit a shaft poorly.** `offhand.py` was written for hands together. On the first body the rear hand is on the shaft through three of the twelve stock motions and up to 5 centimetres off in the rest; on the second it is up to 23 centimetres off (the roll). The four made motions are the ones to use.
- **The silhouette match of the spear's mesh is 64%,** against about 90% for the swords. On a shape four pixels wide a pixel's slip costs a lot, and the mesh looks right in the hand, but it was not looked into further.
- **The poses were set on the first body and not searched** as the greatsword's were, which is why the second body's rear wrist is where it is.
- **The body faces forward throughout.** A spear stance is side-on; only the thrust turns the hips, by 13 degrees.
- **Nothing keeps the shaft out of the cape or the hip.**

Not checked: the model's picture in the site viewer (it loads, lists its motions and reports no errors), a staff with no head, the hands sliding on the shaft as they do in a real thrust, and the motions in play in an engine.

**Verdict.** Keep for the first body. The grip, the left hand leading and the rear elbow all carried over with small changes. The second body needs its own poses or wrist limits before his spear is usable. Step 54 found the cause and fixed it for both.

## 54. The spear's rear elbow

**Question.** Step 53 left the second body's rear wrist bent 82 to 86 degrees on the spear, and blamed poses that were set on the first body. Does he need poses of his own?

**What was tried.** No. The grip and the shaft's direction were left alone and only the place the rear arm's elbow is asked to go was varied: 37 places (out, up and forward or back from the shoulder), each solved on both bodies as a held guard, ranked by the worse wrist of the two bodies. Step 53 had put that elbow back and up after trying a handful of places on the first body alone.

**Result.**

![The second body from behind with his cape hidden: before, the rear arm folded behind the back; after, the elbow out at the side and the forearm down to the shaft](../website/public/research/3d/spear-rear-elbow.png)

- **The elbow belongs out at the side, a little up and a little forward** (0.6, 0.4, 0.3), not behind the back. The nine best places of the 37 all have the elbow forward of the shoulder; the one step 53 used came 29th.
- **Wrist bend, most through each motion, in degrees:**

| | Guard | Walk | Jog | Thrust |
|---|---|---|---|---|
| First body, forward hand | 4 | 3 | 8 | 28 |
| First body, rear hand, before | 48 | 47 | 51 | 72 |
| First body, rear hand, after | 15 | 16 | 16 | 20 |
| Second body, forward hand | 17 | 16 | 20 | 41 |
| Second body, rear hand, before | 82 | 84 | 85 | 86 |
| Second body, rear hand, after | 8 | 8 | 16 | 19 |

- **Both hands still reach at every moment on both bodies,** with no pull-in, and the loops close within 2 degrees.
- **Both files are valid** and Godot 4.7.2 imports both with its 17 required bones. The viewer's spear model is rebuilt with the new elbow.

Flaws:

- **The first body's rear elbow now stands out from his side** more than a spearman's would. It reads as a braced arm, not a broken one, but it is a wider pose than before.
- **The search was on a held guard only.** The thrust was not searched; its figures come from running the whole motion with the elbow the guard chose.
- **One elbow place serves every body.** A body shaped unlike these two could want another, and nothing searches for it when a file is made.

Not checked: the rebuilt model's picture in the site viewer, whether the rear arm passes through the cuirass or the cape at any moment (the pictures show four moments on each body and no pass-through), and the motions in play in an engine.

**Verdict.** Keep. The second body's spear is usable. The fault was the elbow, not the poses.

## 55. A side-on spear stance

**Question.** Step 53's spear motions face square to the front. A spearman stands turned, the leading shoulder forward. Can the motions be made side-on with what `wield.py` already has?

**What was tried.** Three small additions to a motion's footwork, then the four spear motions written again.

- *The other foot back.* A row of a motion's `feet` could step one foot. It can now also put the other foot behind (a seventh number), so a stance has its feet apart for its whole length.
- *That foot turned out* (`rear_foot`, degrees), as a rear foot is.
- *The head keeps looking ahead* (`look`). When the hips turn, the neck takes half the turn back and the head the rest.
- *The motions.* `Spear_Idle` is the stance: hips turned 45 degrees away from the leading side and 0.06 leg lengths lower, the leading foot 0.22 ahead, the other 0.18 behind and turned out 40 degrees. `Spear_Walk` and `Spear_Jog` keep the stock legs and turn the hips 28 and 14 degrees. `Spear_Thrust` starts in the stance, winds to 52 degrees, then steps the leading foot out to 0.60 as the hips come round to 30. The grip is written from the chest, so each pose's shaft is turned towards the leading side by about what the hips are turned away, and the point stays ahead.
- *The poses.* The stance's grip was picked from 96 tried on both bodies, the thrust's furthest reach from 48.

**Result.**

![Both bodies in the side-on stance from the side and from above, walking, and with the thrust landed](../website/public/research/3d/spear-stance.png)

- **Both hands are on the shaft and both feet reach at every moment of all four motions on both bodies,** with no pull-in.
- **Wrist bend, most through each motion, in degrees (forward hand, rear hand):**

| | Stance | Walk | Jog | Thrust |
|---|---|---|---|---|
| First body | 19, 9 | 18, 2 | 24, 16 | 26, 29 |
| Second body | 13, 14 | 22, 14 | 35, 22 | 34, 29 |

- **Both files are valid** and Godot 4.7.2 imports both with its 17 required bones. The viewer's spear model is rebuilt.

Two things went wrong on the way:

- **The feet came off the ground in the walk and jog,** by up to 2.7 centimetres on the second body: with the hips turned, a leg at full stretch falls short. The hips are 0.05 leg lengths lower in both, and the feet reach.
- **The thrust's forward wrist bent 54 degrees** with the hips squared to 20 degrees and the shaft straight ahead of them. The straight-wristed poses have the shaft further across the chest, so the hips now stop at 30.

Flaws:

- **The walk and jog are stock legs under turned hips.** The feet go where they went and point where they pointed. A real advance with a spear is a shuffle that keeps the leading foot ahead; this is a walk with the trunk turned.
- **The point is not dead ahead.** In the stance and at the end of the thrust the shaft is about 5 degrees across the line the body faces.
- **Three stances that do not match.** Standing is turned 45 degrees, walking 28, jogging 14, and the feet are split only when standing. An engine blending between them will swing the trunk.
- **Nothing keeps the shaft's butt out of the cape,** as before.

Not checked: the rebuilt model's picture in the site viewer, any moment but the four pictured on each body, the motions in play in an engine, and the right hand leading.

**Verdict.** Keep. The stance and the thrust read as a spearman's. The walk and jog are a stopgap until the legs are made for the stance.

## What has not worked, in one place

So nobody repeats them:

- Tubes around a skeleton as the body (step 7).
- Blending colours between views (step 9).
- Reaching inward for a colour when a texel lands just outside the sprite (step 9).
- Refusing colour near jumps in depth (step 9).
- Despeckling the texture by darkness (step 10).
- Rounding the carved voxels more before meshing: no effect on the scores.
- Intersecting the carved shape with the generated mesh (step 12).
- `correct_pixelart` on a torn render (step 13).
- Projecting image-model redraws back onto the model (step 14).
- Flattening a character's texture to a few materials (step 15).
- Laying trusted sprite pixels over a flat base (step 18).
- Asking the paint stage for a single view (step 20): grey noise.
- Letting the paint stage invent the sides from one front reference (step 17).
- Enlarging sprites with hard pixel edges for the mesh model (step 22): it builds a figure out of boxes.
- Keeping painted views away from their own outlines, and shifting views to agree in colour (step 23).
- Median cut for a sprite palette (step 25): most of the colours go to near-blacks.

Two bugs worth remembering, because both produced plausible wrong pictures: glTF's axes turned into ours by swapping two of them is a mirror image, which silhouettes cannot detect; and a mesh whose faces point inward gets no texture at all, only fill.

## What is next

- **Hold the paint stage's colours** to the sprites' (step 29): the gold dulls and the dark metal turns blue.
- **A smaller file.** Repack each cut item's texture to the part it uses, and thin the meshes.
- **Tidy the cut's edge,** which is ragged and carries a fringe of skin colour.
- **More bodies.** Step 46 puts the items on one heavier man. A much shorter or taller body, and other builds, are untested.
- **Higher quality paint.** The texture does not have to be pixel art: aim for the best painted surface the models can give, and pixelate afterwards if wanted. Step 32 starts it. Steps 33 to 35 continue it. Step 36 fixes the item edges and a colour fault. Still to do: the short sleeve, a second painter (MV-Adapter), and repacking each item's texture so it uses the whole picture and the file shrinks.
- **Towards game-ready** (see the survey below): a smaller file; sprites drawn at 256 pixels at the source; a thinned mesh with the paint and a normal map baked onto it; a standard humanoid skeleton and stock animations; metal and roughness; bones and springs for the cape.
- **Sixteen directions and lighting for the sprite cards** (step 31): the in-between views of step 13, and normals from the hidden mesh.
- **More directions, and animation.** Step 13 gives sixteen directions. Thirty-two would spin smoothly, and the same trick on a walk cycle would give walks in the in-between directions, which the generator does not offer.
- **Fix the squat proportions.** Carve at a finer grid, or let the redraw see a true neighbour at full height (the guide sheet does this and kept proportions better on the bare character).
- **Held items.** Steps 47 to 51 put a sword in either hand, open or drawn as a fist, a shield on a forearm, and a greatsword in both hands with four motions of its own. Step 52 gave the attack a step and step 53 added a spear with the hands apart, step 54 moved its rear elbow so both bodies hold it with easy wrists, and step 55 turned the spear motions side-on. Still to do: a handle sized to the hand, root motion, a spear advance with legs of its own, and motions made for a shield or a left-handed sword.
- **A score that sees cleanliness.** Colour error against one drawing cannot tell a clean redraw from a torn render.
- **Fewer, larger pieces in the unwrap.** The chest unwraps into a few large pieces, but the character comes out in hundreds of small ones, which is fine for a program and poor for a person or an image model to paint on. One piece per view, like a folded paper model, would make the texture a sprite sheet.
- **Carve at a finer grid** than one voxel per pixel, so thin objects survive.
- **Remove baked shading.** The sprites are drawn lit from one side, and that light is now painted on the model.
- **Open the rigged file in real engines.** Blender, Godot, Unity and Unreal each have their own expectations of a humanoid.
- **More animations, and bones for capes and held items.**
- **Bones for the cape,** now that it is one piece (step 24), and a check that a leg swinging back does not pass through it.
- **A pose the eight views agree on.** The knight's A-pose has one view in a T-pose (step 21). Drawing the pose from a skeleton, not a sentence, might fix it.
- **A score that forgives a pixel of offset** (step 25), so a clean render is not marked below a smear.
- **A licence-clean route.** TRELLIS or TripoSG for the mesh, MV-Adapter for the paint, UniRig for the bones. Their licences were not checked here.
- **Paint the carved shape too,** for the simple subjects where carving beats the generated mesh.
- **Sprite normal maps.** PixelLab can draw a normal map for a sprite. Baked onto the mesh the same way, it would add surface relief the low-polygon mesh lacks. Not tried.
- Can the eight-view input of the hosted Hunyuan3D 3.1 use all eight sprites? (Unverified; see below.)

## What other people are doing

From a web survey on 16 November 2026. Items marked *unverified* were seen in a listing or a search result and not read in full or tried here.

**Image-to-3D models**

- [Hunyuan3D-2mv](https://huggingface.co/tencent/Hunyuan3D-2mv) (Tencent). Open weights, multi-view. The one used in step 8.
- [Hunyuan3D 2.1](https://huggingface.co/tencent/Hunyuan3D-2.1) (Tencent). Open weights, with a texture stage. Same regional licence limits.
- [Hunyuan3D 3.1](https://www.3daistudio.com/Models/Hunyuan3D-3-1). Hosted only. Listed as accepting up to eight views. *Unverified.*
- [TRELLIS.2](https://huggingface.co/microsoft/trellis.2-4b) (Microsoft). MIT licence, single image, reported to need about 24 GB. *Unverified.*
- [Stable Point Aware 3D](https://stability.ai/news/stable-point-aware-3d) (Stability). Single image.
- [Pixal3D](https://ldyang694.github.io/projects/pixal3d/) (Tencent ARC). Aligned to the input image's camera, which is the property step 8 lacked. Licence not stated.
- Meshy and Tripo are paid hosted services; neither was tried.

No report was found of any of these being tested on pixel art.

**Without a model**

- [Turning 8-bit sprites into printable 3D models](https://0fps.net/2012/09/18/turning-8-bit-sprites-into-printable-3d-models/) (0fps, 2012). Voxels from sprites.
- [Pix 2D to 3D](https://korben.info/en/pix-2d-to-3d-sprites-to-3d-models-no-ai-gpu.html). Inflates one sprite by distance from its edge. *Unverified.*
- [A browser tool that extrudes pixel art layers into animated 3D](https://80.lv/articles/this-browser-based-tool-turns-pixel-art-into-animated-3d-models).
- [A manual sprite-to-3D workflow in Blender](https://80.lv/articles/2d-pixel-art-sprites-to-3d-workflow-shared-by-indie-game-developer).

**The other direction, 3D to pixel art**

- [Voxify3D](https://arxiv.org/abs/2512.07834). Turns a mesh into voxel art with a small palette.
- [Blender to Pixels](https://astropulse.itch.io/blender-to-pixels). Renders a 3D scene as pixel art.

**The Discord pipeline.** The thread that started this described: build the character from tubes or capsules, or generate a mesh with Hunyuan or Meshy; unwrap it "as a folded piece of paper"; retexture the unwrapped image with an image model; carve hair and clothes as separate pieces; remove baked shadows and highlights; render with a toon or pixel shader. None of it could be checked against a public source. Step 7 here tested the tubes part, steps 9 to 11 the unwrap and texture part, and step 13 the image model, on the rendered views and not on the unwrapped texture.

**Painting a mesh you already have.** From a second survey on 17 November 2026, for step 29's question of how to get a better texture. Nothing here was run; figures are as their sources give them, and several sources disagree.

| Option | Runs where | What it takes | Licence | Fit for a 12 GB card |
|---|---|---|---|---|
| Hunyuan3D-Paint 2.0 | Local, installed (step 17) | One reference per pass, 512 pixel views | Tencent community licence, regional limits | Runs today |
| [MV-Adapter](https://github.com/huanngzh/MV-Adapter), image to texture | Local, has ComfyUI nodes | A mesh and a reference image; 768 pixel views on SDXL, then RealESRGAN upscaling and LaMa inpainting | Apache-2.0 | README suggests the SD2.1 variant under 10 GB and SDXL above 16 GB |
| [Hunyuan3D 2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) paint | Local | Reference image; base colour, metal and roughness maps | Tencent community licence, regional limits | Official figure is 21 GB for texture. [A low-memory route exists](https://github.com/kijai/ComfyUI-Hunyuan3DWrapper/issues/165) by offloading; no 12 GB report was found |
| [TRELLIS.2](https://docs.comfy.org/tutorials/3d/trellis2), texture only | Local, native in ComfyUI | A mesh and one image | MIT | Claims range from 6 GB in a low-memory mode to 24 GB. *Unverified.* One image only, so the back is invented (the fault of step 17) |
| [Meshy Retexture](https://docs.meshy.ai/api/retexture) | Hosted, paid | An uploaded mesh and reference images; 2K to 8K textures | Closed | No card needed. About 10 credits a task. *Unverified pricing.* |
| UniTEX, MaterialMVP, MVPainter, RomanTex | Research code | Mesh and reference image | Not checked | Not checked |

- **The reference is the first cap, whichever painter is used.** Every option paints what its reference shows, and ours is a 64 to 80 pixel sprite enlarged with hard edges. A redraw of each direction as a large, detailed picture would raise the ceiling for all of them.
- **MV-Adapter is the likeliest local step up:** larger views, a permissive licence, and it sits on SDXL, so style models and edge or depth guides apply.
- **The turn-per-sprite trick of step 20 should carry over** to any painter that takes a reference and a mesh, since it only decides which way the mesh faces. It does not carry over to TRELLIS.2, which paints the whole surface at once.

**From a painted mesh to a game-ready asset.** From a third survey on 17 November 2026. The model of step 36 looks right and is not yet what a studio would call an asset. This lists what is missing, and what exists for each gap. Nothing here was run; most sources are vendor pages or the authors' own papers, and are marked where a claim could not be checked.

| Gap | Where the model stands | What exists |
|---|---|---|
| Triangle count and edge flow | 16,496 triangles after thinning (step 41), from 79,819; still no loops at the joints | [AutoRemesher](https://www.cgchannel.com/2026/07/get-free-retopology-tool-autoremesher-and-its-blender-bridge/) (free, MIT, all-quad, a target count); QuadriFlow in Blender; [CurioMesh](https://github.com/CurioCrafter/CurioMesh) (GPLv3, Blender). Guides put a rigged game character at 10,000 to 100,000 triangles. Then the paint is baked from the dense mesh onto the light one, with a normal map for the lost relief |
| Unwrap | Hundreds of small pieces from xatlas, and each item's texture mostly empty | A fresh unwrap of the light mesh with few seams; one packed texture per character or per item |
| Skeleton | Twenty-one bones under standard humanoid names, matched by Godot's profile (step 42); a thumb and one finger chain a hand where the mesh shows a thumb (step 47) | A standard humanoid skeleton so that stock animations fit. [Mixamo](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) rigs an uploaded humanoid in a T-pose for free and has a large animation library; it wants one joined mesh, and is described as unmaintained. Open models: [UniRig](https://dl.acm.org/doi/abs/10.1145/3730930) (MIT code; its checkpoints and data have their own terms), [Puppeteer](https://arxiv.org/pdf/2508.10898), RigAnything, Anymate (Apache-2.0). No memory figures were found for any of them. *Unverified.* |
| Animation | Eleven stock animations retargeted from a CC0 library (step 43), and one walk made by formula | Mixamo's library; [HY-Motion 1.0](https://arxiv.org/abs/2512.23464) (Tencent, open weights, text to human motion, a community licence). Its skeleton and export formats were not checked |
| Materials | Base colour only, with the redraw's lighting painted in | Roughness and metal maps: Hunyuan3D 2.1's paint stage (21 GB), MaterialMVP, and 2026 work that estimates materials from several views together ([ReLi3D](https://arxiv.org/abs/2603.19753), Intrinsic Image Fusion). A crude start costs nothing: metal and rough values per item |
| Parts | Cut from a worn mesh by a sprite mask and a colour test (steps 27 and 36) | Generators that make parts natively: [Hunyuan3D-Part](https://x.com/TencentHunyuan/status/1971491034044694798) (open, segments a mesh into parts and regenerates each whole), [OmniPart](https://arxiv.org/pdf/2507.06165) (planned from 2D part masks, which the paperdoll layers are), PartCrafter. None was checked for clothing or for a 12 GB card |
| References that agree | Eight directions redrawn one at a time (step 33); sprites at 256 pixels from the generator (step 39) | Models that turn one picture into consistent views: Qwen-Image-Edit with a multiple-angles LoRA, a Flux Kontext turnaround LoRA. Or draw the sprites larger at the source: PixelLab's v3 character goes to 256 pixels, four times step 26's |
| Cloth | The cape hangs from twelve bones and its swing is baked into each animation (step 45) | A chain of bones down the cape with spring physics in the engine, or the engine's cloth |
| Delivery | A 2.1 MB .glb that imports into Godot (steps 37 and 41) | Import tests in Godot, Unity and Unreal; mesh and texture compression (meshopt, KTX2); levels of detail |
| A yardstick | None | [Meshy's API](https://docs.meshy.ai/api/pricing) takes an uploaded mesh and sells each step: retexture 10 credits, remesh 5, rigging 5 with a walk and a run, an animation 3. One character through all of it would show what a paid pipeline returns. A paid plan is said to be needed for the API. *Unverified.* |

- **The largest gaps are not in the paint.** A studio would reject this model first for its triangle count, its unwrap and its home-made skeleton, and only then look at the texture.
- **A standard skeleton is worth more than any one animation,** because it makes every stock animation usable.
- **Several gaps close with no new model:** thinning the mesh and re-baking, a normal map from the dense mesh, values for metal and roughness, compression, an engine import test.

**Sprite cards on a 3D skeleton.** [A short from Cor Mundi Studios](https://www.youtube.com/shorts/84clZXpwRc0) (28 seconds, read from its transcript on 17 November 2026) shows a 2.5D player character in Unreal Engine 5. Each body part is a flat card with its own sprite sheet in sixteen directions. Under the cards is a 3D mesh that is not what the player sees: it carries the lighting and the bones, and the bones tell each card where to be and which direction to show. The picture stays hand-drawn pixels and the motion comes from a rig. Step 31 tries it with eight directions and no lighting.

No public tool was found that takes several directional pixel sprites and returns a mesh.

## Cost so far

- Six upright objects at 10 generations each: 60 PixelLab generations.
- Carving, tilt check, skeleton and rendering: nothing. They run locally in seconds.
- Hunyuan3D: nothing but about two minutes of GPU time per mesh, after a 4.93 GB download.
- Staged texturing: nothing. About six seconds a mesh on a laptop.
- Image-model redraws in steps 13 and 14: 50.1 generations for six calls.
- The paint stage: no generations. A 9.2 GB download, then about six minutes of GPU time per character.
- The rebuild of step 40: 0.8 generations for joints, and about two hours of GPU time.
- The 256 pixel body and four states in step 39: 9 generations for the body; the states are quoted at 10 to 25 each and were not read back.
- A-poses in step 21: 20 generations for the two states, 0.25 for importing the knight, 1.6 for sixteen joint estimates.
- The body and its five layers in step 26: 52.8 generations (2 for the body, 10 for each layer, 0.8 for the joints), read from the balance before and after.
- The sword of step 47: 25 generations for the eight directions, and six and a half minutes of GPU time for its mesh.
- The shield of step 49: 25 generations for the eight directions, and eight and a half minutes of GPU time for its mesh.
- The greatsword of step 50: 25 generations for the eight directions, and a little over two minutes of GPU time for its mesh.
- The spear of step 53: 50 generations for two tries at the eight directions, and about five minutes of GPU time for two meshes.
- Nine meshes in step 27: about two minutes of GPU time each. Five paint runs in step 29: five to six minutes each.

## Running the scripts

They are written for the files this session had on disk and take paths as arguments.

```bash
# Carve, smooth, colour and render <name>-<direction>.png from a folder. Prints the match.
node --experimental-strip-types research/scripts/carve.ts <folder> <name> <out-folder>

# The same, leaving out tilted views.
SKIP=north-east,south-west node --experimental-strip-types research/scripts/carve.ts <folder> <name> <out-folder>

# Voxelise a mesh and score it against the same sprites.
GLB=<mesh.glb> node --experimental-strip-types research/scripts/carve.ts <folder> <name> <out-folder>

# How far each view leans.
python3 research/scripts/tilt.py <folder> <name>

# Four views to a mesh, through a ComfyUI server (address at the top of the script).
python3 research/scripts/hunyuan3d.py <folder> <name> <out-folder>

# Fit, unwrap, texture and render a mesh from the sprites. Writes the texture, a textured .glb and a sheet.
python3 research/scripts/texture.py <folder> <name> <mesh.glb> <out-folder>

# The same stages on the carved shape: export the carve, then texture it. MODE=vote lets the views vote.
DUMP=1 node --experimental-strip-types research/scripts/carve.ts <folder> <name> <out-folder>
MODE=vote VOX=<out-folder>/<name>.vox CAMERA=<out-folder>/<name>.camera.json python3 research/scripts/texture.py <folder> <name> - <out-folder>

# A rigged, animated .glb. The rig file comes from carve.ts run with an anchors file.
python3 research/scripts/rig.py <name.textured.glb> <name.rig.json> <name.vox> <name.camera.json> <out.glb> <preview.png>

# Texture a mesh with Hunyuan3D's paint stage, one pass per sprite direction. Needs the second ComfyUI of step 17.
python3 research/scripts/hunyuan3d_paint_turn.py <name.textured.glb> <folder> <name> <out-folder>

# The same, keeping two side views from each pass and leaving the bake to bake.py.
SPREAD=22 STAGE=paint python3 research/scripts/hunyuan3d_paint_turn.py <name.textured.glb> <folder> <name> <out-folder>
python3 research/scripts/bake.py <name.textured.glb> <out-folder>/<name>.views.json <bake-folder> <name>

# Rig a mesh through its own inside, with the sprites' palette stored in the file.
PALETTE=<folder>:<name> TEX=512 python3 research/scripts/rig.py <name.baked.glb> <name.rig.json> - - <out.glb> <preview.png>

# A character from parts (steps 26 to 28). Sprites and layers share one canvas size; the camera is the body's.
python3 research/scripts/smooth_inputs.py <art> <base> <in> worn base,<underwear-layer>,<item-layer>
python3 research/scripts/hunyuan3d.py <in> worn <mesh-folder>
TURNS=0 CAMERA=<body.camera.json> python3 research/scripts/texture.py <sprites> <worn> <mesh-folder>/worn-mv.glb <tex>
TURNS=0 CAMERA=<body.camera.json> python3 research/scripts/texture.py <sprites> <mask> <mesh-folder>/worn-mv.glb <tex>
python3 research/scripts/cut_item.py <tex>/<worn>.textured.glb <tex>/<mask>.textured.glb <item.glb>
ITEMS="Helm=<helm.glb>:Head;Cape=<cape.glb>:Hips,Spine;Cuirass=<cuirass.glb>" python3 research/scripts/rig.py <body.textured.glb> <body.rig.json> - - <out.glb>

# Sprite cards (step 31): the bone that owns each vertex, then the sprites cut into pieces per bone.
SKIN=<skin.npz> python3 research/scripts/rig.py <body.textured.glb> <body.rig.json> - - <skeleton.glb>
LAYERS="Body=<body>;Cape=<cape>:Spine:behind;Helm=<helm>:Head" python3 research/scripts/cards.py <skin.npz> <body.camera.json> <sprites> <out-prefix>

# Redraw sprites large with a local image model, then paint from the redraws with larger views (step 32).
python3 research/scripts/redraw.py <sprites> <name> <redraw-folder> "<what the character is>"
VIEW=768 SPREAD=22 STAGE=paint python3 research/scripts/hunyuan3d_paint_turn.py <name.textured.glb> <redraw-folder> <name> <out-folder>
python3 research/scripts/bake.py <name.textured.glb> <out-folder>/<name>.views.json <bake-folder> <name> 2048

# A light copy of a painted part, with its paint and a normal map baked on (step 41), then rigged small.
TEX=512 python3 research/scripts/thin.py <painted.glb> <light.glb> 3000
ITEMS="Helm=<helm-light.glb>:Head" JPEG=90 TEX_NORMAL=512 python3 research/scripts/rig.py <body-light.glb> <body.rig.json> - - <out.glb>

# Add stock animations from a humanoid library to a rigged character (step 43).
python3 research/scripts/retarget.py <character.glb> <library.glb> <out.glb>

# Give a hanging item chains of bones, then swing them through every animation (step 45).
CHAINS="Cape=3x4" ITEMS="Cape=<cape.glb>:Hips,Spine,Chest:loose" python3 research/scripts/rig.py <body.glb> <body.rig.json> - - <character.glb>
python3 research/scripts/sway.py <animated.glb> <out.glb>

# Reshape an item made on one body for another (step 46). The skin files come from rig.py with SKIN=<file>.
ONLY=Head python3 research/scripts/refit.py <helm.glb> <first.skin.npz> <second.skin.npz> <helm-for-second.glb>

# Draw textured meshes large, one row each.
python3 research/scripts/look.py <sheet.png> <a.glb> <b.glb>

# The paint stage as published: one front reference, six invented views.
python3 research/scripts/hunyuan3d_paint.py <mesh.glb> <reference.png> <out-folder> <name>

# Render any textured mesh from sixteen directions at sprite size and score it.
python3 research/scripts/render.py <textured.glb> <folder> <name> <sheet.png>

# Score the second row of a sheet against the first.
python3 research/scripts/score.py <sheet.png>
```
