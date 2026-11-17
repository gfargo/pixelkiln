// Carve a voxel model from eight views, smooth it, colour it from the view that faces each
// surface voxel, and render it by ray-marching so there are no holes.
// usage: voxel2.ts <dir> <name-or-prefix> <out> [need=8] [thetaDeg|fit]
import { readFileSync, writeFileSync } from "node:fs"
import { decodePng, encodeRgbaPng } from "../../src/png.ts"
const D = ["south","south-east","east","north-east","north","north-west","west","south-west"]
const [dir, name, out, needArg = "8", thetaArg = "fit"] = process.argv.slice(2)
const views = D.map((d) => decodePng(readFileSync(`${dir}/${name}-${d}.png`)))
const size = views[0]!.width, N = size, H = N / 2
const SKIP = new Set((process.env.SKIP ?? '').split(',').filter(Boolean).map((d) => D.indexOf(d)))
// A skipped view (one drawn tilted) neither carves nor colours.
const opaque = (v: number, x: number, y: number) => SKIP.has(v) ? true : x >= 0 && y >= 0 && x < size && y < size && views[v]!.pixels[(y * size + x) * 4 + 3]! > 127
const centre = views.map((_, v) => { let l = size, r = -1, t = size, b = -1
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (opaque(v, x, y)) { l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y) }
  return { x: (l + r + 1) / 2, y: (t + b + 1) / 2 } })
type Params = { theta: number; off: Array<{ x: number; y: number }> }
const AZ = (v: number) => v * Math.PI / 4
const proj = (theta: number, az: number, x: number, y: number, z: number) => {
  const u = x * Math.cos(az) - y * Math.sin(az), d = x * Math.sin(az) + y * Math.cos(az)
  return { u, s: z * Math.cos(theta) + d * Math.sin(theta), depth: d * Math.cos(theta) - z * Math.sin(theta) } }
const pix = (p: Params, v: number, x: number, y: number, z: number) => { const q = proj(p.theta, AZ(v), x, y, z)
  return { px: Math.floor(q.u + centre[v]!.x + p.off[v]!.x), py: Math.floor(-q.s + centre[v]!.y + p.off[v]!.y), depth: q.depth } }
const idx = (x: number, y: number, z: number) => (z * N + y) * N + x
function carve(p: Params, need: number): Uint8Array { const vox = new Uint8Array(N * N * N)
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let hit = 0
    for (let v = 0; v < 8; v++) { const q = pix(p, v, x - H + 0.5, y - H + 0.5, z - H + 0.5); if (opaque(v, q.px, q.py)) hit++; else if (7 - v + hit < need) break }
    if (hit >= need) vox[idx(x, y, z)] = 1 }
  return vox }
function score(p: Params, vox: Uint8Array): number[] { return views.map((_, v) => v).filter((v) => !SKIP.has(v)).map((v) => { const cover = new Uint8Array(size * size)
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (vox[idx(x, y, z)]) { const q = pix(p, v, x - H + 0.5, y - H + 0.5, z - H + 0.5); if (q.px >= 0 && q.py >= 0 && q.px < size && q.py < size) cover[q.py * size + q.px] = 1 }
  let i = 0, u = 0; for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const a = opaque(v, x, y), b = cover[y * size + x] === 1; if (a && b) i++; if (a || b) u++ }
  return u ? i / u : 0 }) }
const mean = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length
const need = Number(needArg)
const evaluate = (p: Params) => mean(score(p, carve(p, 8)))
let best: Params = { theta: 0, off: views.map(() => ({ x: 0, y: 0 })) }, bestScore = -1
for (const deg of thetaArg === "fit" ? [0, 10, 20, 30, 40] : [Number(thetaArg)]) { const p = { theta: deg * Math.PI / 180, off: views.map(() => ({ x: 0, y: 0 })) }; const s = evaluate(p); if (s > bestScore) { best = p; bestScore = s } }
for (let round = 0; round < 2; round++) for (let v = 0; v < 8; v++) for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2]]) {
  const p = { theta: best.theta, off: best.off.map((o, i) => i === v ? { x: o.x + dx!, y: o.y + dy! } : o) }; const s = evaluate(p); if (s > bestScore + 1e-6) { best = p; bestScore = s } }
const strict = carve(best, 8)
let vox = carve(best, need)
// Smooth: two rounds of a 3x3x3 majority vote, which fills pits and shaves spikes.
for (let round = 0; round < 2; round++) { const next = new Uint8Array(vox)
  for (let z = 1; z < N - 1; z++) for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) { let n = 0
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += vox[idx(x + dx, y + dy, z + dz)]!
    next[idx(x, y, z)] = vox[idx(x, y, z)] ? (n >= 9 ? 1 : 0) : (n >= 17 ? 1 : 0) }
  vox = next }
