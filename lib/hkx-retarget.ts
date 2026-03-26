import { Quat, Vec3 } from "reze-engine"
import type { RetargetedClip, RetargetedBoneTrack, RetargetedPositionTrack } from "./retarget"
import { POSITION_OFFSET_Y, POSITION_SCALE } from "./retarget"
import type { HkxAnimation } from "./hkx-loader"

// ============================================================
// HKX (Elden Ring) → MMD retargeting
//
// Body bones: delta = conj(refLocal) * animLocal
//   - Confirmed working: model stands, axes correct for idle
//   - Body bones barely change from ref even in attack anims
//   - Fighting stance comes from Master, not body bones
//
// Master → 全ての親: delta from IDLE reference (not ref pose)
//   - Ref pose Master = Z-up orientation → delta = 180° (wrong!)
//   - Idle Master = neutral Y-up standing → delta = facing change only
//   - For idle anim: delta ≈ identity (correct)
//   - For attack anim: delta ≈ 25° Y rotation (correct facing)
//
// RootPos → センター: position only, no rotation
// ============================================================

// Idle (a000_000000) Master rotation at frame 0.
// This is the "neutral standing Y-up" orientation.
// Constant across all animations (same skeleton).
// Used as reference for Master delta to avoid Z-up→Y-up contamination.
const IDLE_MASTER: [number, number, number, number] = [-0.0007, 0.7381, -0.0003, 0.6746]

export const ER_BONE_MAP: Record<string, string> = {
  Master: "全ての親",
  // RootPos: position only, handled separately
  Pelvis: "下半身",
  Spine: "腰",
  Spine1: "上半身",
  Spine2: "上半身2",
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
  R_Thigh: "右足",
  R_Calf: "右ひざ",
  R_Foot: "右足首",
  R_Toe0: "右足先EX",
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

// ── FK for root position ──

type Q4 = [number, number, number, number]
function q4Mul(a: Q4, b: Q4): Q4 {
  const [ax, ay, az, aw] = a,
    [bx, by, bz, bw] = b
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
  const t = q4Mul(q, [v[0], v[1], v[2], 0]),
    r = q4Mul(t, q4Conj(q))
  return [r[0], r[1], r[2]]
}
function q4Normalize(q: Q4): Q4 {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
  return l > 1e-10 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1]
}

function computeRootWorldPos(hkx: HkxAnimation, frameIdx: number, targetIdx: number): [number, number, number] {
  const n = hkx.bones.length
  const wRot: Q4[] = new Array(n),
    wPos: [number, number, number][] = new Array(n)
  const b2t = new Map<number, number>()
  for (let t = 0; t < hkx.trackToBone.length; t++) b2t.set(hkx.trackToBone[t], t)
  const fr = hkx.frames[frameIdx]
  for (let i = 0; i < n; i++) {
    const ref = hkx.bones[i].referencePose
    const track = b2t.get(i)
    let lr: Q4, lt: [number, number, number]
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

// ── Bone info ──

interface BoneInfo {
  erName: string
  mmdName: string
  trackIdx: number
  refLocal: Q4
}

// ── Context ──

export interface HkxRetargetContext {
  hkx: HkxAnimation
  bodyBones: BoneInfo[]
  masterTrackIdx: number
  rootPosIdx: number
}

let _logged = false

export function createRetargetContext(hkx: HkxAnimation): HkxRetargetContext {
  const nameToIdx = new Map<string, number>()
  for (let i = 0; i < hkx.bones.length; i++) nameToIdx.set(hkx.bones[i].name, i)
  const b2t = new Map<number, number>()
  for (let t = 0; t < hkx.trackToBone.length; t++) b2t.set(hkx.trackToBone[t], t)

  const bodyBones: BoneInfo[] = []
  const doLog = !_logged
  if (doLog) console.log("=== HKX Retarget (simple delta + idle-ref Master) ===")

  for (const [erName, mmdName] of Object.entries(ER_BONE_MAP)) {
    if (erName === "Master") continue // handled separately

    const boneIdx = nameToIdx.get(erName)
    if (boneIdx === undefined) continue
    const track = b2t.get(boneIdx)
    if (track === undefined) continue

    const ref = hkx.bones[boneIdx].referencePose
    const refLocal: Q4 = [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]]

    if (doLog) {
      const pi = hkx.bones[boneIdx].parentIndex
      const pname = pi >= 0 ? hkx.bones[pi].name : "ROOT"
      console.log(`  ${erName} → ${mmdName} (parent: ${pname}) ref=[${refLocal.map((v) => v.toFixed(3)).join(",")}]`)
    }

    bodyBones.push({ erName, mmdName, trackIdx: track, refLocal })
  }

  const masterIdx = nameToIdx.get("Master") ?? -1
  const masterTrackIdx = masterIdx >= 0 ? (b2t.get(masterIdx) ?? -1) : -1
  const rootPosIdx = nameToIdx.get("RootPos") ?? -1

  if (doLog) {
    console.log(`  Master track=${masterTrackIdx}, RootPos idx=${rootPosIdx}`)
    console.log(`  IDLE_MASTER=[${IDLE_MASTER.map((v) => v.toFixed(4)).join(",")}]`)
    console.log(`  Body bones: ${bodyBones.length}`)
    _logged = true
  }

  return { hkx, bodyBones, masterTrackIdx, rootPosIdx }
}

// ── Frame retarget ──

function qCanonical(x: number, y: number, z: number, w: number): [number, number, number, number] {
  if (w < 0) return [-x, -y, -z, -w]
  return [x, y, z, w]
}

interface FrameResult {
  rotations: Record<string, Quat>
  positions: Record<string, Vec3>
}

function retargetFrame(ctx: HkxRetargetContext, frameIdx: number): FrameResult {
  const rotations: Record<string, Quat> = {}
  const positions: Record<string, Vec3> = {}
  const frame = ctx.hkx.frames[frameIdx]

  // 1. Master → 全ての親: delta from idle reference
  if (ctx.masterTrackIdx >= 0) {
    const ft = frame[ctx.masterTrackIdx]
    const masterAnim: Q4 = [ft.rotation[0], ft.rotation[1], ft.rotation[2], ft.rotation[3]]
    const delta = q4Normalize(q4Mul(q4Conj(IDLE_MASTER), masterAnim))
    const [dx, dy, dz, dw] = qCanonical(delta[0], delta[1], delta[2], delta[3])
    rotations["全ての親"] = new Quat(dx, dy, dz, dw)
  }

  // 2. Body bones: direct local delta from ref
  for (const { mmdName, trackIdx, refLocal } of ctx.bodyBones) {
    const ft = frame[trackIdx]
    const animLocal: Q4 = [ft.rotation[0], ft.rotation[1], ft.rotation[2], ft.rotation[3]]
    const delta = q4Normalize(q4Mul(q4Conj(refLocal), animLocal))
    const [dx, dy, dz, dw] = qCanonical(delta[0], delta[1], delta[2], delta[3])
    rotations[mmdName] = new Quat(dx, dy, dz, dw)
  }

  // 3. Root position from FK
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

// ── Public API ──

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
    positionTracks.push({ name: "センター", originalName: "RootPos", times: [...times], positions: rootPositions })
  }

  return { name: hkx.name, duration: hkx.duration, fps: hkx.fps, boneTracks, positionTracks }
}
