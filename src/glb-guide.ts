import { readAccessor, type GlbDocument, type GltfJson } from "./glb.ts"

/**
 * Make an automatic unwrap legible. A generated model's texture is its
 * surface cut into dozens of pieces packed into a square, and nothing in the
 * flat picture says which piece is the left forearm. The mesh does: every
 * vertex carries its place on the texture (`TEXCOORD_0`) and the bones that
 * move it (`JOINTS_0`, `WEIGHTS_0`). This module finds the pieces of one
 * texture, names each after the bone that holds most of it, and returns
 * their outlines, for a guide layer drawn over the texture in an editor.
 *
 * Coordinates are texture space as glTF stores it: u to the right, v down,
 * both 0 to 1, so `u * width` and `v * height` are pixels.
 */
export interface UvPiece {
  /** Position in the returned list, largest piece first. */
  id: number
  /** Body region, in words: "Left lower arm". */
  region: string
  /** The bone that holds most of the piece; null for a mesh without a skin. */
  bone: string | null
  /** Which way the surface faces at rest, from its normals: "front", "back", "left", "right", "top", "underside"; null without normals. */
  facing: string | null
  /** Every mesh that draws part of this piece. */
  meshes: string[]
  /** [minU, minV, maxU, maxV] */
  bounds: [number, number, number, number]
  /** Area in texture space; 1 is the whole texture. */
  area: number
  /** A point inside the piece, for a label. */
  anchor: [number, number]
  /** Outline as line segments, four numbers each: u1, v1, u2, v2. */
  outline: number[]
  triangles: number
}

export interface UvGuide {
  pieces: UvPiece[]
  /** Regions present, by the area they cover, largest first. */
  regions: string[]
}

/**
 * A bone or mesh name as a person would say it: `LeftLowerArm` and
 * `lower_arm.L` both become "Left lower arm". Rig prefixes (`mixamorig:`,
 * `DEF-`) are dropped.
 */
export function regionName(name: string): string {
  let text = name.trim().replace(/^.*[:|]/, "").replace(/^(DEF|ORG|MCH)[-_]/i, "")
  let side = ""
  const suffix = /[._\- ](l|r|left|right)$/i.exec(text)
  if (suffix) {
    side = suffix[1]!.toLowerCase().startsWith("l") ? "left" : "right"
    text = text.slice(0, suffix.index)
  }
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.\-]+/g, " ")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!side && (words[0] === "left" || words[0] === "right" || words[0] === "l" || words[0] === "r") && words.length > 1) {
    side = words.shift()!.startsWith("l") ? "left" : "right"
  }
  const phrase = [side, ...words].filter(Boolean).join(" ") || name.trim() || "piece"
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/** Every primitive drawn with a material whose base colour (or any) texture is this image. */
function primitivesUsingImage(json: GltfJson, imageIndex: number): Array<{ mesh: number; primitive: number }> {
  const materials = new Set<number>()
  for (const [index, material] of (json.materials ?? []).entries()) {
    const infos = [
      material.pbrMetallicRoughness?.baseColorTexture,
      material.pbrMetallicRoughness?.metallicRoughnessTexture,
      material.normalTexture,
      material.occlusionTexture,
      material.emissiveTexture,
    ]
    if (infos.some((info) => info && json.textures?.[info.index]?.source === imageIndex)) materials.add(index)
  }
  const found: Array<{ mesh: number; primitive: number }> = []
  for (const [meshIndex, mesh] of (json.meshes ?? []).entries()) {
    for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
      if (typeof primitive.material === "number" && materials.has(primitive.material) && (primitive.mode ?? 4) === 4) {
        found.push({ mesh: meshIndex, primitive: primitiveIndex })
      }
    }
  }
  return found
}

/** How finely texture coordinates are compared: two vertices this close are the same point of the unwrap. */
const WELD = 1 << 16

/**
 * The pieces of one texture. Vertices are joined by where they sit on the
 * texture, across every mesh that uses it, so a body split into several
 * meshes over one unwrap still gives one piece per cut of the surface, not
 * one per mesh.
 */
