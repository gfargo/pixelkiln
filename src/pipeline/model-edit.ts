import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { describeGlb, glbImageBytes, imageInfo, parseGlb, replaceGlbImage, serializeGlb, type GlbDocument } from "../glb.ts"
import { sha256 } from "../hash.ts"
import type { LoadedManifest } from "../manifest.ts"
import { ManifestEditError } from "../manifest-edit.ts"
import { MediaType, validateMedia } from "../media.ts"
import { HAND_EDIT_DIR, MAX_HAND_EDIT_BYTES } from "./hand-edit.ts"

/**
 * Hand-fixing the textures of a 3D model, by the same rule as a sprite's
 * hand edit: the model as built is never touched, and the edit is a sibling
 * file under `<outDir>/edits/`.
 *
 * A model enters a project by being there. There is no manifest asset type
 * for one, so a `.glb` anywhere under a style's `outDir` is a model of that
 * style, found by looking. Its edit is `<outDir>/edits/<same relative
 * path>`: a copy of the model with one or more embedded textures replaced and
 * everything else kept byte for byte. Beside it sit `<edit>.edit.json` (who
 * saved it, when, and the hash of the model it started from, the record a
 * sprite's browser edit also gets) and one layered Pixelorama project per
 * painted texture.
 *
 * Nothing here reads or writes the manifest or the lockfile. A consumer that
 * wants the edit takes the file under `edits/` when it exists.
 */
export const MODEL_EXTENSION = ".glb"
/** A model bigger than this is listed but not opened for editing. */
export const MAX_MODEL_BYTES = 64 * 1024 * 1024
/** Stop looking after this many models; a project with more is not one this page was built for. */
const MAX_MODELS = 200
const MAX_DEPTH = 8
const SKIPPED_DIRS = new Set([HAND_EDIT_DIR, "node_modules"])

export interface ProjectModel {
  styleId: string
  /** Absolute path of the model as built. */
  file: string
  /** Absolute path its edit has, or would have. */
  editFile: string
}

/**
 * Every `.glb` under each style's `outDir`, skipping `edits/`, dot
 * directories, and `node_modules`. A file under two styles' folders belongs
 * to the style whose folder is deeper (then to the first by id), so each
 * model is listed once.
 */
export async function discoverModels(loaded: LoadedManifest, opts: { styles?: string[] } = {}): Promise<ProjectModel[]> {
  const styles = Object.entries(loaded.manifest.styles)
    .filter(([id]) => !opts.styles?.length || opts.styles.includes(id))
    .map(([id, style]) => ({ id, outDir: path.resolve(loaded.root, style.outDir ?? ".") }))
    .sort((a, b) => b.outDir.length - a.outDir.length || a.id.localeCompare(b.id))
  const seen = new Set<string>()
  const models: ProjectModel[] = []
  const walk = async (styleId: string, outDir: string, dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || models.length >= MAX_MODELS) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (models.length >= MAX_MODELS) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue
        await walk(styleId, outDir, full, depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(MODEL_EXTENSION) && !seen.has(full)) {
        seen.add(full)
        models.push({ styleId, file: full, editFile: path.join(outDir, HAND_EDIT_DIR, path.relative(outDir, full)) })
      }
    }
  }
  for (const style of styles) await walk(style.id, style.outDir, style.outDir, 0)
  return models.sort((a, b) => a.styleId.localeCompare(b.styleId) || a.file.localeCompare(b.file))
}

/** The model a page-supplied path names, or a refusal: only a discovered model is ever read or written. */
export async function findModel(loaded: LoadedManifest, portablePath: string): Promise<ProjectModel> {
  const wanted = path.resolve(loaded.root, portablePath)
  const model = (await discoverModels(loaded)).find((candidate) => candidate.file === wanted)
  if (!model) throw new ManifestEditError(`"${portablePath}" is not a model under one of this project's output folders`)
  return model
}

const stem = (editFile: string) => editFile.slice(0, -path.extname(editFile).length)

export function modelCompanionPath(editFile: string): string {
  return stem(editFile) + ".edit.json"
}

/** The layered Pixelorama project for one painted texture of a model. */
export function modelTextureProjectPath(editFile: string, image: number): string {
  return `${stem(editFile)}.image-${image}.pxo`
}

/** Where another program (Blender, or anything that writes glTF) leaves a model for the gallery to adopt. */
export function modelExportPath(editFile: string): string {
  return stem(editFile) + ".export" + MODEL_EXTENSION
}

const Sha = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * `<edit>.edit.json` for a model: the fields a sprite edit's companion has
 * (`version` 2, `editor`, `protocol`, `savedAt`, `project`, `outputs`), plus
 * one entry per texture that was replaced.
 */
