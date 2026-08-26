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
export interface SpriteInput {
  /** The name this sprite is looked up by in the atlas. */
  id: string
  /** Absolute path to the PNG. */
  path: string
}

/**
 * Validates and resolves the JSON contract behind `pack --inputs`.
 *
 * A plain function rather than inline in the CLI so it is testable without
 * spawning the binary: `main()` in cli.ts runs at module load and is not
 * exported, so anything left inline there has no seam a test can reach. This
 * is also the only place that needs to know the file is JSON at all — once it
 * returns, everything downstream just deals in `SpriteInput[]`.
 *
 * `entry.path` resolves relative to `inputsFilePath`'s directory, not the
 * process's cwd, so a caller can write the JSON into a scratch directory
 * without rewriting every entry to be absolute. An already-absolute
 * `entry.path` passes through unchanged, since `path.resolve` discards
 * earlier segments once it hits one.
 */
export function resolvePackInputs(raw: unknown, inputsFilePath: string): SpriteInput[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error("--inputs must be a non-empty JSON array of { id, path }")
  }
  const baseDir = path.dirname(path.resolve(inputsFilePath))
  return raw.map((entry, i) => {
    const e = entry as { id?: unknown; path?: unknown }
    if (typeof e.id !== "string" || typeof e.path !== "string") {
      throw new Error(`--inputs[${i}] needs string "id" and "path"`)
    }
    return { id: e.id, path: path.resolve(baseDir, e.path) }
  })
}

/**
 * The packing primitive: an explicit list of sprites in, one sheet out.
 *
 * Separate from `packStyle` because the lockfile is not the only way to decide
 * what belongs on a sheet. A consumer may draw from several manifests, or key
 * frames by its own vocabulary rather than by pixelkiln asset ids — heybud's
 * review-form icons do both. Keeping the pixel work here and the "which files,
 * called what" decision at the call site avoids teaching this module about
 * anyone else's naming.
 */
