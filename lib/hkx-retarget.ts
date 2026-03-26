import { type Model, Quat, Vec3 } from "reze-engine"
import type { RetargetedClip, RetargetedBoneTrack, RetargetedPositionTrack } from "./retarget"
import { POSITION_OFFSET_Y, POSITION_SCALE } from "./retarget"
import type { HkxAnimation } from "./hkx-loader"

/**
 * FBX (Mixamo) → MMD arm bias in `lib/retarget.ts`:
 * - Mixamo rest is T-pose; MMD models use A-pose (~35° arm-down).
 * - Per-bone bind quats `MIXAMO_MATRIX_LOCAL` define Mixamo bone axes.
 * - `RETARGET_TRANSFORMS` sandwiches animation: q_l * q_anim * q_r, with extra ±35° Z
 *   on arms/forearms/hands (`Q_ARM_L` / `Q_ARM_R`) so T-pose motion lands on A-pose rig.
 * HKX path has no Mixamo tables; we align segment directions (HKX ref FK vs MMD rest from
 * `model.getBoneWorldPosition`) for arms, same sandwich as legs after `localDelta`.
 */

export const ER_BONE_MAP: Record<string, string> = {
  Master: "全ての親",
  Root: "腰",
  Pelvis: "下半身",
  Spine: "上半身2",
  Spine1: "上半身",
  Neck: "首",
  Head: "頭",
  L_Clavicle: "左肩",
  L_UpperArm: "左腕",
  L_Forearm: "左ひじ",
  L_Hand: "左手首",
  R_Clavicle: "右肩",
  R_UpperArm: "右腕",
  R_Forearm: "右ひじ",
  R_Hand: "右手首",
  L_Thigh: "左足",
  L_Calf: "左ひざ",
  L_Foot: "左足首",
  L_Toe0: "左足先EX",
  L_Toe_302:"左つま先",
  R_Thigh: "右足",
  R_Calf: "右ひざ",
  R_Foot: "右足首",
  R_Toe0: "右足先EX",
  R_Toe_302: "右つま先",
  L_Finger0: "左親指１",
  L_Finger01: "左親指２",
  L_Finger02: "左親指３",
  L_Finger1: "左人指１",
  L_Finger11: "左人指２",
  L_Finger12: "左人指３",
  L_Finger2: "左中指１",
  L_Finger21: "左中指２",
  L_Finger22: "左中指３",
  L_Finger3: "左薬指１",
  L_Finger31: "左薬指２",
  L_Finger32: "左薬指３",
  L_Finger4: "左小指１",
  L_Finger41: "左小指２",
  L_Finger42: "左小指３",
  R_Finger0: "右親指１",
  R_Finger01: "右親指２",
  R_Finger02: "右親指３",
  R_Finger1: "右人指１",
  R_Finger11: "右人指２",
  R_Finger12: "右人指３",
  R_Finger2: "右中指１",
  R_Finger21: "右中指２",
  R_Finger22: "右中指３",
  R_Finger3: "右薬指１",
  R_Finger31: "右薬指２",
  R_Finger32: "右薬指３",
  R_Finger4: "右小指１",
  R_Finger41: "右小指２",
  R_Finger42: "右小指３",
}

type Q4 = [number, number, number, number]
interface FoldTrack {
  boneIdx: number
  trackIdx: number
}
const TWIST_FOLD_TARGETS: Record<string, string> = {
  L_ThighTwist: "左足",
  L_ThighTwist1: "左足",
  R_ThighTwist: "右足",
  R_ThighTwist1: "右足",
  L_CalfTwist: "左ひざ",
  L_CalfTwist1: "左ひざ",
  R_CalfTwist: "右ひざ",
  R_CalfTwist1: "右ひざ",
}
function q4Mul(a: Q4, b: Q4): Q4 {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}
function q4Conj(q: Q4): Q4 {
  return [-q[0], -q[1], -q[2], q[3]]
}
function q4Rot(q: Q4, v: [number, number, number]): [number, number, number] {
  const t = q4Mul(q, [v[0], v[1], v[2], 0])
  const r = q4Mul(t, q4Conj(q))
  return [r[0], r[1], r[2]]
}
function q4Normalize(q: Q4): Q4 {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
  return l > 1e-10 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1]
}
function qCanonical(x: number, y: number, z: number, w: number): Q4 {
  return w < 0 ? [-x, -y, -z, -w] : [x, y, z, w]
}