// DUMP=1 writes the smoothed voxels and the fitted camera, for texture.py to mesh and texture.
if (process.env.DUMP) {
  writeFileSync(`${out}/${name}.vox`, vox)
  writeFileSync(`${out}/${name}.camera.json`, JSON.stringify({ size, elevation: best.theta, centre, off: best.off, skip: [...SKIP] }))
}
const [anchorsFile, anchorsKey, tubeMode = "hybrid"] = process.argv.slice(7)
let rig: Array<{ label: string; x: number; y: number; z: number; residual: number }> | undefined
if (anchorsFile) {
  const frames = JSON.parse(readFileSync(anchorsFile, "utf8")).frames[anchorsKey!]
  const labels: string[] = frames.south.keypoints.map((k: { label: string }) => k.label)
  const swapName = (l: string) => l.startsWith("LEFT ") ? "RIGHT " + l.slice(5) : l.startsWith("RIGHT ") ? "LEFT " + l.slice(6) : l
  const solve = (obs: Array<{ v: number; px: number; py: number }>) => { // least squares for (X, Y, Z)
    const A = [[0,0,0],[0,0,0],[0,0,0]], bvec = [0,0,0]
    const add = (r: number[], t: number) => { for (let i = 0; i < 3; i++) { bvec[i]! += r[i]! * t; for (let j = 0; j < 3; j++) A[i]![j]! += r[i]! * r[j]! } }
    for (const o of obs) { const az = AZ(o.v), th = best.theta
      add([Math.cos(az), -Math.sin(az), 0], o.px - centre[o.v]!.x - best.off[o.v]!.x)
      add([Math.sin(az) * Math.sin(th), Math.cos(az) * Math.sin(th), Math.cos(th)], -(o.py - centre[o.v]!.y - best.off[o.v]!.y)) }
    const det = (m: number[][]) => m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!)
    const d = det(A) || 1e-9
    const col = (k: number) => A.map((row, i) => row.map((val, j) => j === k ? bvec[i]! : val))
    const p = [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d]
    let res = 0
    for (const o of obs) { const q = proj(best.theta, AZ(o.v), p[0]!, p[1]!, p[2]!); res += Math.hypot(q.u + centre[o.v]!.x + best.off[o.v]!.x - o.px, -q.s + centre[o.v]!.y + best.off[o.v]!.y - o.py) }
    return { p, residual: res / obs.length } }
  const kp = (v: number, label: string) => { const f = frames[D[v]!]; const k = f.keypoints.find((e: { label: string }) => e.label === label); return { v, px: k.x * f.width, py: k.y * f.height } }
  // The estimator names left and right by the picture, not the body, in some views: per view, keep whichever naming agrees with the rest.
  const flipped = D.map(() => false)
  for (let round = 0; round < 2; round++) for (let v = 1; v < 8; v++) { const err = (flip: boolean) => { let e = 0
      for (const l of labels) { if (!/^(LEFT|RIGHT) /.test(l)) continue
        const obs = D.map((_, w) => kp(w, (w === v ? flip : flipped[w]) ? swapName(l) : l)); e += solve(obs).residual }
      return e }
    flipped[v] = err(true) < err(false) }
  rig = labels.map((l) => { const r = solve(D.map((_, v) => kp(v, flipped[v] ? swapName(l) : l))); return { label: l, x: r.p[0]!, y: r.p[1]!, z: r.p[2]!, residual: r.residual } })
  const J = (l: string) => rig!.find((j) => j.label === l)!
  const mid = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 })
  const neck = J("NECK"), hips = mid(J("LEFT HIP"), J("RIGHT HIP")), head = mid(J("LEFT EAR"), J("RIGHT EAR"))
  const bones: Array<{ name: string; a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number }; r: number }> = []
  for (const side of ["LEFT", "RIGHT"]) {
    bones.push({ name: side + " upper arm", a: J(side + " SHOULDER"), b: J(side + " ELBOW"), r: 0 }, { name: side + " forearm", a: J(side + " ELBOW"), b: J(side + " ARM"), r: 0 },
      { name: side + " thigh", a: J(side + " HIP"), b: J(side + " KNEE"), r: 0 }, { name: side + " shin", a: J(side + " KNEE"), b: J(side + " LEG"), r: 0 }) }
  bones.push({ name: "torso", a: neck, b: hips, r: 0 }, { name: "shoulders", a: J("LEFT SHOULDER"), b: J("RIGHT SHOULDER"), r: 0 }, { name: "hips", a: J("LEFT HIP"), b: J("RIGHT HIP"), r: 0 }, { name: "head", a: head, b: { x: head.x, y: head.y, z: head.z + 1 }, r: 0 })
  const dist = (x: number, y: number, z: number, bone: (typeof bones)[number]) => { const ax = bone.b.x - bone.a.x, ay = bone.b.y - bone.a.y, az = bone.b.z - bone.a.z
    const t = Math.max(0, Math.min(1, ((x - bone.a.x) * ax + (y - bone.a.y) * ay + (z - bone.a.z) * az) / (ax * ax + ay * ay + az * az || 1)))
    return Math.hypot(x - bone.a.x - ax * t, y - bone.a.y - ay * t, z - bone.a.z - az * t) }
  // Give every hull voxel to its nearest bone; a bone's radius is how far its own voxels reach (90th percentile).
  const loose = carve(best, 7), owned: number[][] = bones.map(() => [])
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (loose[idx(x, y, z)]) { let bi = 0, bd = Infinity
    bones.forEach((bone, i) => { const d = dist(x - H + 0.5, y - H + 0.5, z - H + 0.5, bone); if (d < bd) { bd = d; bi = i } }); owned[bi]!.push(bd) }
  bones.forEach((bone, i) => { const ds = owned[i]!.sort((a, b) => a - b); bone.r = ds.length ? ds[Math.floor(ds.length * 0.5)]! * 1.45 : 1 })  // in a solid tube the median distance is R / sqrt(2)
  const tubes = new Uint8Array(N * N * N)
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (bones.some((bone) => dist(x - H + 0.5, y - H + 0.5, z - H + 0.5, bone) <= bone.r + (tubeMode === "hybrid" ? 1.5 : 0))) tubes[idx(x, y, z)] = 1
  if (tubeMode === "hybrid") { for (let i = 0; i < vox.length; i++) vox[i] = vox[i]! && tubes[i]! ? 1 : 0 } else vox = tubes
  writeFileSync(`${out}/${name}.rig.json`, JSON.stringify({ joints: rig, bones: bones.map((b) => ({ name: b.name, radius: Number(b.r.toFixed(2)) })), flippedViews: D.filter((_, v) => flipped[v]) }, null, 1))
  console.log(JSON.stringify({ meanJointResidualPx: Number((rig.reduce((s, j) => s + j.residual, 0) / rig.length).toFixed(2)), worst: rig.slice().sort((a, b) => b.residual - a.residual).slice(0, 3).map((j) => j.label + " " + j.residual.toFixed(1)), flipped: D.filter((_, v) => flipped[v]), radii: bones.map((b) => b.name + " " + b.r.toFixed(1)) }))
}
// A mesh from an image-to-3D model, in place of the carved shape: voxelise it, then find the turn, mirror and
// scale that best agree with the carved hull, since the mesh comes in its own frame.
if (process.env.GLB) {
  const buf = readFileSync(process.env.GLB)
  const jsonLen = buf.readUInt32LE(12), gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8")), bin = buf.subarray(20 + jsonLen + 8)
  const acc = (i: number) => { const a = gltf.accessors[i], bv = gltf.bufferViews[a.bufferView]; return { a, off: (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), stride: bv.byteStride } }
  const tris: number[][] = []
  for (const mesh of gltf.meshes) for (const prim of mesh.primitives) { const P = acc(prim.attributes.POSITION), ps = P.stride ?? 12
    const pos = (i: number) => [bin.readFloatLE(P.off + i * ps), bin.readFloatLE(P.off + i * ps + 4), bin.readFloatLE(P.off + i * ps + 8)]
    if (prim.indices === undefined) { for (let i = 0; i + 2 < P.a.count; i += 3) tris.push([...pos(i), ...pos(i + 1), ...pos(i + 2)]); continue }
    const I = acc(prim.indices), w = I.a.componentType === 5125 ? 4 : I.a.componentType === 5123 ? 2 : 1
    const ix = (i: number) => w === 4 ? bin.readUInt32LE(I.off + i * 4) : w === 2 ? bin.readUInt16LE(I.off + i * 2) : bin.readUInt8(I.off + i)
    for (let i = 0; i + 2 < I.a.count; i += 3) tris.push([...pos(ix(i)), ...pos(ix(i + 1)), ...pos(ix(i + 2))]) }
  const hull = carve(best, 7)
  const box = (get: (cb: (x: number, y: number, z: number) => void) => void) => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    get((x, y, z) => { [x, y, z].forEach((v, k) => { lo[k] = Math.min(lo[k]!, v); hi[k] = Math.max(hi[k]!, v) }) }); return { lo, hi } }
  const hb = box((cb) => { for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (hull[idx(x, y, z)]) cb(x + 0.5, y + 0.5, z + 0.5) })
  let bestIou = -1, bestVox = vox, bestName = ""
  // glTF is y-up. Try each quarter turn about the vertical, mirrored or not.
  for (const mirror of [1, -1]) for (let turn = 0; turn < 4; turn++) { const c = Math.cos(turn * Math.PI / 2), sn = Math.sin(turn * Math.PI / 2)
    const map = (x: number, y: number, z: number) => { const mx = x * mirror; return [mx * c - z * sn, mx * sn + z * c, y] as const }  // -> (x, y, up)
    const mb = box((cb) => { for (const t of tris) for (let k = 0; k < 9; k += 3) { const p = map(t[k]!, t[k + 1]!, t[k + 2]!); cb(p[0], p[1], p[2]) } })
    const scale = (hb.hi[2]! - hb.lo[2]!) / (mb.hi[2]! - mb.lo[2]!)
    const place = (p: readonly [number, number, number]) => [0, 1, 2].map((k) => (p[k]! - (mb.lo[k]! + mb.hi[k]!) / 2) * scale + (hb.lo[k]! + hb.hi[k]!) / 2)
    // Fill by parity along each vertical column.
    const hits: number[][] = Array.from({ length: N * N }, () => [])
    for (const t of tris) { const a = place(map(t[0]!, t[1]!, t[2]!)), b2 = place(map(t[3]!, t[4]!, t[5]!)), c2 = place(map(t[6]!, t[7]!, t[8]!))
      const x0 = Math.max(0, Math.floor(Math.min(a[0]!, b2[0]!, c2[0]!))), x1 = Math.min(N - 1, Math.floor(Math.max(a[0]!, b2[0]!, c2[0]!)))
      const y0 = Math.max(0, Math.floor(Math.min(a[1]!, b2[1]!, c2[1]!))), y1 = Math.min(N - 1, Math.floor(Math.max(a[1]!, b2[1]!, c2[1]!)))
      const den = (b2[1]! - c2[1]!) * (a[0]! - c2[0]!) + (c2[0]! - b2[0]!) * (a[1]! - c2[1]!); if (Math.abs(den) < 1e-12) continue
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const px = x + 0.5, py = y + 0.5
        const l1 = ((b2[1]! - c2[1]!) * (px - c2[0]!) + (c2[0]! - b2[0]!) * (py - c2[1]!)) / den, l2 = ((c2[1]! - a[1]!) * (px - c2[0]!) + (a[0]! - c2[0]!) * (py - c2[1]!)) / den, l3 = 1 - l1 - l2
        if (l1 < 0 || l2 < 0 || l3 < 0) continue
        hits[y * N + x]!.push(l1 * a[2]! + l2 * b2[2]! + l3 * c2[2]!) } }
    const mv = new Uint8Array(N * N * N)
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const h = hits[y * N + x]!.sort((p, q) => p - q)
      for (let k = 0; k + 1 < h.length; k += 2) for (let z = Math.max(0, Math.round(h[k]!)); z < Math.min(N, Math.round(h[k + 1]!)); z++) mv[idx(x, y, z)] = 1 }
    let inter = 0, union = 0; for (let i = 0; i < mv.length; i++) { if (mv[i] && hull[i]) inter++; if (mv[i] || hull[i]) union++ }
    const iou = inter / (union || 1); if (iou > bestIou) { bestIou = iou; bestVox = mv; bestName = (mirror < 0 ? "mirrored, " : "") + turn * 90 + " degrees" } }
  vox = bestVox
  console.log(JSON.stringify({ mesh: process.env.GLB.split("/").pop(), triangles: tris.length, fit: bestName, agreementWithHull: Math.round(bestIou * 100) }))
}
const at = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < N && y < N && z < N ? vox[idx(x, y, z)]! : 0
// Colour: each surface voxel takes its pixel from the view its normal faces most, among views that see it first.
const first = views.map((_, v) => { const zb = new Float32Array(size * size).fill(Infinity)
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (vox[idx(x, y, z)]) { const q = pix(best, v, x - H + 0.5, y - H + 0.5, z - H + 0.5); if (q.px >= 0 && q.py >= 0 && q.px < size && q.py < size && q.depth < zb[q.py * size + q.px]!) zb[q.py * size + q.px] = q.depth }
  return zb })
