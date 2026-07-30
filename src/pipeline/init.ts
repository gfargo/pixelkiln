import { readdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import type { Generator, Manifest } from "../types.ts"

/** Minimal PNG header read — avoids pulling in an image library just for dimensions. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  const isPng = buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a
  if (!isPng) return null
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** Path segment → a stable, readable asset id. */
export function slugify(value: string): string {
  return value
    .replace(/\.png$/i, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
}

export interface ScannedAsset {
  id: string
  category: string
  file: string
  width: number
  height: number
}

async function walk(dir: string, exclude: string[]): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (exclude.some((x) => full.includes(x))) continue
    if (entry.isDirectory()) out.push(...(await walk(full, exclude)))
    else if (entry.name.toLowerCase().endsWith(".png")) out.push(full)
  }
  return out
}

/**
 * Scans an existing asset tree and produces manifest entries for it.
 *
 * Prompts are left empty on purpose. For a project whose art already exists,
 * the accurate prompts are the ones actually used upstream — `adopt
 * --write-prompts` recovers those from the matched objects rather than having
 * anyone invent plausible-looking replacements.
 */
export async function scanAssets(
  root: string,
  opts: { exclude?: string[] } = {},
): Promise<{ assets: ScannedAsset[]; skipped: string[] }> {
  const exclude = opts.exclude ?? []
  const files = await walk(root, exclude)
  const assets: ScannedAsset[] = []
  const skipped: string[] = []
  const seen = new Map<string, number>()

  for (const file of files.sort()) {
    const size = pngSize(await readFile(file))
    if (!size) {
      skipped.push(`${file} (not a readable PNG)`)
      continue
    }
    const rel = path.relative(root, file)
    const category = path.dirname(rel) === "." ? "" : path.dirname(rel)
    let id = slugify(path.basename(rel))

    // Basenames repeat across category folders; disambiguate rather than collide.
    if (seen.has(id)) {
      const n = seen.get(id)! + 1
      seen.set(id, n)
      id = `${slugify(category.replace(/[/\\]/g, "_"))}_${id}`.replace(/^_+/, "")
    } else {
      seen.set(id, 1)
    }

    assets.push({ id, category, file: rel, width: size.width, height: size.height })
  }

  return { assets, skipped }
}

export function buildManifest(
  name: string,
  styleId: string,
  generator: Generator,
  outDir: string,
  scanned: ScannedAsset[],
): Manifest {
  const squares = scanned.filter((a) => a.width === a.height)
  const commonSize = squares.length ? mode(squares.map((a) => a.width)) : 64

  const assets: Manifest["assets"] = {}
  for (const asset of scanned) {
    assets[asset.id] = {
      prompt: "",
      promptByStyle: {},
      category: asset.category || undefined,
      file: asset.file,
      tags: [],
      styles: [],
      ...(generator === "map"
        ? { width: asset.width, height: asset.height }
        : asset.width === asset.height && asset.width !== commonSize
          ? { size: asset.width }
          : {}),
    }
  }

  return {
    name,
    styles: {
      [styleId]: {
        generator,
        size: commonSize,
        promptPrefix: "",
        promptSuffix: "",
        styleImages: [],
        outDir,
        tags: [name],
      },
    },
    assets,
  }
}

function mode(values: number[]): number {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 64
}

export async function writeManifestFile(target: string, manifest: Manifest): Promise<void> {
  if (existsSync(target)) {
    throw new Error(`${target} already exists — refusing to overwrite an existing manifest.`)
  }
  await writeFile(target, JSON.stringify(manifest, null, 2) + "\n")
}