function toMmdQuat(q: Q4): Quat {
  // Baseline conversion matching the working FBX retarget path.
  return new Quat(q[0], q[1], -q[2], -q[3])
}

function computeRootWorldPos(hkx: HkxAnimation, frameIdx: number, targetIdx: number): [number, number, number] {
  const n = hkx.bones.length
  const wRot: Q4[] = new Array(n)
  const wPos: [number, number, number][] = new Array(n)
  const b2t = new Map<number, number>()
  for (let t = 0; t < hkx.trackToBone.length; t++) b2t.set(hkx.trackToBone[t], t)
  const fr = hkx.frames[frameIdx]

  for (let i = 0; i < n; i++) {
    const ref = hkx.bones[i].referencePose
    const track = b2t.get(i)
    let lr: Q4
    let lt: [number, number, number]
    if (track !== undefined) {
      const ft = fr[track]
      lr = [ft.rotation[0], ft.rotation[1], ft.rotation[2], ft.rotation[3]]
      lt = [ft.translation[0], ft.translation[1], ft.translation[2]]
    } else {
      lr = [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]]
      lt = [ref.translation[0], ref.translation[1], ref.translation[2]]
    }
    const pi = hkx.bones[i].parentIndex
    if (pi < 0) {
      wRot[i] = lr
      wPos[i] = lt
    } else {
      wRot[i] = q4Mul(wRot[pi], lr)
      const r = q4Rot(wRot[pi], lt)
      wPos[i] = [r[0] + wPos[pi][0], r[1] + wPos[pi][1], r[2] + wPos[pi][2]]
    }
  }
  return wPos[targetIdx] || [0, 0, 0]
}

/** Skeleton reference pose only (no animation tracks) for stable segment directions. */
function computeRefWorldPositions(hkx: HkxAnimation): [number, number, number][] {
  const n = hkx.bones.length
  const wRot: Q4[] = new Array(n)
  const wPos: [number, number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const ref = hkx.bones[i].referencePose
    const lr: Q4 = [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]]
    const lt: [number, number, number] = [ref.translation[0], ref.translation[1], ref.translation[2]]
    const pi = hkx.bones[i].parentIndex
    if (pi < 0) {
      wRot[i] = lr
      wPos[i] = lt
    } else {
      wRot[i] = q4Mul(wRot[pi], lr)
      const r = q4Rot(wRot[pi], lt)
      wPos[i] = [r[0] + wPos[pi][0], r[1] + wPos[pi][1], r[2] + wPos[pi][2]]
    }
  }
  return wPos
}

/** Parent→child in HKX FK ref; `mmdName` is the mapped bone that receives that segment’s rotation. */
const ARM_SEGMENT_FK: Array<{
  parentEr: string
  childEr: string
  mmdName: string
  parentMmd: string
  childMmd: string
}> = [
  { parentEr: "Spine2", childEr: "L_Clavicle", mmdName: "左肩", parentMmd: "上半身2", childMmd: "左肩" },
  { parentEr: "L_Clavicle", childEr: "L_UpperArm", mmdName: "左腕", parentMmd: "左肩", childMmd: "左腕" },
  { parentEr: "L_UpperArm", childEr: "L_Forearm", mmdName: "左ひじ", parentMmd: "左腕", childMmd: "左ひじ" },
  { parentEr: "L_Forearm", childEr: "L_Hand", mmdName: "左手首", parentMmd: "左ひじ", childMmd: "左手首" },
  { parentEr: "Spine2", childEr: "R_Clavicle", mmdName: "右肩", parentMmd: "上半身2", childMmd: "右肩" },
  { parentEr: "R_Clavicle", childEr: "R_UpperArm", mmdName: "右腕", parentMmd: "右肩", childMmd: "右腕" },
  { parentEr: "R_UpperArm", childEr: "R_Forearm", mmdName: "右ひじ", parentMmd: "右腕", childMmd: "右ひじ" },
  { parentEr: "R_Forearm", childEr: "R_Hand", mmdName: "右手首", parentMmd: "右ひじ", childMmd: "右手首" },
]

/** Call after `resetAllBones()` so positions match PMX rest / A-pose. */
export function buildMmdArmSegmentDirectionsFromModel(model: Model): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {}
  for (const seg of ARM_SEGMENT_FK) {
    const pa = model.getBoneWorldPosition(seg.parentMmd)
    const cb = model.getBoneWorldPosition(seg.childMmd)
    if (!pa || !cb) continue
    const dx = cb.x - pa.x
    const dy = cb.y - pa.y
    const dz = cb.z - pa.z
    const l = Math.hypot(dx, dy, dz)
    if (l < 1e-10) continue
    out[seg.mmdName] = [dx / l, dy / l, dz / l]
  }
  return out
}

