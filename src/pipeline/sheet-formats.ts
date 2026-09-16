import type { PackedFrame } from "./pack.ts"

/**
 * Sprite-sheet metadata in the shapes engines already read.
 *
 * `pack` and `mount` produce a sheet and PixelKiln's own atlas: frames by
 * id with their rectangles, and the sets those frames belong to. That atlas
 * is the contract for scripts. An engine wants its own file beside the PNG:
 * Aseprite's sheet JSON, which Phaser, Unity importers, and Godot's Aseprite
 * plugins all load, or a Godot 4 `SpriteFrames` resource an
 * `AnimatedSprite2D` plays as it is. Both are pure functions of the atlas,
 * so the same sheet yields the same bytes every run.
 */
export type SheetFormat = "generic" | "aseprite" | "godot"
export const SHEET_FORMATS: readonly SheetFormat[] = ["generic", "aseprite", "godot"]

/** A multi-output asset whose members sit on the sheet under their roles. */
export interface AtlasSet {
  /** Asset id. */
  id: string
  /** `frames` for an ordered animation; `members` for a structural set such as tiles. */
  kind: "frames" | "members"
  /** Playback rate for `frames`; absent for structural sets. */
  fps?: number
  /** Frame ids in play order. */
  frames: string[]
}

/** What both writers need from a packed or mounted atlas. */
export interface SheetAtlas {
  style: string
  sheet: { width: number; height: number }
  cell: { width: number; height: number }
  frames: PackedFrame[]
  sets?: AtlasSet[]
}

/** Aseprite's default when a frame has no timing of its own. */
const ASEPRITE_DEFAULT_DURATION_MS = 100
/** Godot's `SpriteFrames` default animation speed. */
const GODOT_DEFAULT_SPEED = 5

export interface SheetFormatOptions {
  /** File name of the sheet PNG as the document should reference it, beside itself. */
  imageName: string
  /** Written into Aseprite's `meta.version`; the `app` names PixelKiln. */
  version?: string
}

/**
 * Aseprite's sheet JSON in its "hash" layout: frames keyed by name, in atlas
 * order, with `frameTags` spanning each set. A single sprite is one frame
 * with the default duration; a frame set's members carry `1000 / fps`. A
 * frame pack placed off the cell's top-left (a `character` style's
 * bottom-centred pivot) is recorded as a genuine trim: `sourceSize` is the
 * cell and `spriteSourceSize` is the frame's offset within it.
 */
export function renderAsepriteSheet(atlas: SheetAtlas, opts: SheetFormatOptions): string {
  const index = new Map(atlas.frames.map((frame, i) => [frame.id, i]))
  const durations = new Map<string, number>()
  const frameTags: { name: string; from: number; to: number; direction: "forward" }[] = []
  for (const set of atlas.sets ?? []) {
    const positions = set.frames.map((id) => index.get(id)).filter((i): i is number => i !== undefined)
    if (!positions.length) continue
    if (set.kind === "frames" && set.fps) {
      for (const id of set.frames) durations.set(id, Math.max(1, Math.round(1000 / set.fps)))
    }
    frameTags.push({ name: set.id, from: Math.min(...positions), to: Math.max(...positions), direction: "forward" })
  }
  const frames: Record<string, unknown> = {}
  for (const frame of atlas.frames) {
    const offsetX = frame.offsetX ?? 0
    const offsetY = frame.offsetY ?? 0
    const pivoted = offsetX !== 0 || offsetY !== 0
    frames[frame.id] = {
      frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
      rotated: false,
      trimmed: pivoted,
      spriteSourceSize: pivoted
        ? { x: offsetX, y: offsetY, w: frame.width, h: frame.height }
        : { x: 0, y: 0, w: frame.width, h: frame.height },
      sourceSize: pivoted ? { w: atlas.cell.width, h: atlas.cell.height } : { w: frame.width, h: frame.height },
      duration: durations.get(frame.id) ?? ASEPRITE_DEFAULT_DURATION_MS,
    }
  }
  const document = {
    frames,
    meta: {
      app: "https://pixelkiln.griffen.codes",
      version: opts.version ?? "pixelkiln",
      image: opts.imageName,
      format: "RGBA8888",
      size: { w: atlas.sheet.width, h: atlas.sheet.height },
      scale: "1",
      frameTags,
      layers: [{ name: atlas.style, opacity: 255, blendMode: "normal" }],
      slices: [],
    },
  }
  return JSON.stringify(document, null, 2) + "\n"
}

/**
 * A Godot 4 `SpriteFrames` resource over the sheet: one `AtlasTexture` per
 * frame, one animation per single sprite and per set. A frame set plays at
 * its fps and loops; everything else is a one-frame animation an
 * `AnimatedSprite2D` can show by name.
 */
export function renderGodotSpriteFrames(atlas: SheetAtlas, opts: SheetFormatOptions): string {
  const textureIds = new Map<string, string>()
  atlas.frames.forEach((frame, i) => textureIds.set(frame.id, `AtlasTexture_${i + 1}`))
  const inSet = new Set((atlas.sets ?? []).flatMap((set) => set.frames))

  const lines = [
    `[gd_resource type="SpriteFrames" load_steps=${atlas.frames.length + 2} format=3]`,
    "",
    `[ext_resource type="Texture2D" path=${JSON.stringify(`./${opts.imageName}`)} id="1_texture"]`,
  ]
  for (const frame of atlas.frames) {
    lines.push(
      "",
      `[sub_resource type="AtlasTexture" id="${textureIds.get(frame.id)}"]`,
      `atlas = ExtResource("1_texture")`,
      `region = Rect2(${frame.x}, ${frame.y}, ${frame.width}, ${frame.height})`,
    )
  }

  const animations: string[] = []
  const animation = (name: string, ids: string[], speed: number, loop: boolean) => {
    const frames = ids
      .filter((id) => textureIds.has(id))
      .map((id) => `{\n"duration": 1.0,\n"texture": SubResource("${textureIds.get(id)}")\n}`)
    if (!frames.length) return
    animations.push(
      `{\n"frames": [${frames.join(", ")}],\n"loop": ${loop},\n"name": &${JSON.stringify(name)},\n"speed": ${speed.toFixed(1)}\n}`,
    )
  }
  for (const set of atlas.sets ?? []) {
    if (set.kind === "frames") animation(set.id, set.frames, set.fps ?? GODOT_DEFAULT_SPEED, true)
    else for (const id of set.frames) animation(id, [id], GODOT_DEFAULT_SPEED, false)
  }
  for (const frame of atlas.frames) {
    if (!inSet.has(frame.id)) animation(frame.id, [frame.id], GODOT_DEFAULT_SPEED, false)
  }
  lines.push("", "[resource]", `animations = [${animations.join(", ")}]`, "")
  return lines.join("\n")
}

/** The document `format` asks for beside the sheet, with the extension it takes. */
export function renderSheetDocument(
  format: SheetFormat,
  atlas: SheetAtlas & Record<string, unknown>,
  opts: SheetFormatOptions,
): { extension: string; document: string } {
  if (format === "aseprite") return { extension: ".json", document: renderAsepriteSheet(atlas, opts) }
  if (format === "godot") return { extension: ".tres", document: renderGodotSpriteFrames(atlas, opts) }
  return { extension: ".json", document: JSON.stringify(atlas, null, 2) + "\n" }
}
