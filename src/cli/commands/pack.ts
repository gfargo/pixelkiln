/** Packaging: pack, mount, export. */
import path from "node:path"
import { readFile } from "node:fs/promises"
import { resolveSpecs } from "../../manifest.ts"
import { mountStyle, packSprites, packStyle, resolvePackInputs } from "../../pipeline/pack.ts"
import { lockKey } from "../../types.ts"
import { qualityRecordPath } from "../../pipeline/refine.ts"
import { requireApprovedQualitySources } from "../../pipeline/quality-profile.ts"
import { exportTileset, type TilesetFormat } from "../../pipeline/tileset-export.ts"
import { writeManagedArtifactBundle, type ArtifactFile } from "../../artifacts.ts"
import { renderSheetDocument, SHEET_FORMATS, type SheetFormat } from "../../pipeline/sheet-formats.ts"
import { openProject, manifestSources, provenanceFile } from "../project.ts"
import { log } from "../io.ts"
import type { Args } from "../args.ts"

export async function runPack(args: Args): Promise<void> {
  if (args.inputs) {
    // Handled before the manifest-required check below, deliberately: the
    // whole point of `--inputs` is packing sprites that were never part of a
    // pixelkiln manifest at all. Requiring one anyway, as this did until a
    // manual smoke test caught it, defeated the feature for exactly the
    // no-manifest consumer it was built for; heybud-admin's sync script never
    // noticed because it happens to run from a directory that has its own
    // manifest for an unrelated reason.
    if (!args.out) throw new Error("--inputs requires --out")
    if (args.primaryOnly || args.outputRoles.length) {
      throw new Error("--primary-only and --output-role require manifest-driven pack")
    }

    const raw = JSON.parse(await readFile(path.resolve(args.inputs), "utf8")) as unknown
    const inputs = resolvePackInputs(raw, args.inputs)

    const { png, atlas, skipped, sources } = packSprites(inputs, { columns: args.columns })
    const format = sheetFormat(args)
    const base = path.resolve(args.out.replace(/\.(?:png|json|tres)$/i, ""))
    const { extension, document } = renderSheetDocument(format, atlas, { imageName: path.basename(`${base}.png`) })
    const outputs: ArtifactFile[] = [
      { path: `${base}.png`, data: png },
      { path: `${base}${extension}`, data: document },
    ]
    await writeManagedArtifactBundle(`${base}.pixelkiln.json`, outputs, {
      kind: "pack",
      sources: [await provenanceFile("$inputs", args.inputs), ...sources],
      options: { columns: args.columns ?? null, format, order: "id", style: null },
    }, { force: args.force })
    log(
      `  ${atlas.frames.length} sprite(s), ${atlas.sheet.width}x${atlas.sheet.height} ` +
        `in ${atlas.columns} column(s), ${(png.length / 1024).toFixed(1)} KB (${format})`,
    )
    log(`    ${path.relative(process.cwd(), base)}.png + ${extension} + .pixelkiln.json`)
    for (const s of skipped) log(`    skipped ${s.id}: ${s.reason}`)
    return
  }

  const { loaded, lock } = await openProject(args)
  // The --inputs form is handled earlier, before the manifest is required
  // at all; reaching here means the manifest-driven (lockfile) form.
  if (args.primaryOnly && args.outputRoles.length) {
    throw new Error("pack accepts either --primary-only or --output-role, not both")
  }
  const manifestDir = path.dirname(path.resolve(args.manifest))
  const styleIds = args.styles.length ? args.styles : Object.keys(loaded.manifest.styles)

  for (const styleId of styleIds) {
    // A character's rotations, states, and animations are meant to stand on
    // one floor; a v3 loop with an `endFrame` can come back taller than the
    // rotations, so a character style's frames pivot bottom-centre instead
    // of the default top-left (see `packSprites` in pipeline/pack.ts).
    const style = loaded.manifest.styles[styleId]
    const pivot = style?.generator === "character" ? "bottom-center" : "top-left"
    const packagingSpecs = await resolveSpecs(loaded, { styles: [styleId] })
    const qualitySources = await requireApprovedQualitySources(packagingSpecs, lock)
    const { png, atlas, skipped, sources } = packStyle(lock, styleId, manifestDir, {
      columns: args.columns,
      outputRoles: args.outputRoles,
      primaryOnly: args.primaryOnly,
      pivot,
      sourceOverrides: qualitySources,
      sources: manifestSources(loaded.manifest, styleId),
    })

    // Default beside the style's own output tree, so sheets for different
    // styles cannot overwrite each other when --out is omitted.
    const base = args.out
      ? path.resolve(args.out.replace(/\.(?:png|json|tres)$/i, ""))
      : path.resolve(manifestDir, style!.outDir, `${styleId}-sheet`)
    const format = sheetFormat(args)
    const { extension, document } = renderSheetDocument(format, atlas, { imageName: path.basename(`${base}.png`) })

    const outputs: ArtifactFile[] = [
      { path: `${base}.png`, data: png },
      { path: `${base}${extension}`, data: document },
    ]
    const qualityRecords = qualitySources
      ? await Promise.all(
          packagingSpecs.filter((spec) => spec.quality).map((spec) =>
            provenanceFile(
              `$quality/${spec.assetId}`,
              qualityRecordPath(spec.quality!.outFile),
            )),
        )
      : []
    await writeManagedArtifactBundle(`${base}.pixelkiln.json`, outputs, {
      kind: "pack",
      sources: [
        await provenanceFile("$manifest", args.manifest),
        await provenanceFile("$lock", args.lock),
        ...qualityRecords,
        ...sources,
      ],
      options: {
        columns: args.columns ?? null,
        format,
        order: "id",
        outputRoles: [...args.outputRoles].sort(),
        pivot,
        primaryOnly: args.primaryOnly,
        style: styleId,
      },
    }, { force: args.force })

    log(
      `  ${styleId}: ${atlas.frames.length} sprite(s), ` +
        `${atlas.sheet.width}x${atlas.sheet.height} in ${atlas.columns} column(s)` +
        (atlas.sets?.length ? `, ${atlas.sets.length} set(s)` : "") + ` (${format})`,
    )
    log(`    ${path.relative(process.cwd(), base)}.png + ${extension} + .pixelkiln.json`)
    for (const s of skipped) log(`    skipped ${s.id}: ${s.reason}`)
  }
}