/** Copy console output → `hkx-skeleton.json` (ER names only; no MMD Japanese keys). */
export function logHkxSkeletonDefaultsToConsole(hkx: HkxAnimation): void {
  const refW = computeRefWorldPositions(hkx)
  const nameToIdx = new Map<string, number>()
  for (let i = 0; i < hkx.bones.length; i++) nameToIdx.set(hkx.bones[i].name, i)
  const bones = hkx.bones.map((b) => {
    const tr = b.referencePose.translation
    const rr = b.referencePose.rotation
    return {
      name: b.name,
      parentIndex: b.parentIndex,
      refTranslation: [tr[0], tr[1], tr[2]],
      refRotation: [rr[0], rr[1], rr[2], rr[3]],
    }
  })
  const legLocal: Array<{
    parentBone: string
    childBone: string
    localTranslation: [number, number, number]
    direction: [number, number, number]
    alignTo: [number, number, number]
  }> = []
  for (const [parentEr, childEr] of [
    ["L_Thigh", "L_Calf"],
    ["L_Calf", "L_Foot"],
    ["R_Thigh", "R_Calf"],
    ["R_Calf", "R_Foot"],
  ] as const) {
    const ci = nameToIdx.get(childEr)
    if (ci === undefined) continue
    const t = hkx.bones[ci].referencePose.translation
    legLocal.push({
      parentBone: parentEr,
      childBone: childEr,
      localTranslation: [t[0], t[1], t[2]],
      direction: vNormalize([t[0], t[1], t[2]]),
      alignTo: [0, -1, 0],
    })
  }
  const armWorld: Array<{ parentBone: string; childBone: string; direction: [number, number, number] }> = []
  for (const seg of ARM_SEGMENT_FK) {
    const pi = nameToIdx.get(seg.parentEr)
    const ci = nameToIdx.get(seg.childEr)
    if (pi === undefined || ci === undefined) continue
    const a = refW[pi]
    const b = refW[ci]
    armWorld.push({
      parentBone: seg.parentEr,
      childBone: seg.childEr,
      direction: vNormalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]),
    })
  }
  const payload = {
    skeletonName: hkx.name,
    bones,
    refWorldPositions: refW,
    legLocalChildTranslation: legLocal,
    armSegmentWorldDirection: armWorld,
  }
  console.log("[hkx-skeleton.json]\n" + JSON.stringify(payload, null, 2))
}

/** Full PMX skeleton in rest pose: hierarchy, world positions, parent→child unit directions (Japanese names from model). */
export function logMmdRestSegmentDirectionsToConsole(model: Model): void {
  const sk = model.getSkeleton()
  const list = sk.bones
  const bones = list.map((b, i) => {
    const pos = model.getBoneWorldPosition(b.name)
    const wp: [number, number, number] | null = pos ? [pos.x, pos.y, pos.z] : null
    let directionFromParent: [number, number, number] | null = null
    if (b.parentIndex >= 0) {
      const pn = list[b.parentIndex]?.name
      const ppos = pn ? model.getBoneWorldPosition(pn) : null
      if (pos && ppos) {
        const dx = pos.x - ppos.x
        const dy = pos.y - ppos.y
        const dz = pos.z - ppos.z
        const l = Math.hypot(dx, dy, dz)
        directionFromParent = l > 1e-10 ? [dx / l, dy / l, dz / l] : null
      }
    }
    const childNames = b.children.map((ci) => list[ci]?.name).filter(Boolean) as string[]
    return {
      index: i,
      name: b.name,
      parentIndex: b.parentIndex,
      parentName: b.parentIndex >= 0 ? list[b.parentIndex].name : null,
      childIndices: [...b.children],
      childNames,
      worldPosition: wp,
      directionFromParent,
    }
  })
  const payload = { boneCount: bones.length, bones }
  console.log("[mmd-skeleton-rest.json]\n" + JSON.stringify(payload, null, 2))
}

interface BoneInfo {
  erName: string
  mmdName: string
  boneIdx: number
  trackIdx: number
}

