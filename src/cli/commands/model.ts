/** `model`: the gallery's 3D model actions, from the terminal. */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { uvGuide } from "../../glb-guide.ts"
import { describeModels } from "../../gallery/models.ts"
import { galleryMediaId } from "../../gallery/snapshot.ts"
import { openInEditor } from "../../pipeline/hand-edit.ts"
import {
  adoptModelExport,
  blenderCommand,
  exportModelTexture,
  modelTexturePaths,
  openInBlender,
  resolveModel,
  resolveTextureImage,
  saveModelTexture,
  type ModelAdoptMode,
} from "../../pipeline/model-edit.ts"
import { glbImageBytes, imageInfo, parseGlb, type GlbDocument } from "../../glb.ts"
import { renderGuide } from "../../pipeline/model-guide.ts"
import { loadManifest } from "../../manifest.ts"
import { log } from "../io.ts"
import type { Args } from "../args.ts"

const shown = (file: string) => path.relative(process.cwd(), file) || file

/** The editor a terminal import records: the program PIXELKILN_EDITOR names, else "external". */
function editorName(): string {
  const program = process.env.PIXELKILN_EDITOR?.trim().split(/\s+/).pop()
  return program ? `${path.basename(program)} (via pixelkiln model import)` : "external (via pixelkiln model import)"
}

export async function runModel(args: Args): Promise<void> {
  const loaded = await loadManifest(args.manifest)
  const styles = args.styles.length ? { styles: args.styles } : {}
  const sub = args.subcommand

  if (sub === "list") {
    const models = await describeModels(loaded, { set: () => undefined }, galleryMediaId, styles)
    if (args.json) {
      // The page's media urls mean nothing outside a running gallery.
      log(JSON.stringify(models, (key, value) => (key === "url" || key === "projectUrl" ? undefined : value), 2))
      return
    }
    if (!models.length) {
      log("  no models: put a .glb under a style's outDir and it is listed here and in the gallery")
      return
    }
    for (const model of models) {
      log(`  ${model.file.path}  (${model.styleId})`)
      if (model.error) { log(`    could not be read: ${model.error}`); continue }
      const summary = model.summary!
      const triangles = summary.meshes.reduce((sum, mesh) => sum + mesh.triangles, 0)
      log(`    ${summary.meshes.length} meshes, ${triangles} triangles, ${summary.bones.length} bones, ${summary.animations.length} animations${summary.items.length ? `; parts: ${summary.items.join(", ")}` : ""}`)
      for (const image of summary.images) {
        const role = image.roles.map((r) => (r === "baseColor" ? "base colour" : r === "normal" ? "normal map" : r)).join(", ") || "unused"
        log(`    image ${image.index}: ${image.materials.join(", ") || "-"} ${role}, ${image.width}×${image.height} ${image.mimeType?.replace("image/", "") ?? ""}`)
      }
      if (model.edit) log(`    edit: ${model.edit.path} (${model.edit.status}${model.edit.editor ? `, ${model.edit.editor}` : ""}; ${model.edit.textures.map((t) => t.name).join(", ") || "no textures recorded"})`)
      if (model.exportWaiting) log(`    an export is waiting at ${model.exportPath}; run pixelkiln model adopt ${model.name}`)
    }
    return
  }

  const ref = args.target
  if (!ref) throw new Error(`model ${sub} needs a model: its path, its file name, or its gallery id. pixelkiln model list shows them.`)
  const model = await resolveModel(loaded, ref, styles)
  const name = path.basename(model.file, path.extname(model.file))

  if (sub === "export") {
    if (!args.image) throw new Error("model export needs --image <index or material name>; pixelkiln model list shows them")
    const result = await exportModelTexture(model, args.image, {
      ...(args.out ? { dir: path.resolve(args.out) } : {}),
      guide: (document, image) => {
        const guide = uvGuide(document, image)
        const size = describeSize(document, image)
        const files = renderGuide(guide, size.width, size.height)
        return { ...files, pieces: guide.pieces.length, regions: guide.regions }
      },
    })
    if (args.json) { log(JSON.stringify(result, null, 2)); return }
    log(`  ${result.material} texture (image ${result.image}, ${result.width}×${result.height}) from ${result.fromEdit ? "the edited copy" : "the model as built"}`)
    log(`    paint:  ${shown(result.texture)}`)
    log(`    guide:  ${shown(result.guide)}  (${result.guidePieces} pieces over ${result.regions.length} regions; lay it on top, never paint on it)`)
    log(`    key:    ${shown(result.key)}`)
    if (!args.noOpen) log(`  opened with: ${openInEditor(result.texture)}`)
    log(`  then: pixelkiln model import ${name} --image ${result.image}${args.out ? ` --from ${shown(result.texture)}` : ""}`)
    return
  }

  if (sub === "import") {
    if (!args.image) throw new Error("model import needs --image <index or material name>")
    const document = parseGlb(await readFile(model.file))
    const image = resolveTextureImage(document, args.image)
    const from = args.from ? path.resolve(args.from) : modelTexturePaths(model.editFile, image).texture
    let png: Buffer
    try {
      png = await readFile(from)
    } catch {
      throw new Error(`no painted texture at ${shown(from)}; run pixelkiln model export ${name} --image ${image} first, or pass --from`)
    }
    const saved = await saveModelTexture(model, { image, png, editor: editorName(), protocol: 0 })
    if (args.json) { log(JSON.stringify(saved.companion, null, 2)); return }
    log(`  saved ${shown(from)} as image ${image} into ${shown(saved.editFile)}${saved.created ? " (new edit)" : ""}; the model as built is unchanged`)
    log(`  record: ${shown(saved.companionPath)}`)
    return
  }

  if (sub === "blender") {
    if (!blenderCommand()) throw new Error("Blender was not found in its usual place; set PIXELKILN_BLENDER to the program")
    const command = openInBlender(model)
    log(`  started: ${command}`)
    log(`  paint in Blender, then File > Export > PixelKiln edit (.glb), then: pixelkiln model adopt ${name}`)
    return
  }

  if (sub === "adopt") {
    const mode = (args.mode ?? "textures") as ModelAdoptMode
    if (mode !== "textures" && mode !== "whole") throw new Error(`model adopt --mode is textures (the default) or whole, not "${mode}"`)
    const adopted = await adoptModelExport(model, { mode, ...(args.from ? { from: path.resolve(args.from) } : {}) })
    if (args.json) { log(JSON.stringify({ mode: adopted.mode, taken: adopted.taken, editFile: adopted.editFile, companion: adopted.companion }, null, 2)); return }
    log(adopted.mode === "whole"
      ? `  adopted the whole exported file as ${shown(adopted.editFile)}`
      : `  adopted ${adopted.taken.length ? adopted.taken.join(", ") : "no changed textures"} into ${shown(adopted.editFile)}; meshes and animations are as built`)
    return
  }
}

function describeSize(document: GlbDocument, image: number): { width: number; height: number } {
  const info = imageInfo(glbImageBytes(document, image).bytes)
  if (!info) throw new Error("the texture is neither PNG nor JPEG")
  return { width: info.width, height: info.height }
}
