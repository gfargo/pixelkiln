/** Regenerates the manifest/workspace JSON Schemas from the zod types so they cannot drift. */
import { writeFileSync } from "node:fs"
import { zodToJsonSchema } from "zod-to-json-schema"
import { ManifestInputSchema } from "../src/types.ts"
import { WorkspaceSchema } from "../src/workspace.ts"
import { RecipeSchema } from "../src/recipes.ts"
import { QualityBaselineSchema } from "../src/pipeline/quality-regression.ts"

const manifestSchema = zodToJsonSchema(ManifestInputSchema, {
  name: "PixelkilnManifest",
  $refStrategy: "none",
})
writeFileSync("schema/manifest.schema.json", JSON.stringify(manifestSchema, null, 2) + "\n")
console.log("wrote schema/manifest.schema.json")

const workspaceSchema = zodToJsonSchema(WorkspaceSchema, {
  name: "PixelkilnWorkspace",
  $refStrategy: "none",
})
writeFileSync("schema/workspace.schema.json", JSON.stringify(workspaceSchema, null, 2) + "\n")
console.log("wrote schema/workspace.schema.json")

const recipeSchema = zodToJsonSchema(RecipeSchema, {
  name: "PixelkilnRecipe",
  $refStrategy: "none",
})
writeFileSync("schema/recipe.schema.json", JSON.stringify(recipeSchema, null, 2) + "\n")
console.log("wrote schema/recipe.schema.json")

const qualityBaselineSchema = zodToJsonSchema(QualityBaselineSchema, {
  name: "PixelkilnQualityBaseline",
  $refStrategy: "none",
})
writeFileSync(
  "schema/quality-baseline.schema.json",
  JSON.stringify(qualityBaselineSchema, null, 2) + "\n",
)
console.log("wrote schema/quality-baseline.schema.json")