export function uvGuide(document: GlbDocument, imageIndex: number): UvGuide {
  const json = document.json
  const pointOf = new Map<number, number>()
  const us: number[] = []
  const vs: number[] = []
  const parent: number[] = []
  const find = (a: number): number => {
    let root = a
    while (parent[root] !== root) root = parent[root]!
    while (parent[a] !== root) { const next = parent[a]!; parent[a] = root; a = next }
    return root
  }
  interface Triangle { a: number; b: number; c: number; area: number; mesh: string; bones: Array<[string, number]>; normal: [number, number, number] }
  const triangles: Triangle[] = []

  for (const { mesh: meshIndex, primitive: primitiveIndex } of primitivesUsingImage(json, imageIndex)) {
    const mesh = json.meshes![meshIndex]!
    const primitive = mesh.primitives[primitiveIndex]!
    const meshName = mesh.name ?? `mesh ${meshIndex}`
    if (typeof primitive.attributes.TEXCOORD_0 !== "number") continue
    const uv = readAccessor(document, primitive.attributes.TEXCOORD_0)
    if (uv.size < 2) continue
    const indices = typeof primitive.indices === "number"
      ? readAccessor(document, primitive.indices).data
      : Uint32Array.from({ length: uv.count }, (_, index) => index)
    const joints = typeof primitive.attributes.JOINTS_0 === "number" ? readAccessor(document, primitive.attributes.JOINTS_0) : null
    const weights = typeof primitive.attributes.WEIGHTS_0 === "number" ? readAccessor(document, primitive.attributes.WEIGHTS_0) : null
    const normals = typeof primitive.attributes.NORMAL === "number" ? readAccessor(document, primitive.attributes.NORMAL) : null
    // The skin of the first node that draws this mesh names the bones.
    const node = (json.nodes ?? []).find((candidate) => candidate.mesh === meshIndex)
    const skinJoints = typeof node?.skin === "number" ? json.skins?.[node.skin]?.joints ?? null : null
    const boneName = (joint: number) => {
      const nodeIndex = skinJoints?.[joint]
      return nodeIndex === undefined ? null : json.nodes?.[nodeIndex]?.name ?? `bone ${joint}`
    }
    const local = new Int32Array(uv.count)
    for (let vertex = 0; vertex < uv.count; vertex++) {
      const u = uv.data[vertex * uv.size]!
      const v = uv.data[vertex * uv.size + 1]!
      const key = Math.round(u * WELD) * (WELD * 4) + Math.round(v * WELD)
      let point = pointOf.get(key)
      if (point === undefined) {
        point = us.length
        pointOf.set(key, point)
        us.push(u)
        vs.push(v)
        parent.push(point)
      }
      local[vertex] = point
    }
    for (let at = 0; at + 2 < indices.length; at += 3) {
      const corners = [indices[at]!, indices[at + 1]!, indices[at + 2]!]
      if (corners.some((corner) => corner >= uv.count)) continue
      const [a, b, c] = corners.map((corner) => local[corner]!) as [number, number, number]
      const area = Math.abs((us[b]! - us[a]!) * (vs[c]! - vs[a]!) - (us[c]! - us[a]!) * (vs[b]! - vs[a]!)) / 2
      const bones = new Map<string, number>()
      if (joints && weights && skinJoints) {
        for (const corner of corners) {
          for (let slot = 0; slot < Math.min(joints.size, weights.size); slot++) {
            const weight = weights.data[corner * weights.size + slot]!
            if (!(weight > 0)) continue
            const name = boneName(joints.data[corner * joints.size + slot]!)
            if (name) bones.set(name, (bones.get(name) ?? 0) + weight)
          }
        }
      }
      const normal: [number, number, number] = [0, 0, 0]
      if (normals && normals.size >= 3) {
        for (const corner of corners) for (let axis = 0; axis < 3; axis++) normal[axis]! += normals.data[corner * normals.size + axis]!
      }
      triangles.push({ a, b, c, area, mesh: meshName, bones: [...bones], normal })
      parent[find(a)] = find(b)
      parent[find(b)] = find(c)
    }
  }

  interface Group {
    triangles: Triangle[]
    edges: Map<number, number>
  }
  const groups = new Map<number, Group>()
  const points = us.length
  for (const triangle of triangles) {
    const root = find(triangle.a)
    let group = groups.get(root)
    if (!group) groups.set(root, group = { triangles: [], edges: new Map() })
    group.triangles.push(triangle)
    for (const [from, to] of [[triangle.a, triangle.b], [triangle.b, triangle.c], [triangle.c, triangle.a]] as const) {
      if (from === to) continue
      const key = Math.min(from, to) * points + Math.max(from, to)
      group.edges.set(key, (group.edges.get(key) ?? 0) + 1)
    }
  }

  const pieces: UvPiece[] = []
  for (const group of groups.values()) {
    let area = 0
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity
    let centreU = 0, centreV = 0
    const bones = new Map<string, number>()
    const meshes: string[] = []
    let largest = group.triangles[0]!
    const normal = [0, 0, 0]
    for (const triangle of group.triangles) {
      for (let axis = 0; axis < 3; axis++) normal[axis]! += triangle.normal[axis]! * (triangle.area + 1e-9)
      area += triangle.area
      if (triangle.area > largest.area) largest = triangle
      if (!meshes.includes(triangle.mesh)) meshes.push(triangle.mesh)
      for (const point of [triangle.a, triangle.b, triangle.c]) {
        minU = Math.min(minU, us[point]!); maxU = Math.max(maxU, us[point]!)
        minV = Math.min(minV, vs[point]!); maxV = Math.max(maxV, vs[point]!)
      }
      centreU += triangle.area * (us[triangle.a]! + us[triangle.b]! + us[triangle.c]!) / 3
      centreV += triangle.area * (vs[triangle.a]! + vs[triangle.b]! + vs[triangle.c]!) / 3
      // A sliver of a triangle still belongs to its bone; weigh by area, with a floor.
      for (const [name, weight] of triangle.bones) bones.set(name, (bones.get(name) ?? 0) + weight * (triangle.area + 1e-9))
    }
    const centre: [number, number] = area > 0 ? [centreU / area, centreV / area] : [us[largest.a]!, vs[largest.a]!]
    const inside = (triangle: Triangle, [u, v]: [number, number]) => {
      const sign = (p: number, q: number) => (u - us[q]!) * (vs[p]! - vs[q]!) - (us[p]! - us[q]!) * (v - vs[q]!)
      const d1 = sign(triangle.a, triangle.b), d2 = sign(triangle.b, triangle.c), d3 = sign(triangle.c, triangle.a)
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
    }
    // A ring or a horseshoe has its centre outside itself; label the biggest triangle instead.
    const anchor: [number, number] = group.triangles.some((triangle) => inside(triangle, centre))
      ? centre
      : [(us[largest.a]! + us[largest.b]! + us[largest.c]!) / 3, (vs[largest.a]! + vs[largest.b]! + vs[largest.c]!) / 3]
    const outline: number[] = []
    for (const [key, count] of group.edges) {
      if (count !== 1) continue
      const from = Math.floor(key / points)
      const to = key - from * points
      outline.push(us[from]!, vs[from]!, us[to]!, vs[to]!)
    }
    let bone: string | null = null
    let most = 0
    for (const [name, weight] of [...bones].sort(([x], [y]) => x.localeCompare(y))) {
      if (weight > most) { most = weight; bone = name }
    }
    pieces.push({
      id: 0,
      region: regionName(bone ?? meshes[0] ?? "piece"),
      bone,
      facing: facingOf(normal as [number, number, number]),
      meshes: meshes.sort(),
      bounds: [minU, minV, maxU, maxV],
      area,
      anchor,
      outline,
      triangles: group.triangles.length,
    })
  }
  pieces.sort((x, y) => y.area - x.area || x.bounds[1] - y.bounds[1] || x.bounds[0] - y.bounds[0])
  pieces.forEach((piece, index) => { piece.id = index })
  const regionArea = new Map<string, number>()
  for (const piece of pieces) regionArea.set(piece.region, (regionArea.get(piece.region) ?? 0) + piece.area)
  const regions = [...regionArea].sort(([x, a], [y, b]) => b - a || x.localeCompare(y)).map(([name]) => name)
  return { pieces, regions }
}

