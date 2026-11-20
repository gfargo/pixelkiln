# Custom rig showcase: the mage's staff swing

The pictures in `docs/SKELETONS.md` ("Custom rigs in PixelKiln") and on
`/skeletons#props`. Made November 19, 2026 with this branch's commands.

1. `mage-south.png` is the paperdoll builder's base, briefs, robe, wizard hat and
   staff layers stacked on a 128px canvas (see `../rigging-tools/`).
2. `pixelkiln estimate-skeleton mage-south.png --custom --description "wizard in
   a purple robe and a tall pointed hat, holding a long staff with a purple
   crystal in his right hand" --action "swinging the staff overhead" --frames 1
   --out poses/mage-rig.json`: 1 generation, a 26-joint `person` rig with
   `staff_butt`, `staff_mid`, `staff_top`, a hat chain and brim.
3. The `mage-swing` revision in `pixelkiln.manifest.json`, with
   `writeMotionFrames: 8`, through `pixelkiln gen --budget 4`: 8 frames at
   128x128, billed 3 generations (`out/`, `pixelkiln.lock.json`).