const colours = new Uint8Array(N * N * N * 4)
for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { if (!vox[idx(x, y, z)]) continue
  let nx = 0, ny = 0, nz = 0
  for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (!at(x + dx, y + dy, z + dz)) { nx += dx; ny += dy; nz += dz }
  const nl = Math.hypot(nx, ny, nz) || 1
  let bestW = -Infinity, c = -1, cx = 0, cy = 0
  for (let v = 0; v < 8; v++) { if (SKIP.has(v)) continue; const q = pix(best, v, x - H + 0.5, y - H + 0.5, z - H + 0.5); if (!opaque(v, q.px, q.py)) continue
    const az = AZ(v), th = best.theta
    // Unit vector from the object toward camera v.
    const tx = -Math.sin(az) * Math.cos(th), ty = -Math.cos(az) * Math.cos(th), tz = Math.sin(th)
    const facing = (nx * tx + ny * ty + nz * tz) / nl
    const gap = q.depth - first[v]![q.py * size + q.px]!
    const o = (q.py * size + q.px) * 4, px = views[v]!.pixels
    const outline = Math.max(px[o]!, px[o + 1]!, px[o + 2]!) < 60
    const w = facing - Math.min(gap, 8) * 0.35 - (outline ? 1.2 : 0)
    if (w > bestW) { bestW = w; c = v; cx = q.px; cy = q.py } }
  if (c >= 0) views[c]!.pixels.copy(colours, idx(x, y, z) * 4, (cy * size + cx) * 4, (cy * size + cx) * 4 + 4) }
