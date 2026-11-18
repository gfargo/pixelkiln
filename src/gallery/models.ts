import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { describeGlb, parseGlb, type GlbSummary } from "../glb.ts"
import { sha256 } from "../hash.ts"
import type { LoadedManifest } from "../manifest.ts"
import { ManifestEditError } from "../manifest-edit.ts"
import { portableOutputPath } from "../outputs.ts"
import { MAX_HAND_EDIT_BYTES } from "../pipeline/hand-edit.ts"
import {
  adoptModelExport,
  blenderCommand,
  discoverModels,
  findModel,
  MAX_MODEL_BYTES,
  modelExportPath,
  modelTextureProjectPath,
  openInBlender,
  readModelCompanion,
  saveModelTexture,
  type ProjectModel,
} from "../pipeline/model-edit.ts"
import { generateModelNormals, MODEL_NORMAL_SOURCES, modelSpritesDir, planModelNormals, readSpriteFolder, type NormalMapper } from "../pipeline/model-normals.ts"

/** Served type of a `.glb`; the page fetches it and draws it itself. */
export const MODEL_FILE_TYPE = "model/gltf-binary"

export interface GalleryModelFile {
  /** Manifest-relative path. */
  path: string
  absolutePath: string
  bytes: number
  modifiedAt: string
  sha256: string
  /** Served only while the gallery runs. */
  url: string
}

export type ModelEditStatus =
  /** A browser or adopted edit of the model as it is now. */
  | "edited"
  /** The model was rebuilt after the edit was made; the edit is based on the older build. */
  | "rebuilt-since"
  /** A file at the edit path with no record beside it: placed there by hand. */
  | "unrecorded"

export interface GalleryModel {
  /** Page identity: `model:<style>/<path under the style's outDir>`, prefixed by project id in a workspace. */
  id: string
  project: string | null
  styleId: string
  /** File name without the extension. */
  name: string
  file: GalleryModelFile
  /** What the model holds; null when it could not be read. */
  summary: GlbSummary | null
  /** Why the model could not be read. */
  error: string | null
  edit: (GalleryModelFile & {
    status: ModelEditStatus
    /** From `<edit>.edit.json`; null for a file placed by hand. */
    editor: string | null
    savedAt: string | null
    /** The edit changed on disk after its record was written. */
    changedSince: boolean
    /** Textures the edit replaced, with the layer file kept for each, when there is one. */
    textures: Array<{ image: number; name: string; editor: string; savedAt: string; project: string | null; projectUrl: string | null }>
  }) | null
  /** Where the edit lives, or would: manifest-relative. */
  editPath: string
  /** Where an export from another program is looked for: manifest-relative and absolute. */
  exportPath: string
  exportAbsolutePath: string
  /** An exported model waiting there that the edit was not adopted from. */
  exportWaiting: { bytes: number; modifiedAt: string } | null
  /** The figure's own sprites in `<model>.sprites/`, by direction, for normal map detail; null when there is no such folder. */
  sprites: { path: string; directions: string[] } | null
}

export interface GalleryModelMedia {
  path: string
  contentType: typeof MODEL_FILE_TYPE | "application/octet-stream"
}

/** The part of the gallery's media allowlist this module adds to. */
type MediaSink = { set(id: string, value: GalleryModelMedia): unknown }

async function describeFile(
  media: MediaSink,
  mediaId: (absolutePath: string) => string,
  root: string,
  file: string,
  bytes: Buffer,
): Promise<GalleryModelFile> {
  const info = await stat(file)
  const id = mediaId(file)
  const hash = sha256(bytes)
  media.set(id, { path: file, contentType: MODEL_FILE_TYPE })
  return {
    path: portableOutputPath(file, root),
    absolutePath: file,
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    sha256: hash,
    url: `/media/${id}?v=${hash.slice(0, 24)}`,
  }
}

