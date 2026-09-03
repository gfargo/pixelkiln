# ComfyUI smoke project

This example uses only ComfyUI core nodes and the public Stable Diffusion 1.5
checkpoint from Comfy's first-generation guide. It exists to verify the local
submit, poll, download, provenance, and recovery path. It is not the visual
benchmark model.

Install `v1-5-pruned-emaonly-fp16.safetensors` in ComfyUI's `checkpoints`
model folder, then copy this directory into a scratch project. From the copy:

```bash
pixelkiln doctor --dry-run
pixelkiln doctor
pixelkiln plan
pixelkiln gen --budget 0
pixelkiln audit --check
```

The workflow is already in API format. Its bindings match the node and input
IDs in `pixelkiln.manifest.json`. Editing either file changes the resolved asset
identity.

The checkpoint is not part of this repository. Its model card and license are
published by [Comfy Org on Hugging Face](https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive).
