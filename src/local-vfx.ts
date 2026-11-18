/**
 * What every local effect source (pixelfx, pixel-vfx-codex) writes: a
 * transparent spritesheet, an Aseprite-style atlas with the pivot in
 * `meta.anchor`, and a `.vfx.json` record whose recipe renders the same
 * pixels again. A source supplies its frames and the facts that are its own.
 */
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { sha256 } from "./hash.ts"
import { encodeRgbaPng } from "./png.ts"
import { vfxOutputPaths } from "./pixellab-vfx.ts"

/** One rendered effect: equal-sized RGBA frames on transparency. */
export interface LocalRender {
  width: number
  height: number
  fps: number
  loop: boolean
  /** The effect's pivot on a frame. */
  anchor: { x: number; y: number }
  /** One RGBA buffer per frame, `width * height * 4` bytes. */
  frames: Buffer[]
}

/** The frames in a row-major grid, in a near-square layout. */
export function localSheet(render: Pick<LocalRender, "width" | "height" | "frames">): {
  png: Buffer
  columns: number
  rows: number
  rects: Array<{ x: number; y: number; w: number; h: number }>
} {
  const { width, height, frames } = render
  const columns = Math.min(frames.length, Math.max(1, Math.ceil(Math.sqrt((frames.length * height) / width))))
  const rows = Math.ceil(frames.length / columns)
  const sheet = Buffer.alloc(columns * width * rows * height * 4)
  const rects = frames.map((rgba, index) => {
    const x = (index % columns) * width
    const y = Math.floor(index / columns) * height
    for (let row = 0; row < height; row++) {
      rgba.copy(sheet, ((y + row) * columns * width + x) * 4, row * width * 4, (row + 1) * width * 4)
    }
    return { x, y, w: width, h: height }
  })
  return { png: encodeRgbaPng(columns * width, rows * height, sheet), columns, rows, rects }
}

/** Refuses before any rendering when a file this run would write is already there. */
export function assertFreshOutputs(out: string, force?: boolean): ReturnType<typeof vfxOutputPaths> {
  const paths = vfxOutputPaths(out)
  if (!force) {
    for (const file of [paths.sheet, paths.atlas, paths.provenance]) {
      if (existsSync(file)) throw new Error(`${file} already exists; pass --force to replace it`)
    }
  }
  return paths
}

export interface WriteLocalVfxOptions {
  paths: ReturnType<typeof vfxOutputPaths>
  name: string
  effect: string
  render: LocalRender
  /** The key under the atlas's `meta` that holds the source's own facts, and those facts. */
  atlasKey: string
  atlasFacts: Record<string, unknown>
  /** First fields of the record: provider, tool, and library. */
  record: Record<string, unknown>
  /** The recipe that renders this again. */
  recipe: unknown
}

export interface WrittenLocalVfx {
  facts: {
    name: string
    effect: string
    width: number
    height: number
    frames: number
    fps: number
    loop: boolean
    anchor: { kind: "origin"; x: number; y: number }
  }
  columns: number
  sheetSha256: string
  paths: { sheet: string; atlas: string; provenance: string }
}

export async function writeLocalVfx(opts: WriteLocalVfxOptions): Promise<WrittenLocalVfx> {
  const { paths, render } = opts
  const sheet = localSheet(render)
  const clip = path.basename(paths.sheet, ".png")
  const anchor = { kind: "origin" as const, ...render.anchor }
  const size = { w: render.width, h: render.height }
  const atlas = {
    frames: sheet.rects.map((frame, index) => ({
      filename: `${clip} ${index}`,
      frame,
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, ...size },
      sourceSize: size,
      duration: Math.round(1000 / render.fps),
    })),
    meta: {
      app: "pixelkiln",
      version: "1",
      image: path.basename(paths.sheet),
      format: "RGBA8888",
      size: { w: sheet.columns * render.width, h: sheet.rows * render.height },
      scale: "1",
      frameTags: [{ name: clip, from: 0, to: render.frames.length - 1, direction: "forward" }],
      anchor,
      [opts.atlasKey]: {
        id: opts.effect,
        name: opts.name,
        ...opts.atlasFacts,
        fps: render.fps,
        loop: render.loop,
        frames: render.frames.length,
        frameSize: [render.width, render.height],
        pivot: [anchor.x, anchor.y],
        columns: sheet.columns,
      },
    },
  }
  const sheetSha256 = sha256(sheet.png)
  const facts = {
    name: opts.name,
    effect: opts.effect,
    width: render.width,
    height: render.height,
    frames: render.frames.length,
    fps: render.fps,
    loop: render.loop,
    anchor,
  }
  const record = {
    version: 1,
    ...opts.record,
    ...facts,
    files: { sheet: path.basename(paths.sheet), atlas: path.basename(paths.atlas) },
    sheetSha256,
    exportedAt: new Date().toISOString(),
    recipe: opts.recipe,
  }
  await mkdir(path.dirname(paths.sheet), { recursive: true })
  await writeFile(paths.sheet, sheet.png)
  await writeFile(paths.atlas, `${JSON.stringify(atlas, null, 2)}\n`)
  await writeFile(paths.provenance, `${JSON.stringify(record, null, 2)}\n`)
  return { facts, columns: sheet.columns, sheetSha256, paths: { sheet: paths.sheet, atlas: paths.atlas, provenance: paths.provenance } }
}
