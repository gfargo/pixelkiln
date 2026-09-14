/** `recipe list|inspect|install|verify`: bundled ComfyUI recipes. */
import path from "node:path"
import { installRecipe, listBundledRecipes, resolveRecipe, verifyRecipe } from "../../recipes.ts"

import { log } from "../io.ts"
import type { Args } from "../args.ts"

export async function runRecipe(args: Args): Promise<void> {
  if (args.subcommand === "list") {
    const recipes = await listBundledRecipes()
    if (args.json) {
      log(JSON.stringify({
        version: 1,
        recipes: recipes.map(({ recipe }) => ({
          id: recipe.id,
          version: recipe.version,
          provider: recipe.provider,
          summary: recipe.summary,
          selector: `${recipe.id}@${recipe.version}`,
        })),
      }, null, 2))
    } else {
      log(`  ${recipes.length} bundled recipe(s):`)
      for (const { recipe } of recipes) {
        log(`    ${(recipe.id + "@" + recipe.version).padEnd(52)} ${recipe.summary}`)
      }
    }
    return
  }

  const target = args.target!
  if (args.subcommand === "inspect") {
    const { recipe, path: recipePath, bundled } = await resolveRecipe(target)
    if (args.json) {
      log(JSON.stringify({ ...recipe, path: recipePath, bundled }, null, 2))
    } else {
      log(`  ${recipe.id}@${recipe.version}`)
      log(`  ${recipe.summary}`)
      log(`  provider: ${recipe.provider} · style: ${recipe.styleId} · stage: ${recipe.quality.stage}`)
      log(
        `  native target: ${recipe.quality.recommendedNativeSize.min}–` +
          `${recipe.quality.recommendedNativeSize.max}px · palette: ` +
          `${recipe.quality.paletteColors.min}–${recipe.quality.paletteColors.max} colors`,
      )
      if (recipe.workflow) log(`  workflow: ${recipe.workflow.path} · ${recipe.workflow.numImages} candidate(s)`)
      for (const model of recipe.models) log(`  model: ${model.path} · ${model.license}`)
      log(`  source: ${recipePath}${bundled ? " (bundled)" : ""}`)
    }
    return
  }

  if (args.subcommand === "verify") {
    const report = await verifyRecipe(target, { modelRoot: args.modelRoot })
    if (args.json) {
      log(JSON.stringify(report, null, 2))
    } else {
      log(`  ${report.ok ? "ok" : "ERROR"}  ${report.recipe.id}@${report.recipe.version}`)
      log(`  ${report.integrity.status.padEnd(9)} recipe metadata`)
      for (const file of report.files) log(`  ${file.status.padEnd(9)} ${file.path}`)
      for (const model of report.models) log(`  ${model.status.padEnd(9)} ${model.path}`)
      if (!report.modelRoot && report.models.length) {
        log(`  models were not checked; pass --model-root <ComfyUI/models> to verify this workstation`)
      }
    }
    if (!report.ok) process.exitCode = 1
    return
  }

  if (args.subcommand === "install") {
    const result = await installRecipe(target, { out: args.out, force: args.force })
    if (args.json) {
      log(JSON.stringify({
        version: 1,
        recipe: `${result.recipe.id}@${result.recipe.version}`,
        destination: result.destination,
        changed: result.changed,
        unchanged: result.unchanged,
        styleId: result.styleId,
        style: result.style,
      }, null, 2))
    } else {
      log(`  installed ${result.recipe.id}@${result.recipe.version}`)
      log(`  ${path.relative(process.cwd(), result.destination) || "."}`)
      log(`\n  Add this entry under your manifest's styles object:`)
      log(JSON.stringify({ [result.styleId]: result.style }, null, 2))
      if (result.recipe.models.length) {
        log(`\n  Models are not downloaded automatically. Verify them with:`)
        log(`  pixelkiln recipe verify ${path.relative(process.cwd(), result.destination)} --model-root <ComfyUI/models>`)
      }
    }
    return
  }
}
