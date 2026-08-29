# Minimal example

```bash
export PIXELLAB_API_KEY=...

# Free — shows exactly what a run would cost.
pixelkiln plan --manifest pixelkiln.manifest.json

# 3 assets x 40 generations = 120, returning 16 candidates each.
pixelkiln gen --manifest pixelkiln.manifest.json --budget 120
```

`gen` opens a contact sheet in your browser to pick among the candidates, then
writes `out/base/tools/anvil.png` and friends, recording provenance in
`pixelkiln.lock.json`.

## Adding a variant style

Add a second entry under `styles` with a different `outDir`, then:

```bash
pixelkiln gen --style neon
```

Every asset re-derives under the new style. The original files are untouched.
Styles are separate namespaces in both the output tree and the lockfile.