/** The models of one project, described for the page, with the files it may load added to `media`. */
export async function describeModels(
  loaded: LoadedManifest,
  media: MediaSink,
  mediaId: (absolutePath: string) => string,
  opts: { styles?: string[] } = {},
): Promise<GalleryModel[]> {
  const root = loaded.root
  const models: GalleryModel[] = []
  for (const model of await discoverModels(loaded, opts)) {
    let bytes: Buffer
    try {
      bytes = await readFile(model.file)
    } catch {
      continue
    }
    const outDir = path.resolve(root, loaded.manifest.styles[model.styleId]?.outDir ?? ".")
    let summary: GlbSummary | null = null
    let error: string | null = null
    if (bytes.length > MAX_MODEL_BYTES) error = `the file is ${bytes.length} bytes; models over ${MAX_MODEL_BYTES} are listed but not opened`
    else {
      try {
        summary = describeGlb(parseGlb(bytes))
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }
    const file = await describeFile(media, mediaId, root, model.file, bytes)
    let edit: GalleryModel["edit"] = null
    let adoptedExport: string | null = null
    if (existsSync(model.editFile)) {
      try {
        const editBytes = await readFile(model.editFile)
        const described = await describeFile(media, mediaId, root, model.editFile, editBytes)
        const companion = await readModelCompanion(model.editFile)
        adoptedExport = companion?.adoptedExport ?? null
        const textures = (companion?.textures ?? []).map((texture) => {
          const projectPath = texture.project ? modelTextureProjectPath(model.editFile, texture.image) : null
          let projectUrl: string | null = null
          if (projectPath && existsSync(projectPath)) {
            const id = mediaId(projectPath)
            media.set(id, { path: projectPath, contentType: "application/octet-stream" })
            projectUrl = `/media/${id}?v=${texture.sha256.slice(0, 24)}`
          }
          return {
            image: texture.image,
            name: texture.name,
            editor: texture.editor,
            savedAt: texture.savedAt,
            project: projectPath && projectUrl ? portableOutputPath(projectPath, root) : null,
            projectUrl,
          }
        })
        edit = {
          ...described,
          status: !companion ? "unrecorded" : companion.outputs[0]!.basedOn === file.sha256 ? "edited" : "rebuilt-since",
          editor: companion?.editor ?? null,
          savedAt: companion?.savedAt ?? null,
          changedSince: companion ? companion.outputs[0]!.sha256 !== described.sha256 : false,
          textures,
        }
      } catch {
        edit = null
      }
    }
    const exportFile = modelExportPath(model.editFile)
    let exportWaiting: GalleryModel["exportWaiting"] = null
    try {
      const info = await stat(exportFile)
      if (info.isFile() && info.size <= MAX_MODEL_BYTES && sha256(await readFile(exportFile)) !== adoptedExport) {
        exportWaiting = { bytes: info.size, modifiedAt: info.mtime.toISOString() }
      }
    } catch {
      // No export waiting.
    }
    const spritesDir = modelSpritesDir(model.file)
    let sprites: GalleryModel["sprites"] = null
    if (existsSync(spritesDir)) {
      try {
        sprites = { path: portableOutputPath(spritesDir, root), directions: (await readSpriteFolder(spritesDir)).map((sprite) => sprite.direction) }
      } catch {
        // An unreadable folder offers nothing.
      }
    }
    const relative = path.relative(outDir, model.file).split(path.sep).join("/")
    models.push({
      id: `model:${model.styleId}/${relative}`,
      project: null,
      styleId: model.styleId,
      name: path.basename(model.file, path.extname(model.file)),
      file,
      summary,
      error,
      edit,
      editPath: portableOutputPath(model.editFile, root),
      exportPath: portableOutputPath(exportFile, root),
      exportAbsolutePath: exportFile,
      exportWaiting,
      sprites,
    })
  }
  return models
}

const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(MAX_HAND_EDIT_BYTES / 3) * 4)

