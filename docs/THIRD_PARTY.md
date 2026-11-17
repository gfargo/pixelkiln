# Third-party notices

PixelKiln's own code is under the [MIT license](../LICENSE). This page credits
other people's work that PixelKiln builds on or adapts.

## pixelfx

[pixelfx](https://github.com/patch-gg/pixelfx) is a library of code-drawn
pixel-art effects by Patch. `pixelkiln vfx --lib pixelfx` renders its effects
(see the [CLI reference](./CLI.md#local-effects-with-pixelfx)).

- PixelKiln does not bundle or redistribute pixelfx. You install it yourself
  (`npm i github:patch-gg/pixelfx`), and it is loaded at run time. It is a
  development dependency of this repository, pinned to a commit, so the tests
  can render with it.
- `src/pixelfx-vfx.ts` adapts two short routines from pixelfx's
  `tools/lib/fxlib.mjs`, which the package does not export: the loop that
  steps an effect into frames, and the fade of glow at the canvas edge.
- The effects you render with it are pixelfx's work under the same license.
  Its own `NOTICE.md` credits the sources some of them adapt (Sprite Fusion's
  open-source pixel-art VFX by Hugo Duprez, and Hollow Crown by rehan-remade,
  both MIT). The display font in its gallery is not MIT licensed and is not
  used here.

```text
MIT License

Copyright (c) 2026 Patch
Copyright (c) 2026 Hugo Duprez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