export interface HkxRetargetContext {
  hkx: HkxAnimation
  bodyBones: BoneInfo[]
  rootPosIdx: number
  /** Per-bone segment alignment: legs (−Y canonical) + optional arms from PMX A-pose directions. */
  segmentAlignByMmd: Record<string, Q4>
  twistFoldByMmd: Record<string, FoldTrack[]>
}

export interface HkxRetargetOptions {
  /** From `buildMmdArmSegmentDirectionsFromModel` after `resetAllBones()` — aligns arm chain to this PMX rest pose. */
  mmdArmDirections?: Record<string, [number, number, number]>
}

export interface FrameResult {
  rotations: Record<string, Quat>
  positions: Record<string, Vec3>
}

function vLen(v: [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2])
}

function vNormalize(v: [number, number, number]): [number, number, number] {
  const l = vLen(v)
  return l > 1e-10 ? [v[0] / l, v[1] / l, v[2] / l] : [1, 0, 0]
}

function vDot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function vCross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function quatFromTo(from: [number, number, number], to: [number, number, number]): Q4 {
  const f = vNormalize(from)
  const t = vNormalize(to)
  const d = Math.max(-1, Math.min(1, vDot(f, t)))
  if (d > 1 - 1e-7) return [0, 0, 0, 1]
  if (d < -1 + 1e-7) {
    const aux: [number, number, number] = Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const axis = vNormalize(vCross(f, aux))
    return [axis[0], axis[1], axis[2], 0]
  }
  const c = vCross(f, t)
  return q4Normalize([c[0], c[1], c[2], 1 + d])
}

export function createRetargetContext(hkx: HkxAnimation, options?: HkxRetargetOptions): HkxRetargetContext {
  const nameToIdx = new Map<string, number>()
  for (let i = 0; i < hkx.bones.length; i++) nameToIdx.set(hkx.bones[i].name, i)
  const b2t = new Map<number, number>()
  for (let t = 0; t < hkx.trackToBone.length; t++) b2t.set(hkx.trackToBone[t], t)

  const bodyBones: BoneInfo[] = []
  for (const [erName, mmdName] of Object.entries(ER_BONE_MAP)) {
    if (erName === "Master") continue
    const boneIdx = nameToIdx.get(erName)
    if (boneIdx === undefined) continue
    const track = b2t.get(boneIdx)
    if (track === undefined) continue
    bodyBones.push({ erName, mmdName, boneIdx, trackIdx: track })
  }

  const rootPosIdx = nameToIdx.get("RootPos") ?? nameToIdx.get("Root") ?? -1
  const segmentAlignByMmd: Record<string, Q4> = {}
  const buildLegAlign = (parentName: string, childName: string, mmdName: string) => {
    const parentIdx = nameToIdx.get(parentName)
    const childIdx = nameToIdx.get(childName)
    if (parentIdx === undefined || childIdx === undefined) return
    const t = hkx.bones[childIdx].referencePose.translation
    const dirSrc: [number, number, number] = [t[0], t[1], t[2]]
    // MMD legs point down in rest pose, use -Y as canonical target.
    segmentAlignByMmd[mmdName] = quatFromTo(dirSrc, [0, -1, 0])
  }
  buildLegAlign("L_Thigh", "L_Calf", "左足")
  buildLegAlign("L_Calf", "L_Foot", "左ひざ")
  buildLegAlign("R_Thigh", "R_Calf", "右足")
  buildLegAlign("R_Calf", "R_Foot", "右ひざ")

  const mmdArm = options?.mmdArmDirections
  if (mmdArm) {
    const refW = computeRefWorldPositions(hkx)
    for (const seg of ARM_SEGMENT_FK) {
      const dirMmd = mmdArm[seg.mmdName]
      if (!dirMmd) continue
      const pi = nameToIdx.get(seg.parentEr)
      const ci = nameToIdx.get(seg.childEr)
      if (pi === undefined || ci === undefined) continue
      const a = refW[pi]
      const b = refW[ci]
      const dirHkx = vNormalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
      segmentAlignByMmd[seg.mmdName] = quatFromTo(dirHkx, dirMmd)
    }
  }

  const twistFoldByMmd: Record<string, FoldTrack[]> = {}
  for (const [erName, mmdName] of Object.entries(TWIST_FOLD_TARGETS)) {
    const boneIdx = nameToIdx.get(erName)
    if (boneIdx === undefined) continue
    const trackIdx = b2t.get(boneIdx)
    if (trackIdx === undefined) continue
    if (!twistFoldByMmd[mmdName]) twistFoldByMmd[mmdName] = []
    twistFoldByMmd[mmdName].push({ boneIdx, trackIdx })
  }
  return { hkx, bodyBones, rootPosIdx, segmentAlignByMmd, twistFoldByMmd }
}

