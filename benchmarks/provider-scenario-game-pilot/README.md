# Scenario game pilot

What Scenario did on a real project: a retro isometric pixel-art disc golf game
that generates its art with PixelLab (about 1,800 manifest assets, 32 px props,
240 px landmark structures, 192×96 covers, 48 px animated characters). Run on
October 5, 2026, in scratch projects outside the game. **The game's art is not
included here;** this records settings and measurements. About 100 CU, every quote
matched its bill. One sample per subject, judged by eye.

## Verdicts

| Job | Verdict |
|---|---|
| 32 px native props (a tree turned autumn or winter) | **Poor.** Edit, Pixelate and cutout (8 CU each) returned different trees; Pixelate at the native grid reduced fine detail to blocks, and Birefnet punched holes in the canopy. |
| 240 px landmarks (temple, ski lodge, harbour warehouse) | **Strong.** More detailed than the game's current sprites, at the same pixel scale. |
| Course cover (192×96 banner) | **Strong, with a different look.** Much richer than the current cover, with legible title text. |
| Sound effects | **Works, with effort.** ElevenLabs (30 CU a take) made a usable two-part basket sound once each event was its own sound and the prompt described bars, not a cavity; MM Audio (1 CU) could not make impacts. |

## Landmarks (62 CU, then 7)

Each: render at 960 px wide, Pixelate to a 64-colour palette, Birefnet cutout
(2 CU), then the free `refine` gate. GPT Image 2 (`quality: medium`) was 11 CU
for a 960×896, 960×832 or 960×704 canvas alike; FLUX.2 Klein 9b was 1 CU. Prompts
were the game's own, without "transparent background" and with "isolated on a
plain white background, no ground, no cast shadow".

- Pixelate with `pixelGridSize: 240` on a 960 px image made **2 px blocks**
  (every run was 2 px; a 4× nearest-neighbour round trip mismatched 20 to 29%, a 2× one 0%).
  `refine` then found a doubled grid (474×448, 480×352, 176×157) at **medium**
  confidence and the audit failed at the default `high`.
- With `pixelGridSize: 120`, the blocks were **4 px** (a 4× round trip matched
  exactly) and `refine` recovered **240×208 at high confidence** with 63 colours,
  the size of the game's existing lodge sprite. Judged at equal scale, the result
  shows far more detail (timber balconies, snow, lanterns, skis).
- On a 512 px input the grid had been literal (48, 64 and 128 asked, 46, 64 and
  128 found), so the factor depends on the input size.
- The 1 CU Klein temple was about as good as the 11 CU GPT one (vines, carved
  heads, stairs); GPT added a clearer shrine doorway. The GPT warehouse added
  legible signage the prompt had not asked for.
- Whole chains: 18 CU with GPT Image 2, 8 CU with Klein.

## Cover (11 + 5 CU)

GPT Image 2 at 768×384 from the game's cover prompt: a painterly illustration with
rendered title text ("Maplewood Meadows"), not pixel art. Pixelate at a requested
192 grid made it pixel art with 31 colours, text intact; `refine` found a 256×128
grid at high confidence. To land on the game's 192×96, ask for about 144.

## Sound effects (about 300 CU in all)

A disc hitting a basket's chains and dropping onto its bars, judged by the game's
owner by ear. Nineteen generations over four rounds:

1. One narrated prompt, 3 to 4 seconds (MM Audio 1 CU, ElevenLabs 30 CU): too
   long, with the chain rattle and the drop spread out; the owner wanted them
   almost immediate.
2. One prompt, 0.8 to 1.4 seconds (MM Audio): "like the microphone was on and
   it was empty space". The envelope agreed: the quietest took had every moment
   within 20 dB of the peak, and none had a sharp onset.
3. One short ElevenLabs take (1.2 s): closer, but no drop and not chain-like.
4. The events split into separate sounds and layered (see
   [Set up Scenario](../../docs/SCENARIO.md#sound-effects-and-other-non-image-models)):
   MM Audio's chain was usable but its drop was silence; ElevenLabs gave both. The
   first drop ("hollow steel basket") sounded like a bucket with an echo. Three
   more prompts and four takes of the "ring of thin steel bars" wording followed;
   the second re-run of that prompt won.

The finished effect is `disc_basket_putt.wav`, 0.6 s, 44.1 kHz mono, with the
two prompts and the post chain in a provenance note. It lives with the owner, not
in this repository. The synth prototype (free, pure Python) was not chosen.

## Not tested

A style-matched run (the game's palette per course), animation or video models,
Retro Diffusion (locked on a `cu-basic` plan), and whether these results are
stable across seeds.
