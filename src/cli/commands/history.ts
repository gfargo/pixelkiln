/** `history` and `restore --generation`: replaced generations and bringing one back. */
import { createProvider } from "../../providers/registry.ts"
import { lockKey } from "../../types.ts"
import { historyLimit, revertGeneration } from "../../pipeline/history.ts"
import { formatCost } from "../../provider.ts"
import { openProject } from "../project.ts"
import { log } from "../io.ts"
import type { Args } from "../args.ts"

/** ` (billed N)` when the provider's actual charge differs from the estimate; blank otherwise. */
function billedNote(cost: number, costUnit: string, billed: { amount: number; unit: string } | null): string {
  if (!billed || (billed.unit === costUnit && billed.amount === cost)) return ""
  return `  (billed ${formatCost(billed.unit, billed.amount)})`
}

export async function runHistory(args: Args): Promise<void> {
  const { loaded, specs, lock } = await openProject(args)
  const limit = historyLimit(loaded.manifest)
  const selected = specs.map((spec) => ({ spec, entry: lock.entries[lockKey(spec.styleId, spec.assetId)] }))
  if (args.json) {
    log(JSON.stringify({
      version: 1,
      limit,
      assets: selected.map(({ spec, entry }) => ({
        key: lockKey(spec.styleId, spec.assetId),
        current: entry ? { objectId: entry.objectId, outputs: entry.outputs, downloadedAt: entry.downloadedAt, cost: entry.cost, costUnit: entry.costUnit, billed: entry.billed } : null,
        history: entry?.history ?? [],
      })),
    }, null, 2))
    return
  }
  log(`  keeping up to ${limit} replaced generation${limit === 1 ? "" : "s"} per asset` +
    (loaded.manifest.history !== undefined ? " (manifest history)" : ` (${process.env.PIXELKILN_HISTORY ? "PIXELKILN_HISTORY" : "default; set PIXELKILN_HISTORY or manifest history"})`))
  let shown = 0
  for (const { spec, entry } of selected) {
    if (!entry?.history?.length) continue
    shown++
    const key = lockKey(spec.styleId, spec.assetId)
    log(`\n  ${key}`)
    log(`    current  ${entry.outputs[0]?.sha256.slice(0, 12) ?? "—"}  ${entry.downloadedAt ?? ""}  ${entry.objectId ?? ""}${billedNote(entry.cost, entry.costUnit, entry.billed)}`)
    for (const [i, generation] of entry.history.entries()) {
      const changed = generation.prompt !== entry.prompt ? "  (different prompt)" : ""
      log(`    #${String(i + 1).padEnd(2)}      ${generation.outputs[0]?.sha256.slice(0, 12) ?? "—"}  ${generation.downloadedAt ?? ""}  ${generation.objectId ?? ""}${changed}${billedNote(generation.cost, generation.costUnit, generation.billed)}`)
    }
  }
  if (!shown) log(`  no asset has a previous generation recorded${selected.length ? "" : " (nothing selected)"}`)
  else log(`\n  bring one back: pixelkiln restore --only <asset> --style <style> --generation <n|hash>`)
}

export async function runRestoreGeneration(args: Args): Promise<void> {
  const { specs, lock } = await openProject(args)
  if (specs.length !== 1) {
    throw new Error(
      specs.length
        ? `restore --generation works on one asset; --only/--style select ${specs.length}. Add --style or narrow --only.`
        : "restore --generation matched no asset; pass --only <asset id> (and --style when it is in several styles).",
    )
  }
  const spec = specs[0]!
  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  if (!entry) throw new Error(`${spec.styleId}/${spec.assetId} is not in the lockfile`)
  const provider = createProvider(entry.provider, "downloads")
  const result = await revertGeneration(provider, spec, lock, args.lock, {
    generation: args.generation!,
    force: args.force,
    onProgress: log,
  })
  log(`\n  restored generation #${result.index} of ${spec.styleId}/${spec.assetId}` +
    `${result.restored.objectId ? ` (${result.restored.objectId})` : ""}; the replaced one is now #1 in its history`)
  log(`  lockfile written: ${args.lock}`)
}