export async function runMount(args: Args): Promise<void> {
  const { loaded, lock } = await openProject(args)
  const manifestDir = path.dirname(path.resolve(args.manifest))
  const styleIds = args.styles.length ? args.styles : Object.keys(loaded.manifest.styles)

  for (const styleId of styleIds) {
    const style = loaded.manifest.styles[styleId]
    if (!style?.mount) {
      // Not an error when the caller did not name a style; `mount` with no
      // --style should do the mounted ones and stay quiet about the rest.
      if (args.styles.length) {
        throw new Error(
          `Style "${styleId}" has no \`mount\` block. Add one, or use \`pack\` ` +
            `to let pixelkiln choose the layout.`,
        )
      }
      continue
    }

    const cells: Record<string, [number, number]> = {}
    const sources: Record<string, string> = {}
    const outputRoles: Record<string, string> = {}
    const styleSources = manifestSources(loaded.manifest, styleId)
    for (const [assetId, asset] of Object.entries(loaded.manifest.assets)) {
      if (!asset.cell) continue
      cells[assetId] = asset.cell
      if (styleSources[assetId]) sources[assetId] = styleSources[assetId]!
      if (asset.outputRole) outputRoles[assetId] = asset.outputRole
    }
    const packagingSpecs = await resolveSpecs(loaded, { styles: [styleId] })
    const qualitySources = await requireApprovedQualitySources(
      packagingSpecs,
      lock,
      new Set(Object.keys(cells)),
      outputRoles,
    )
    if (qualitySources) Object.assign(sources, qualitySources)

    const { png, atlas, skipped, overBase, sources: artifactSources } = mountStyle(
      lock,
      styleId,
      manifestDir,
      style.mount,
      cells,
      sources,
      outputRoles,
    )

    const out = path.resolve(manifestDir, style.mount.out)
    const format = sheetFormat(args)
    const { extension, document } = renderSheetDocument(format, atlas, { imageName: path.basename(out) })
    const metadata = out.replace(/\.png$/, "") + extension
    const companion = out.replace(/\.png$/, "") + ".pixelkiln.json"
    const outputs: ArtifactFile[] = [
      { path: out, data: png },
      { path: metadata, data: document },
    ]
    const qualityRecords = qualitySources
      ? await Promise.all(
          packagingSpecs
            .filter((spec) => spec.quality && Object.hasOwn(cells, spec.assetId))
            .map((spec) =>
              provenanceFile(
                `$quality/${spec.assetId}`,
                qualityRecordPath(spec.quality!.outFile),
              )),
        )
      : []
    await writeManagedArtifactBundle(companion, outputs, {
      kind: "mount",
      sources: [
        await provenanceFile("$manifest", args.manifest),
        await provenanceFile("$lock", args.lock),
        ...qualityRecords,
        ...artifactSources.filter(
          (source) => source.id !== "$base" || path.resolve(source.path) !== out,
        ),
      ],
      options: {
        cellHeight: style.mount.cellHeight,
        cellWidth: style.mount.cellWidth,
        cells: Object.entries(cells).sort(([a], [b]) => a.localeCompare(b)),
        format,
        style: styleId,
      },
    }, { force: args.force })

    log(
      `  ${styleId}: ${atlas.frames.length} cell(s) into ` +
        `${atlas.sheet.width}x${atlas.sheet.height}` +
        (overBase ? ` over ${style.mount.base}` : " (new sheet)"),
    )
    log(`    ${path.relative(process.cwd(), out)} + atlas/provenance JSON`)
    for (const s of skipped) log(`    skipped ${s.id}: ${s.reason}`)
  }
}