/** What the page may ask for a model. `path` is checked against the models the project actually has. */
export const ModelRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save-model-texture"),
      project: z.string().min(1).optional(),
      /** Manifest-relative path of the model as built. */
      path: z.string().min(1).max(1024),
      image: z.number().int().nonnegative(),
      png: Base64.min(1),
      pxo: Base64.optional(),
      editor: z.string().min(1).max(200),
      protocol: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("adopt-model-export"),
      project: z.string().min(1).optional(),
      path: z.string().min(1).max(1024),
      mode: z.enum(["textures", "whole"]).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("generate-model-normals"),
      project: z.string().min(1).optional(),
      path: z.string().min(1).max(1024),
      source: z.enum(MODEL_NORMAL_SOURCES),
      /** Normal map images; all of the model's when left out. */
      images: z.array(z.number().int().nonnegative()).max(64).optional(),
      amount: z.number().min(0).max(2).optional(),
      replace: z.boolean().optional(),
      /** The price the person agreed to on the page; a run that would cost more is refused. */
      maxCost: z.number().nonnegative().max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("open-model"),
      project: z.string().min(1).optional(),
      path: z.string().min(1).max(1024),
    })
    .strict(),
])
export type ModelRequest = z.infer<typeof ModelRequestSchema>

export const MODEL_ACTIONS = ["save-model-texture", "adopt-model-export", "generate-model-normals", "open-model"]

/**
 * What a gallery needs to ask PixelLab for a model's normal map detail: who
 * answers, and a purse the session's spending comes out of. `spend` throws
 * when a run would go past it, before anything is sent.
 */
export interface ModelNormalSpending {
  mapper: (loaded: LoadedManifest) => NormalMapper
  spend: (cost: number) => void
}

/** Apply one model request. Never touches the manifest or the lockfile. */
export async function applyModelRequest(
  loaded: LoadedManifest,
  request: ModelRequest,
  opts: { log?: (msg: string) => void; openBlender?: (model: ProjectModel) => string; normals?: ModelNormalSpending | null } = {},
): Promise<void> {
  const log = opts.log ?? (() => {})
  const model = await findModel(loaded, request.path)
  const shown = (file: string) => portableOutputPath(file, loaded.root)
  if (request.action === "save-model-texture") {
    const saved = await saveModelTexture(model, {
      image: request.image,
      png: Buffer.from(request.png, "base64"),
      ...(request.pxo ? { project: Buffer.from(request.pxo, "base64") } : {}),
      editor: request.editor,
      protocol: request.protocol,
    })
    log(`  model texture saved from ${request.editor}: image ${request.image} of ${shown(model.file)} into ${shown(saved.editFile)}${saved.created ? " (new edit)" : ""}`)
  } else if (request.action === "adopt-model-export") {
    const adopted = await adoptModelExport(model, { ...(request.mode ? { mode: request.mode } : {}) })
    log(adopted.mode === "whole"
      ? `  model export adopted whole: ${shown(adopted.editFile)}`
      : `  model export adopted: ${adopted.taken.length} texture(s) (${adopted.taken.join(", ") || "none changed"}) into ${shown(adopted.editFile)}`)
  } else if (request.action === "generate-model-normals") {
    if (!opts.normals) throw new ManifestEditError("this gallery spends no PixelLab generations; start it with --edit --budget <n> to allow normal map detail")
    const sprites = request.source === "sprites" ? await readSpriteFolder(modelSpritesDir(model.file)).catch(() => []) : undefined
    if (sprites && !sprites.length) throw new ManifestEditError(`no sprites in ${shown(modelSpritesDir(model.file))}: put south.png, east.png, and so on there`)
    const options = {
      source: request.source,
      ...(sprites ? { sprites } : {}),
      ...(request.images?.length ? { images: request.images } : {}),
      ...(request.amount !== undefined ? { amount: request.amount } : {}),
      ...(request.replace ? { replace: true } : {}),
    }
    const plan = await planModelNormals(model, options)
    if (plan.cost > request.maxCost + 1e-9) throw new ManifestEditError(`this run costs ${plan.cost} generations, more than the ${request.maxCost} agreed on the page`)
    opts.normals.spend(plan.cost)
    const result = await generateModelNormals(model, options, opts.normals.mapper(loaded))
    log(`  normal map detail from PixelLab (${request.source}, ${result.sent} call${result.sent === 1 ? "" : "s"}, ${plan.cost} generations): ${plan.images.map((image) => image.name).join(", ")} into ${shown(result.editFile)}`)
  } else {
    const command = (opts.openBlender ?? ((target) => openInBlender(target)))(model)
    log(`  opened in Blender: ${command}`)
  }
}

/** Whether this machine has a Blender the gallery could start; decides if the page offers the button. */
export function blenderAvailable(): boolean {
  return blenderCommand() !== null
}