// Render by marching a ray per pixel.
function render(az: number, theta: number, cell: number): Buffer { const img = Buffer.alloc(cell * cell * 4)
  const ca = Math.cos(az), sa = Math.sin(az), ct = Math.cos(theta), st = Math.sin(theta)
  for (let py = 0; py < cell; py++) for (let px = 0; px < cell; px++) { const u = px + 0.5 - cell / 2, s = cell / 2 - (py + 0.5)
    for (let t = -N; t <= N; t += 0.5) { // t is depth; invert the projection
      const d = t * ct + s * st, z = s * ct - t * st
      const x = u * ca + d * sa, y = -u * sa + d * ca
      const vx = Math.floor(x + H), vy = Math.floor(y + H), vz = Math.floor(z + H)
      if (at(vx, vy, vz)) { const i = idx(vx, vy, vz) * 4; if (colours[i + 3]) { colours.subarray(i, i + 4).forEach((b, k) => { img[(py * cell + px) * 4 + k] = b }); } else img.fill(255, (py * cell + px) * 4, (py * cell + px) * 4 + 4); break } } }
  const outl = Buffer.from(img)
  for (let py = 0; py < cell; py++) for (let px = 0; px < cell; px++) { const i = (py * cell + px) * 4; if (!img[i + 3]) continue
    const edge = [[1,0],[-1,0],[0,1],[0,-1]].some(([dx, dy]) => { const x = px + dx!, y = py + dy!; return x < 0 || y < 0 || x >= cell || y >= cell || !img[(y * cell + x) * 4 + 3] })
    if (edge) { outl[i] = Math.round(img[i]! * 0.22); outl[i + 1] = Math.round(img[i + 1]! * 0.2); outl[i + 2] = Math.round(img[i + 2]! * 0.2) } }
  return outl }