export async function runExport(args: Args): Promise<void> {
  const { loaded, specs, lock } = await openProject(args)
  const format = (args.format ?? "generic") as TilesetFormat
  const manifestDir = path.dirname(path.resolve(args.manifest))
  const selected = specs.filter((spec) => {
    if (spec.generator !== "tiles") return false
    if (args.styles.length && !args.styles.includes(spec.styleId)) return false
    if (args.assets.length && !args.assets.includes(spec.assetId)) return false
    return Boolean(lock.entries[lockKey(spec.styleId, spec.assetId)])
  })
  if (!selected.length) {
    throw new Error("No downloaded tiles entries match the requested --style/--only filters.")
  }
  if (args.out && selected.length > 1) {
    throw new Error("--out can name one tileset only; add --style/--only to select one asset.")
  }

  for (const spec of selected) {
    const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]!
    const style = loaded.manifest.styles[spec.styleId]!
    const defaultBase = path.resolve(manifestDir, style.outDir, `${spec.assetId}-tileset`)
    const base = args.out
      ? path.resolve(args.out.replace(/\.(?:png|json|tsj|tres)$/i, ""))
      : defaultBase
    const result = exportTileset(entry, spec, {
      format,
      manifestDir,
      imageName: path.basename(`${base}.png`),
      columns: args.columns,
    })
    const outputs: ArtifactFile[] = [
      { path: `${base}.png`, data: result.png },
      { path: `${base}${result.extension}`, data: result.document },
    ]
    await writeManagedArtifactBundle(`${base}.pixelkiln.json`, outputs, {
      kind: "tileset",
      sources: [
        await provenanceFile("$manifest", args.manifest),
        await provenanceFile("$lock", args.lock),
        ...result.sources,
      ],
      options: {
        asset: spec.assetId,
        columns: args.columns ?? null,
        format,
        image: path.basename(`${base}.png`),
        providerRules: result.generic.providerRules,
        style: spec.styleId,
        tileType: spec.tileType ?? null,
      },
    }, { force: args.force })
    log(
      `  ${spec.styleId}/${spec.assetId}: ${result.generic.tiles.length} tile(s), ` +
        `${result.generic.sheet.width}x${result.generic.sheet.height} (${format})`,
    )
    log(
      `    ${path.relative(process.cwd(), base)}.png + ` +
        `${path.basename(base)}${result.extension} + .pixelkiln.json`,
    )
  }
}

/** The sheet document format asked for; the parser already rejected tileset-only values. */
function sheetFormat(args: Pick<Args, "format">): SheetFormat {
  const format = args.format ?? "generic"
  if (!(SHEET_FORMATS as readonly string[]).includes(format)) {
    throw new Error(`--format ${format} is for export; sheets take ${SHEET_FORMATS.join(", ")}`)
  }
  return format as SheetFormat
}