/**
 * Which way a piece faces, for a model standing in glTF's convention: +Y up,
 * +Z forward, so +X is the figure's own left. A piece that wraps a limb has
 * normals that mostly cancel and gets no facing.
 */
function facingOf(normal: [number, number, number]): string | null {
  const length = Math.hypot(...normal)
  if (!(length > 0)) return null
  const [x, y, z] = normal.map((value) => value / length) as [number, number, number]
  const strongest = Math.max(Math.abs(x), Math.abs(y), Math.abs(z))
  if (strongest < 0.6) return null
  if (strongest === Math.abs(z)) return z > 0 ? "front" : "back"
  if (strongest === Math.abs(y)) return y > 0 ? "top" : "underside"
  return x > 0 ? "left" : "right"
}

/** What to write on a piece: its region, and which way it faces when that is clear. */
export function pieceLabel(piece: Pick<UvPiece, "region" | "facing">): string {
  return piece.facing ? `${piece.region}, ${piece.facing}` : piece.region
}

/** Colours for regions, spread around the wheel so neighbours in the list differ; index past the end wraps. */
export function regionColour(index: number): string {
  const hue = (index * 137.508) % 360
  const lightness = index % 2 ? 62 : 52
  return `hsl(${hue.toFixed(0)} 95% ${lightness}%)`
}
