# Research scripts

The scripts behind the research notes in the docs. They are rough, take paths as arguments, and are not part of PixelKiln or its npm package.

| Note | Scripts |
|---|---|
| [3D models from directional sprites](../docs/RESEARCH_3D.md) | `scripts/carve.ts`, `scripts/tilt.py`, `scripts/smooth_inputs.py`, `scripts/hunyuan3d.py`, `scripts/texture.py`, `scripts/redraw.py`, `scripts/hunyuan3d_paint.py`, `scripts/hunyuan3d_paint_turn.py`, `scripts/mvadapter_paint_turn.py`, `scripts/mvadapter_remote.py`, `scripts/bake.py`, `scripts/cut_item.py`, `scripts/thin.py`, `scripts/cards.py`, `scripts/render.py`, `scripts/look.py`, `scripts/rig.py`, `scripts/retarget.py`, `scripts/sway.py`, `scripts/refit.py`, `scripts/score.py` |

## Writing a research note

Notes live in `docs/` as `RESEARCH_<TOPIC>.md`, are registered in `website/app/lib/docs.ts` under the Research group, and keep their pictures in `website/public/research/<topic>/`.

Add a numbered experiment in the order it was run. For each one, write:

- **Question**: what the experiment was meant to find out.
- **Setup**: the model, tool, version, settings and inputs, exact enough to run again.
- **Result**: the numbers, and a picture of what came out.
- **Verdict**: keep, drop, or needs another step, and why.

Say how each number was measured. Mark anything that was read somewhere and not checked as unverified.
