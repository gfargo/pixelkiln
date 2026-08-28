import { writeManagedArtifactBundle } from "../../src/artifacts.ts"

const [mode, manifestPath, first, second] = process.argv.slice(2)
if (!mode || !manifestPath || !first || !second) process.exit(2)

await writeManagedArtifactBundle(
  manifestPath,
  [
    { path: first, data: "new first" },
    { path: second, data: "new second" },
  ],
  { kind: "pack", sources: [], options: { revision: 2 } },
  mode === "during-promotion"
    ? {
        beforePromote: (_destination, index) => {
          if (index === 1) process.exit(86)
        },
      }
    : {
        afterCommit: () => process.exit(87),
      },
)