function retargetFrame(ctx: HkxRetargetContext, frameIdx: number): FrameResult {
  const rotations: Record<string, Quat> = {}
  const positions: Record<string, Vec3> = {}
  const frame = ctx.hkx.frames[frameIdx]

  // Standard retarget baseline: local bind-relative delta from source quats.
  for (let i = 0; i < ctx.bodyBones.length; i++) {
    const { mmdName, trackIdx, boneIdx } = ctx.bodyBones[i]
    const refRot = ctx.hkx.bones[boneIdx].referencePose.rotation
    const animRot = frame[trackIdx].rotation
    const refQ: Q4 = [refRot[0], refRot[1], refRot[2], refRot[3]]
    const animQ: Q4 = [animRot[0], animRot[1], animRot[2], animRot[3]]
    let localDelta = q4Normalize(q4Mul(q4Conj(refQ), animQ))
    const foldedTwists = ctx.twistFoldByMmd[mmdName] ?? []
    for (const tw of foldedTwists) {
      const refTw = ctx.hkx.bones[tw.boneIdx].referencePose.rotation
      const animTw = frame[tw.trackIdx].rotation
      const refTwQ: Q4 = [refTw[0], refTw[1], refTw[2], refTw[3]]
      const animTwQ: Q4 = [animTw[0], animTw[1], animTw[2], animTw[3]]
      const twDelta = q4Normalize(q4Mul(q4Conj(refTwQ), animTwQ))
      // Fold child twist channels into the mapped parent segment.
      localDelta = q4Normalize(q4Mul(localDelta, twDelta))
    }
    const align = ctx.segmentAlignByMmd[mmdName]
    const corrected = align
      ? q4Normalize(q4Mul(q4Mul(align, localDelta), q4Conj(align)))
      : localDelta
    rotations[mmdName] = toMmdQuat(qCanonical(corrected[0], corrected[1], corrected[2], corrected[3]))
  }

  if (ctx.rootPosIdx >= 0) {
    const wp = computeRootWorldPos(ctx.hkx, frameIdx, ctx.rootPosIdx)
    positions["センター"] = new Vec3(
      wp[0] * POSITION_SCALE,
      wp[1] * POSITION_SCALE + POSITION_OFFSET_Y,
      -wp[2] * POSITION_SCALE,
    )
  }

  return { rotations, positions }
}

export function computeHkxMmdFrame(hkx: HkxAnimation, frameIdx: number): FrameResult {
  return computeHkxMmdFrameWithCtx(createRetargetContext(hkx), frameIdx)
}

export function computeHkxMmdFrameWithCtx(ctx: HkxRetargetContext, frameIdx: number): FrameResult {
  if (frameIdx < 0 || frameIdx >= ctx.hkx.numFrames) return { rotations: {}, positions: {} }
  return retargetFrame(ctx, frameIdx)
}

export function retargetHkxClip(hkx: HkxAnimation): RetargetedClip {
  const ctx = createRetargetContext(hkx)
  const times = Array.from({ length: hkx.numFrames }, (_, i) => i / hkx.fps)
  const boneQuats: Record<string, Quat[]> = {}
  const rootPositions: Vec3[] = []

  for (let f = 0; f < hkx.numFrames; f++) {
    const { rotations, positions } = retargetFrame(ctx, f)
    for (const [name, q] of Object.entries(rotations)) {
      if (!boneQuats[name]) boneQuats[name] = []
      boneQuats[name].push(q)
    }
    if (positions["センター"]) rootPositions.push(positions["センター"])
  }

  const boneTracks: RetargetedBoneTrack[] = []
  for (const [mmdName, quats] of Object.entries(boneQuats)) {
    let orig = mmdName
    for (const [er, mmd] of Object.entries(ER_BONE_MAP)) {
      if (mmd === mmdName) {
        orig = er
        break
      }
    }
    boneTracks.push({ name: mmdName, originalName: orig, times: [...times], quats })
  }

  const positionTracks: RetargetedPositionTrack[] = []
  if (rootPositions.length === hkx.numFrames) {
    positionTracks.push({ name: "センター", originalName: "Root", times: [...times], positions: rootPositions })
  }

  return { name: hkx.name, duration: hkx.duration, fps: hkx.fps, boneTracks, positionTracks }
}