export function packSprites(
  inputs: SpriteInput[],
  options: { columns?: number } = {},
): PackedSheet {
  if (!inputs.length) throw new Error("packSprites: no sprites given")

  // Two inputs sharing an id would silently produce two frames under the same
  // key, and a consumer doing `frames.find(f => f.id === x)` gets whichever
  // came first with no signal that the other was dropped. Caught here, before
  // any file I/O, rather than left for the next caller to discover the hard
  // way — heybud's own sync script has to dedupe upstream today for exactly
  // this reason (its archetype sources deliberately overlap).
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const input of inputs) {
    if (seen.has(input.id)) dupes.add(input.id)
    seen.add(input.id)
  }
  if (dupes.size) {
    throw new Error(`packSprites: duplicate sprite id(s): ${[...dupes].join(", ")}`)
  }

  // Sorted by id so the sheet is byte-identical across runs.
  const ordered = [...inputs].sort((a, b) => a.id.localeCompare(b.id))

  const sprites: { id: string; width: number; height: number; pixels: Buffer }[] = []
  const skipped: { id: string; reason: string }[] = []

  for (const input of ordered) {
    try {
      const png = decodePng(readFileSync(input.path))
      sprites.push({ id: input.id, width: png.width, height: png.height, pixels: png.pixels })
    } catch (err) {
      skipped.push({ id: input.id, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  if (!sprites.length) {
    throw new Error(`packSprites: nothing readable — ${skipped.length} skipped.`)
  }

  const cellW = Math.max(...sprites.map((s) => s.width))
  const cellH = Math.max(...sprites.map((s) => s.height))
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
      style: "",
      sheet: { width: sheetW, height: sheetH },
      cell: { width: cellW, height: cellH },
      columns,
      frames,
    },
    skipped,
  }
}

export function packStyle(
  lock: Lock,
  styleId: string,
  manifestDir: string,
  options: { columns?: number } = {},
): PackedSheet {
  // Lock keys are `<styleId>/<assetId>`.
  const prefix = `${styleId}/`
  const entries = Object.entries(lock.entries).filter(([key]) => key.startsWith(prefix))

  if (!entries.length) {
    throw new Error(
      `No locked assets for style "${styleId}". Run \`pixelkiln gen --style ${styleId}\` first.`,
    )
  }

  const inputs: SpriteInput[] = []
  const noOutput: { id: string; reason: string }[] = []

  for (const [key, entry] of entries) {
    const id = key.slice(prefix.length)
    // `outputs` is v2's array; the first is the sprite itself.
    const output = entry.outputs?.[0]
    if (!output) {
      noOutput.push({ id, reason: "no output recorded in the lockfile" })
      continue
    }
    inputs.push({ id, path: path.resolve(manifestDir, output.path) })
  }

  if (!inputs.length) {
    throw new Error(`No readable sprites for style "${styleId}" — ${noOutput.length} skipped.`)
  }

  const packed = packSprites(inputs, options)
  return {
    ...packed,
    atlas: { ...packed.atlas, style: styleId },
    skipped: [...noOutput, ...packed.skipped],
  }
}

export interface MountPlacement extends SpriteInput {
  /** Grid cell this sprite owns, as [column, row]. */
  cell: [number, number]
}

export interface MountedSheet {
  png: Buffer
  atlas: {
    style: string
    sheet: { width: number; height: number }
    cell: { width: number; height: number }
    frames: PackedFrame[]
  }
  skipped: { id: string; reason: string }[]
  /** True when an existing sheet was composited into rather than replaced. */
  overBase: boolean
}

/**
 * Places sprites at *declared* grid cells, optionally into an existing sheet.
 *
 * The sibling of `packSprites`, for the case its layout rules cannot serve.
 * `packSprites` derives position from index and sorts by asset id so the sheet
 * is byte-stable — excellent when pixelkiln owns the whole sheet, and fatal
 * when it does not. A consumer whose atlas coordinates are already load-bearing
 * (a tile engine naming tiles by cell, a scene file storing cell indices in
 * saved data) cannot accept a layout that moves when an asset is added or
 * renamed: every existing reference would silently point at different art.
 *
 * So here the caller declares the cell and pixelkiln honours it. Two
 * consequences worth stating:
 *
 *   - **Only declared cells are touched.** With a `base` sheet, every other
 *     pixel survives byte-for-byte, so a hand-authored sheet can be part
 *     generated and part drawn without the generated half claiming the file.
 *   - **A cell is replaced, not blended.** The sprite owns its cell, so the
 *     cell is cleared first. Compositing instead would make a regenerated
 *     tile show through to whatever it replaced, and the residue would be
 *     invisible until it shipped.
 *
 * Sprites larger than the cell are a declaration error, not something to crop
 * silently — cropping would produce a sheet that looks right in isolation and
 * is wrong at every seam.
 */
export function mountSprites(
  placements: MountPlacement[],
  options: { cellWidth: number; cellHeight: number; basePng?: Buffer },
): MountedSheet {
  if (!placements.length) throw new Error("mountSprites: no sprites given")
  const { cellWidth, cellHeight } = options
  if (cellWidth <= 0 || cellHeight <= 0) {
    throw new Error("mountSprites: cell dimensions must be positive")
  }

  const byCell = new Map<string, string>()
  for (const p of placements) {
    const key = `${p.cell[0]},${p.cell[1]}`
    const owner = byCell.get(key)
    if (owner) {
      throw new Error(
        `mountSprites: "${p.id}" and "${owner}" both claim cell ${key} — ` +
          `a cell has exactly one owner`,
      )
    }
    byCell.set(key, p.id)
  }

  const loaded: { p: MountPlacement; width: number; height: number; pixels: Buffer }[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const p of placements) {
    try {
      const png = decodePng(readFileSync(p.path))
      if (png.width > cellWidth || png.height > cellHeight) {
        throw new Error(
          `is ${png.width}x${png.height}, larger than the ${cellWidth}x${cellHeight} cell`,
        )
      }
      loaded.push({ p, width: png.width, height: png.height, pixels: png.pixels })
    } catch (err) {
      skipped.push({ id: p.id, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  if (!loaded.length) {
    throw new Error(`mountSprites: nothing readable — ${skipped.length} skipped.`)
  }

  // The sheet must cover the base if there is one, and every declared cell
  // either way — a cell past the base's edge grows it rather than failing,
  // so adding a row of tiles does not need the base redrawn first.
  const maxCol = Math.max(...loaded.map((l) => l.p.cell[0]))
  const maxRow = Math.max(...loaded.map((l) => l.p.cell[1]))
  const base = options.basePng ? decodePng(options.basePng) : null
  const sheetW = Math.max((maxCol + 1) * cellWidth, base?.width ?? 0)
  const sheetH = Math.max((maxRow + 1) * cellHeight, base?.height ?? 0)

  const rgba = Buffer.alloc(sheetW * sheetH * 4)
  if (base) {
    for (let y = 0; y < base.height; y++) {
      const src = y * base.width * 4
      base.pixels.copy(rgba, y * sheetW * 4, src, src + base.width * 4)
    }
  }

  const frames: PackedFrame[] = []
  for (const { p, width, height, pixels } of loaded) {
    const ox = p.cell[0] * cellWidth
    const oy = p.cell[1] * cellHeight
    // Clear the whole cell before writing: the sprite owns it, and leaving the
    // base showing around a smaller sprite is the "invisible until it ships"
    // failure this function exists to avoid.
    for (let y = 0; y < cellHeight; y++) {
      rgba.fill(0, ((oy + y) * sheetW + ox) * 4, ((oy + y) * sheetW + ox + cellWidth) * 4)
    }
    for (let y = 0; y < height; y++) {
      const src = y * width * 4
      pixels.copy(rgba, ((oy + y) * sheetW + ox) * 4, src, src + width * 4)
    }
    frames.push({ id: p.id, x: ox, y: oy, width, height })
  }

  frames.sort((a, b) => a.y - b.y || a.x - b.x)
  return {
    png: encodeRgbaPng(sheetW, sheetH, rgba),
    atlas: {
      style: "",
      sheet: { width: sheetW, height: sheetH },
      cell: { width: cellWidth, height: cellHeight },
      frames,
    },
    skipped,
    overBase: base !== null,
  }
}

/**
 * `mountSprites` driven by the lockfile and the manifest's `mount` block.
 *
 * The manifest is the source of cells rather than the lockfile: a cell is a
 * declaration about where art belongs, not a record of what was generated, and
 * it has to be readable and editable before anything has been generated at all.
 */
export function mountStyle(
  lock: Lock,
  styleId: string,
  manifestDir: string,
  mount: { base?: string; cellWidth: number; cellHeight: number },
  cells: Record<string, [number, number]>,
  sources: Record<string, string> = {},
): MountedSheet {
  // Driven by the declared cells, not by the lockfile. The cell is what says
  // "this belongs on the sheet"; whether pixelkiln generated the pixels is a
  // separate question, and `source` assets answer it with a file on disk.
  const ids = Object.keys(cells)
  if (!ids.length) {
    throw new Error(
      `No assets in style "${styleId}" declare a \`cell\`. Add one to each asset ` +
        `that belongs on the sheet.`,
    )
  }

  const placements: MountPlacement[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const id of ids) {
    const cell = cells[id]!
    const source = sources[id]
    if (source) {
      placements.push({ id, path: path.resolve(manifestDir, source), cell })
      continue
    }
    const entry = lock.entries[`${styleId}/${id}`]
    if (!entry) {
      skipped.push({
        id,
        reason: `not generated in style "${styleId}", and no \`source\` declared`,
      })
      continue
    }
    const output = entry.outputs?.[0]
    if (!output) {
      skipped.push({ id, reason: "no output recorded in the lockfile" })
      continue
    }
    placements.push({ id, path: path.resolve(manifestDir, output.path), cell })
  }

  if (!placements.length) {
    throw new Error(
      `Nothing to mount for style "${styleId}": ${ids.length} asset(s) declare a ` +
        `cell, but none has generated output or a \`source\`. Run ` +
        `\`pixelkiln gen --style ${styleId}\`, or point each at a file.`,
    )
  }

  const basePng = mount.base ? readFileSync(path.resolve(manifestDir, mount.base)) : undefined
  const mounted = mountSprites(placements, {
    cellWidth: mount.cellWidth,
    cellHeight: mount.cellHeight,
    basePng,
  })
  return {
    ...mounted,
    atlas: { ...mounted.atlas, style: styleId },
    skipped: [...skipped, ...mounted.skipped],
  }
}