export const ModelEditCompanionSchema = z
  .object({
    version: z.literal(2),
    /** What made the latest change: the bridge's editor identity, or `blender`. */
    editor: z.string().min(1),
    protocol: z.number().int().nonnegative(),
    savedAt: z.string().datetime(),
    /** Basename of the layer file of the texture saved last, when one was kept. */
    project: z.string().min(1).nullable(),
    /** One entry: the model. `basedOn` is the hash of the model as built when the edit was made. */
    outputs: z.array(z.object({ role: z.string().nullable(), basedOn: Sha.nullable(), sha256: Sha }).strict()).length(1),
    /** Every texture this edit replaced, by image index. */
    textures: z.array(
      z.object({
        image: z.number().int().nonnegative(),
        /** The material the texture belongs to, for reading the file without the model. */
        name: z.string(),
        sha256: Sha,
        editor: z.string().min(1),
        savedAt: z.string().datetime(),
        /** Basename of its layer file, when one was kept. */
        project: z.string().min(1).nullable(),
      }).strict(),
    ),
    /** Hash of the exported file the edit was last adopted from, so the same export is not offered twice. */
    adoptedExport: Sha.nullable().optional(),
  })
  .strict()
export type ModelEditCompanion = z.infer<typeof ModelEditCompanionSchema>

export async function readModelCompanion(editFile: string): Promise<ModelEditCompanion | null> {
  try {
    return ModelEditCompanionSchema.parse(JSON.parse(await readFile(modelCompanionPath(editFile), "utf8")))
  } catch {
    return null
  }
}

async function replaceFile(file: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, bytes)
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

