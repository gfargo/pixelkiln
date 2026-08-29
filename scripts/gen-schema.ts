/** Regenerates the manifest/workspace JSON Schemas from the zod types so they cannot drift. */
import { writeFileSync } from "node:fs"
import { zodToJsonSchema } from "zod-to-json-schema"
import { ManifestSchema } from "../src/types.ts"
import { WorkspaceSchema } from "../src/workspace.ts"

const manifestSchema = zodToJsonSchema(ManifestSchema, {
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
