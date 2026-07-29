/** Regenerates the manifest JSON Schema from the zod types so the two cannot drift. */
import { writeFileSync } from "node:fs"
import { zodToJsonSchema } from "zod-to-json-schema"
import { ManifestSchema } from "../src/types.ts"

const schema = zodToJsonSchema(ManifestSchema, {
  name: "SpritesmithManifest",
  $refStrategy: "none",
})
writeFileSync("schema/manifest.schema.json", JSON.stringify(schema, null, 2) + "\n")
console.log("wrote schema/manifest.schema.json")
