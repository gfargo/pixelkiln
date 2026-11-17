# Research notes

Working notes on experiments that are not PixelKiln features yet. Each note says what was tried, with which model or tool, what came out, and what it cost, with pictures of the actual output.

These are notes, not documentation. Nothing here is a supported command. The scripts in [`scripts/`](scripts) are the ones that produced the pictures; they are rough.

| Note | Question | Where it stands |
|---|---|---|
| [3D models from directional sprites](sprites-to-3d.md) | Can the eight views PixelKiln already generates for an object or a character become a 3D model? | Shape works two ways. Texture is the open step. |

The paperdoll layer experiments (clothing layers, held items, loop cleaning, one-frame redraws, skin tones) are written up as field notes at the end of the [paperdoll guide](../docs/PAPERDOLL.md#field-notes).

## Adding to a note

Add a numbered experiment in the order it was run. For each one, write:

- **Question**: what the experiment was meant to find out.
- **Setup**: the model, tool, version, settings and inputs, exact enough to run again.
- **Result**: the numbers, and a picture in `img/` of what came out.
- **Verdict**: keep, drop, or needs another step, and why.

Say how each number was measured. Mark anything that was read somewhere and not checked here as unverified.