async function readModel(file: string, what: string): Promise<{ bytes: Buffer; document: GlbDocument }> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch {
    throw new ManifestEditError(`${what} is not on disk at ${file}`)
  }
  if (bytes.length > MAX_MODEL_BYTES) throw new ManifestEditError(`${what} is ${bytes.length} bytes; the limit is ${MAX_MODEL_BYTES}`)
  try {
    return { bytes, document: parseGlb(bytes) }
  } catch (error) {
    throw new ManifestEditError(`${what} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const materialOfImage = (document: GlbDocument, image: number) =>
  describeGlb(document).images[image]?.materials[0] ?? `image ${image}`

export interface ModelTextureSaveInput {
  /** Index into the model's `images`. */
  image: number
  /** The painted texture, flattened. */
  png: Buffer
  /** The editor's layered project, kept beside the edit when given. */
  project?: Buffer
  editor: string
  protocol: number
  now?: Date
}

export interface ModelEditResult {
  editFile: string
  companionPath: string
  companion: ModelEditCompanion
  /** True when this call created the edit; false when it changed one already there. */
  created: boolean
}

/**
 * Save one painted texture into the model's edit. The edit starts as the
 * model as built (or continues from the edit already there, so textures
 * painted earlier stay painted), the PNG must be a valid image at the size of
 * the texture it replaces, and only that image's bytes change.
 */
export async function saveModelTexture(model: ProjectModel, input: ModelTextureSaveInput): Promise<ModelEditResult> {
  if (input.png.length > MAX_HAND_EDIT_BYTES) throw new ManifestEditError(`the texture is ${input.png.length} bytes; the limit is ${MAX_HAND_EDIT_BYTES}`)
  if (input.project && input.project.length > MAX_HAND_EDIT_BYTES) {
    throw new ManifestEditError(`the project file is ${input.project.length} bytes; the limit is ${MAX_HAND_EDIT_BYTES}`)
  }
  try {
    validateMedia(input.png, MediaType.PNG)
  } catch (error) {
    throw new ManifestEditError(`the texture is not a valid PNG: ${error instanceof Error ? error.message : String(error)}`)
  }
  const original = await readModel(model.file, "the model")
  const created = !existsSync(model.editFile)
  const base = created ? original : await readModel(model.editFile, "the model's edit")
  let current
  try {
    current = imageInfo(glbImageBytes(base.document, input.image).bytes)
  } catch (error) {
    throw new ManifestEditError(error instanceof Error ? error.message : String(error))
  }
  const painted = imageInfo(input.png)!
  if (current && (current.width !== painted.width || current.height !== painted.height)) {
    throw new ManifestEditError(`the texture is ${painted.width}×${painted.height}; image ${input.image} of the model is ${current.width}×${current.height}`)
  }
  const edited = Buffer.from(serializeGlb(replaceGlbImage(base.document, input.image, input.png, "image/png")))
  const savedAt = (input.now ?? new Date()).toISOString()
  const projectPath = input.project ? modelTextureProjectPath(model.editFile, input.image) : null
  const previous = created ? null : await readModelCompanion(model.editFile)
  const texture = {
    image: input.image,
    name: materialOfImage(original.document, input.image),
    sha256: sha256(input.png),
    editor: input.editor,
    savedAt,
    project: projectPath ? path.basename(projectPath) : null,
  }
  const companion: ModelEditCompanion = {
    version: 2,
    editor: input.editor,
    protocol: input.protocol,
    savedAt,
    project: texture.project,
    outputs: [{ role: null, basedOn: sha256(original.bytes), sha256: sha256(edited) }],
    textures: [...(previous?.textures ?? []).filter((entry) => entry.image !== input.image), texture].sort((a, b) => a.image - b.image),
    ...(previous?.adoptedExport ? { adoptedExport: previous.adoptedExport } : {}),
  }
  await replaceFile(model.editFile, edited)
  if (projectPath && input.project) await replaceFile(projectPath, input.project)
  const companionPath = modelCompanionPath(model.editFile)
  await replaceFile(companionPath, JSON.stringify(companion, null, 2) + "\n")
  return { editFile: model.editFile, companionPath, companion, created }
}

export type ModelAdoptMode = "textures" | "whole"

export interface ModelAdoptResult extends ModelEditResult {
  mode: ModelAdoptMode
  /** Material names whose base colour texture was taken from the export, in `textures` mode. */
  taken: string[]
}

/**
 * Take a model another program exported (Blender, after painting there) as
 * the edit. In `textures` mode, the default, only the base colour textures
 * are taken: each is matched to the model as built by material name and put
 * into a copy of it, so meshes, normal maps, skins, and animations stay
 * exactly as built however the other program re-encoded them. `whole` takes
 * the exported file as it is.
 */
export async function adoptModelExport(
  model: ProjectModel,
  opts: { mode?: ModelAdoptMode; from?: string; editor?: string; now?: Date } = {},
): Promise<ModelAdoptResult> {
  const from = opts.from ?? modelExportPath(model.editFile)
  const mode = opts.mode ?? "textures"
  const exported = await readModel(from, "the exported model")
  const original = await readModel(model.file, "the model")
  const created = !existsSync(model.editFile)
  const savedAt = (opts.now ?? new Date()).toISOString()
  const editor = opts.editor ?? "blender"
  const taken: string[] = []
  const textures: ModelEditCompanion["textures"] = []
  const previous = created ? null : await readModelCompanion(model.editFile)
  let edited: Buffer
  if (mode === "whole") {
    edited = exported.bytes
  } else {
    const baseColourImage = (document: GlbDocument, materialIndex: number) => {
      const info = document.json.materials?.[materialIndex]?.pbrMetallicRoughness?.baseColorTexture
      return info ? document.json.textures?.[info.index]?.source : undefined
    }
    const exportedByName = new Map<string, number>()
    for (const [index, material] of (exported.document.json.materials ?? []).entries()) {
      const image = baseColourImage(exported.document, index)
      if (material.name && image !== undefined && !exportedByName.has(material.name)) exportedByName.set(material.name, image)
    }
    let document = original.document
    const done = new Set<number>()
    for (const [index, material] of (original.document.json.materials ?? []).entries()) {
      const image = baseColourImage(original.document, index)
      const source = material.name ? exportedByName.get(material.name) : undefined
      if (image === undefined || source === undefined || done.has(image)) continue
      let bytes: Uint8Array
      try {
        bytes = glbImageBytes(exported.document, source).bytes
      } catch {
        continue
      }
      const info = imageInfo(bytes)
      if (!info) continue
      done.add(image)
      // An export that did not touch a texture hands back the same bytes; leave those alone.
      if (Buffer.from(glbImageBytes(original.document, image).bytes).equals(Buffer.from(bytes))) continue
      document = replaceGlbImage(document, image, bytes, info.mimeType)
      taken.push(material.name!)
      const hash = sha256(Buffer.from(bytes))
      // A texture the other program passed through untouched keeps its record, and with it its layer file.
      const kept = previous?.textures.find((entry) => entry.image === image && entry.sha256 === hash)
      textures.push(kept ?? { image, name: material.name!, sha256: hash, editor, savedAt, project: null })
    }
    if (!done.size) {
      throw new ManifestEditError(
        "no material of the exported model matches one of this model by name, so no texture could be taken; " +
          "adopt the whole file instead if it is meant to replace the model",
      )
    }
    edited = Buffer.from(serializeGlb(document))
  }
  const companion: ModelEditCompanion = {
    version: 2,
    editor,
    protocol: 0,
    savedAt,
    project: null,
    outputs: [{ role: null, basedOn: sha256(original.bytes), sha256: sha256(edited) }],
    textures,
    adoptedExport: sha256(exported.bytes),
  }
  await replaceFile(model.editFile, edited)
  const companionPath = modelCompanionPath(model.editFile)
  await replaceFile(companionPath, JSON.stringify(companion, null, 2) + "\n")
  return { editFile: model.editFile, companionPath, companion, created, mode, taken }
}

/**
 * The command that starts Blender: `PIXELKILN_BLENDER` (a program, or a
 * command with arguments) when set, else the usual install location for the
 * platform. Null when none is found; nothing is ever installed.
 */
export function blenderCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
  list: (dir: string) => string[] = (dir) => { try { return readdirSync(dir) } catch { return [] } },
): string[] | null {
  const override = env.PIXELKILN_BLENDER?.trim()
  if (override) return override.split(/\s+/)
  const candidates: string[] = []
  if (platform === "darwin") {
    candidates.push("/Applications/Blender.app/Contents/MacOS/Blender")
    if (env.HOME) candidates.push(path.join(env.HOME, "Applications/Blender.app/Contents/MacOS/Blender"))
  } else if (platform === "win32") {
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]].filter((value): value is string => Boolean(value))) {
      const foundation = path.win32.join(root, "Blender Foundation")
      // "Blender 4.2", "Blender 4.10": the newest by version number first.
      const versions = list(foundation).filter((name) => /^Blender/i.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const version of versions) candidates.push(path.win32.join(foundation, version, "blender.exe"))
    }
  } else {
    candidates.push("/usr/bin/blender", "/usr/local/bin/blender", "/snap/bin/blender", "/var/lib/flatpak/exports/bin/org.blender.Blender")
    for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) candidates.push(path.join(dir, "blender"))
  }
  const found = candidates.find((candidate) => exists(candidate))
  return found ? [found] : null
}

/**
 * What Blender runs on start: clear the default scene, import the model, and
 * add File > Export > "PixelKiln edit (.glb)", which writes the scene to the
 * path the gallery looks for an export at. The two paths arrive as arguments
 * after `--`, so no path is ever spliced into code.
 */
export const BLENDER_STARTUP = [
  "import bpy, os, sys",
  "source, target = sys.argv[sys.argv.index('--') + 1:][:2]",
  "for obj in list(bpy.data.objects):",
  "    bpy.data.objects.remove(obj, do_unlink=True)",
  "bpy.ops.import_scene.gltf(filepath=source)",
  "class PIXELKILN_OT_export_edit(bpy.types.Operator):",
  "    bl_idname = 'pixelkiln.export_edit'",
  "    bl_label = 'PixelKiln edit (.glb)'",
  "    bl_description = 'Export this scene to ' + target + ', where the PixelKiln gallery picks it up'",
  "    def execute(self, context):",
  "        os.makedirs(os.path.dirname(target), exist_ok=True)",
  "        bpy.ops.export_scene.gltf(filepath=target, export_format='GLB', export_tangents=True, export_animations=True, export_skins=True)",
  "        self.report({'INFO'}, 'Exported ' + target)",
  "        return {'FINISHED'}",
  "bpy.utils.register_class(PIXELKILN_OT_export_edit)",
  "bpy.types.TOPBAR_MT_file_export.prepend(lambda self, context: self.layout.operator('pixelkiln.export_edit'))",
].join("\n")

/** The full Blender command line for one model. */
export function blenderArguments(file: string, exportTo: string): string[] {
  return ["--python-expr", BLENDER_STARTUP, "--", file, exportTo]
}

/**
 * Start Blender on a model: its edit when there is one, else the model as
 * built. Returns the command, for the terminal. Throws when Blender is not
 * found, naming the override.
 */
export function openInBlender(model: ProjectModel, opts: { command?: string[] | null; launch?: (program: string, args: string[]) => void } = {}): string {
  const command = opts.command === undefined ? blenderCommand() : opts.command
  if (!command) {
    throw new ManifestEditError(
      "Blender was not found in its usual place; set PIXELKILN_BLENDER to the program (for example " +
        "PIXELKILN_BLENDER=/Applications/Blender.app/Contents/MacOS/Blender) and start the gallery again",
    )
  }
  const file = existsSync(model.editFile) ? model.editFile : model.file
  const [program, ...rest] = command
  const args = [...rest, ...blenderArguments(file, modelExportPath(model.editFile))]
  const launch = opts.launch ?? ((bin, argv) => {
    const child = spawn(bin, argv, { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  })
  launch(program!, args)
  return `${command.join(" ")} (${path.basename(file)})`
}
