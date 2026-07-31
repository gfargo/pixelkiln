import { readFileSync } from "node:fs"
import path from "node:path"
import { decodePng, encodeRgbaPng } from "../png.ts"
import type { Lock } from "../types.ts"

export interface PackedFrame {
  /** Asset id, so a consumer can look a sprite up by name rather than index. */
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface PackedSheet {
  png: Buffer
  atlas: {
    style: string
    sheet: { width: number; height: number }
    /** Uniform cell the grid was laid out on. Frames may be smaller. */
    cell: { width: number; height: number }
    columns: number
    frames: PackedFrame[]
  }
  /** Assets skipped because their file was missing or unreadable. */
  skipped: { id: string; reason: string }[]
}

/**
 * Composites one style's sprites into a single sheet plus a frame atlas.
 *
 * A grid rather than a bin-packer. Every sprite in a style shares a generator
 * and a size, so rectangles are near-uniform and the gain from tight packing
 * is a few percent of area — not worth the loss of a stable, predictable
 * layout. A grid also means a frame's position is derivable from its index,
 * which matters when someone is reading the sheet by eye to debug it.
 *
 * The cell is the largest sprite in the set. Assets can override width/height
 * individually, so assuming uniformity would silently clip the odd one out.
 * Smaller sprites are placed at the cell's top-left and their real dimensions
 * recorded, rather than being centred: centring would bake half-pixel offsets
 * into odd-sized differences, and a consumer that ignores the atlas and slices
 * on the cell grid still gets a correct — if padded — sprite.
 */
export function packStyle(
  lock: Lock,
  styleId: string,
  manifestDir: string,
  options: { columns?: number } = {},
): PackedSheet {
  // Lock keys are `<styleId>/<assetId>`. Sorting by asset id keeps the sheet
  // byte-identical across runs, so committing it produces a clean diff only
  // when the art actually changed.
  const prefix = `${styleId}/`
  const entries = Object.entries(lock.entries)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, entry]) => ({ id: key.slice(prefix.length), entry }))
    .sort((a, b) => a.id.localeCompare(b.id))

  if (!entries.length) {
    throw new Error(
      `No locked assets for style "${styleId}". Run \`pixelkiln gen --style ${styleId}\` first.`,
    )
  }

  const sprites: { id: string; width: number; height: number; pixels: Buffer }[] = []
  const skipped: { id: string; reason: string }[] = []

  for (const { id, entry } of entries) {
    // `outputs` is v2's array; the first is the sprite itself. A role-tagged
    // entry (previews, sheets) would be additional.
    const output = entry.outputs?.[0]
    if (!output) {
      skipped.push({ id, reason: "no output recorded in the lockfile" })
      continue
    }
    try {
      const png = decodePng(readFileSync(path.resolve(manifestDir, output.path)))
      sprites.push({ id, width: png.width, height: png.height, pixels: png.pixels })
    } catch (err) {
      skipped.push({ id, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  if (!sprites.length) {
    throw new Error(`No readable sprites for style "${styleId}" — ${skipped.length} skipped.`)
  }

  const cellW = Math.max(...sprites.map((s) => s.width))
  const cellH = Math.max(...sprites.map((s) => s.height))
  // Default to a near-square sheet: GPUs and humans both cope better with that
  // than with a 1×N strip.
  const columns = options.columns ?? Math.ceil(Math.sqrt(sprites.length))
  const rows = Math.ceil(sprites.length / columns)

  const sheetW = columns * cellW
  const sheetH = rows * cellH
  // Zero-filled means fully transparent, which is what the gaps should be.
  const rgba = Buffer.alloc(sheetW * sheetH * 4)
  const frames: PackedFrame[] = []

  sprites.forEach((sprite, i) => {
    const ox = (i % columns) * cellW
    const oy = Math.floor(i / columns) * cellH
    for (let y = 0; y < sprite.height; y++) {
      const src = y * sprite.width * 4
      const dst = ((oy + y) * sheetW + ox) * 4
      sprite.pixels.copy(rgba, dst, src, src + sprite.width * 4)
    }
    frames.push({ id: sprite.id, x: ox, y: oy, width: sprite.width, height: sprite.height })
  })

  return {
    png: encodeRgbaPng(sheetW, sheetH, rgba),
    atlas: {
      style: styleId,
      sheet: { width: sheetW, height: sheetH },
      cell: { width: cellW, height: cellH },
      columns,
      frames,
    },
    skipped,
  }
}