const cell = size, sheet = Buffer.alloc(cell * 8 * cell * 3 * 4)
const put = (img: Buffer, cx: number, cy: number) => { for (let y = 0; y < cell; y++) img.copy(sheet, ((cy * cell + y) * cell * 8 + cx * cell) * 4, y * cell * 4, (y + 1) * cell * 4) }
views.forEach((v, i) => put(v.pixels, i, 0))
for (let i = 0; i < 8; i++) { put(render(AZ(i), best.theta, cell), i, 1); put(render(AZ(i + 0.5), best.theta, cell), i, 2) }
writeFileSync(`${out}/${name}${process.env.GLB ? "-mesh" : anchorsFile ? "-" + tubeMode : ""}.png`, encodeRgbaPng(cell * 8, cell * 3, sheet))
const count = (a: Uint8Array) => a.reduce((s, n) => s + n, 0), pct = (n: number) => Math.round(n * 100)
const per = score(best, strict), fin = score(best, vox)
console.log(JSON.stringify({ name, size, elevation: Math.round(best.theta * 180 / Math.PI), strictOverlap: pct(mean(per)), strictWorst: pct(Math.min(...per)), strictVoxels: count(strict), finalOverlap: pct(mean(fin)), finalWorst: pct(Math.min(...fin)), finalVoxels: count(vox) }))
