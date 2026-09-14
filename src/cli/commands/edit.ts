/** `edit`: start or detach a hand edit of one asset. */
import path from "node:path"
import { detachHandEdit, openInEditor, startHandEdit } from "../../pipeline/hand-edit.ts"
import { openProject } from "../project.ts"
import { log } from "../io.ts"
import type { Args } from "../args.ts"

export async function runEdit(args: Args): Promise<void> {
  const { loaded, specs, lock } = await openProject(args)
  if (!args.assets.length) throw new Error("edit needs --only <asset id> (and --style when the asset is in several styles).")
  if (specs.length !== 1) {
    throw new Error(
      specs.length
        ? `edit works on one asset in one style; --only ${args.assets.join(",")} resolves to ${specs.length}: ` +
          specs.map((spec) => `${spec.styleId}/${spec.assetId}`).join(", ") + ". Add --style."
        : "edit matched no asset.",
    )
  }
  const spec = specs[0]!
  if (args.subcommand === "detach") {
    const result = await detachHandEdit(loaded, spec)
    log(result.changed
      ? `  detached the hand edit for ${spec.styleId}/${spec.assetId}; the generated art is placed again (the edit file is kept)`
      : `  ${spec.styleId}/${spec.assetId} has no hand edit`)
    return
  }
  const started = await startHandEdit(loaded, lock, spec)
  const set = started.members.length > 1
  const kind = spec.generator === "frames" ? "frames" : "members"
  log(`  ${started.created ? "created" : "found"} ${started.source}${set ? ` (${started.members.length} ${kind})` : ""}${started.declared ? " and declared it as the asset's source" : ""}`)
  if (set) for (const member of started.members) log(`    ${member.role ?? ""}  ${path.relative(process.cwd(), member.path)}`)
  if (args.noOpen) {
    log(`  edit ${set ? "them" : "it"} with your own tool, then run pixelkiln plan; mount and pack place ${set ? "them" : "it"} in place of the generated art`)
  } else {
    // A desktop editor opens one file; a set's first frame is the way in.
    const command = openInEditor(started.members[0]!.path)
    log(`  opened ${set ? `the first ${kind === "frames" ? "frame" : "member"} ` : ""}with: ${command}${process.env.PIXELKILN_EDITOR ? "" : " (set PIXELKILN_EDITOR to choose the program)"}`)
  }
}
