import { Quat, Vec3 } from "reze-engine"
import type { HkxAnimation } from "./hkx-loader"

/**
 * HKX (Elden Ring / Havok) → MMD (VMD) retarget.
 *
 * Self-contained. Designed to be extracted into its own package later.
 *
 * Core idea (world-rotation retarget):
 *
 *   PMX bones have identity local rest rotations (only rest translations).
 *   So every MMD bone's rest world rotation is identity. That means the
 *   MMD bone's animated world rotation must equal the ER bone's *world-space
 *   motion delta* from its own bind:
 *
 *     W_target(mmd_b) = R_er(er_b) · E(er_b)⁻¹
 *
 *   where R_er is ER's animated world rotation (FK per frame) and E is
 *   ER's bind-pose world rotation (FK on the reference pose, cached).
 *
 *   Because MMD local rest rotations are identity, each VMD local rotation is
 *   just the world-rotation delta between a mapped MMD bone and its nearest
 *   mapped MMD ancestor:
 *
 *     q_vmd(mmd_b) = W_target(mmd_parent)⁻¹ · W_target(mmd_b)
 *
 *   Unmapped intermediate ER bones (Spine2, Collar, twist helpers, …) get
 *   their rotations correctly absorbed into the next mapped MMD descendant
 *   via this cancellation — no ad-hoc fold table needed.
 *
 * Handedness: HKX and MMD (reze-engine, Babylon) are both left-handed Y-up,
 * so no axis flip is applied.
 */

/* ============================================================================
 * Public types (kept local so this module can move to its own repo).
 * ========================================================================= */

export interface RetargetedBoneTrack {
  name: string
  originalName: string
  times: number[]
  quats: Quat[]
}

export interface RetargetedPositionTrack {
  name: string
  originalName: string
  times: number[]
  positions: Vec3[]
}

export interface RetargetedClip {
  name: string
  duration: number
  fps: number
  boneTracks: RetargetedBoneTrack[]
  positionTracks: RetargetedPositionTrack[]
}

/**
 * ER → MMD world-unit scale for translations.
 *
 * ER skeleton is in meters (waist `Root` bone at ~1.62). MMD model is in PMX
 * units (waist bone at ~11.8, head at ~18.7). Natural ratio ≈ 7.3.
 *
 * `moveBones` expects the value as a world-space offset from bind pose, so
 * this is applied directly to `(ER_world_anim − ER_world_bind)`.
 */
export const POSITION_SCALE = 7.3

/* ============================================================================
 * ER → MMD bone mapping.
 * ========================================================================= */

export const ER_BONE_MAP: Record<string, string> = {
  Master: "全ての親",
  Root: "センター",
  Pelvis: "下半身",
  Spine: "上半身",
  Spine1: "上半身2",
  Neck: "首",
  Head: "頭",
  L_Clavicle: "左肩",
  L_UpperArm: "左腕",
  // L_UpArmTwist: "左腕捩",
  L_Forearm: "左ひじ",
  // L_ForeArmTwist: "左手捩",
  L_Hand: "左手首",
  R_Clavicle: "右肩",
  R_UpperArm: "右腕",
  // R_UpArmTwist: "右腕捩",
  R_Forearm: "右ひじ",
  // R_ForeArmTwist: "右手捩",
  R_Hand: "右手首",
  L_Thigh: "左足",
  L_Calf: "左ひざ",
  L_Foot: "左足首",
  L_Toe0: "左足先EX",
  L_Toe_302: "左つま先",
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

/* ============================================================================
 * Quaternion helpers (Q4 = [x, y, z, w]).
 * ========================================================================= */

type Q4 = [number, number, number, number]

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

function q4Normalize(q: Q4): Q4 {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
  return l > 1e-10 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1]
}

function q4Rot(q: Q4, v: [number, number, number]): [number, number, number] {
  const t = q4Mul(q, [v[0], v[1], v[2], 0])
  const r = q4Mul(t, q4Conj(q))
  return [r[0], r[1], r[2]]
}

/* ============================================================================
 * Retarget context.
 * ========================================================================= */

interface MappedBone {
  erName: string
  mmdName: string
  erIdx: number
  /** Nearest mapped ancestor in the ER tree (its MMD name). Null if this is a root-mapped bone. */
  parentMmdName: string | null
}

export interface HkxRetargetContext {
  hkx: HkxAnimation
  mappedBones: MappedBone[]
  /** Precomputed ER bind world rotations (one per ER bone). */
  erBindWorldRot: Q4[]
  /** Precomputed ER bind world positions (one per ER bone). */
  erBindWorldPos: [number, number, number][]
  /** boneIdx → trackIdx, -1 if no track. */
  boneToTrack: Int32Array
  /** ER bone index whose world position we export as 全ての親 translation. */
  rootPosIdx: number
}

export interface HkxRetargetOptions {
  /** Reserved for future use. */
  _reserved?: never
}

export interface FrameResult {
  rotations: Record<string, Quat>
  positions: Record<string, Vec3>
}

/** FK on the ER skeleton using the given per-bone local rotations. Returns world rotations. */
function fkWorldRotations(hkx: HkxAnimation, localRot: Q4[]): Q4[] {
  const n = hkx.bones.length
  const out: Q4[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const pi = hkx.bones[i].parentIndex
    out[i] = pi < 0 ? localRot[i] : q4Mul(out[pi], localRot[i])
  }
  return out
}

/** FK on the ER skeleton using per-bone local rotations and per-bone local translations. Returns world positions. */
function fkWorldPositions(
  hkx: HkxAnimation,
  localRot: Q4[],
  localPos: [number, number, number][],
): [number, number, number][] {
  const n = hkx.bones.length
  const wRot: Q4[] = new Array(n)
  const wPos: [number, number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const pi = hkx.bones[i].parentIndex
    const lr = localRot[i]
    const lt = localPos[i]
    if (pi < 0) {
      wRot[i] = lr
      wPos[i] = [lt[0], lt[1], lt[2]]
    } else {
      wRot[i] = q4Mul(wRot[pi], lr)
      const r = q4Rot(wRot[pi], lt)
      wPos[i] = [r[0] + wPos[pi][0], r[1] + wPos[pi][1], r[2] + wPos[pi][2]]
    }
  }
  return wPos
}

export function createRetargetContext(hkx: HkxAnimation, _options?: HkxRetargetOptions): HkxRetargetContext {
  const n = hkx.bones.length

  // Precompute ER bind-pose world rotations and positions.
  const bindLocal: Q4[] = new Array(n)
  const bindLocalPos: [number, number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const r = hkx.bones[i].referencePose.rotation
    const t = hkx.bones[i].referencePose.translation
    bindLocal[i] = q4Normalize([r[0], r[1], r[2], r[3]])
    bindLocalPos[i] = [t[0], t[1], t[2]]
  }
  const erBindWorldRot = fkWorldRotations(hkx, bindLocal)
  const erBindWorldPos = fkWorldPositions(hkx, bindLocal, bindLocalPos)

  // boneIdx → trackIdx lookup.
  const boneToTrack = new Int32Array(n).fill(-1)
  for (let t = 0; t < hkx.trackToBone.length; t++) boneToTrack[hkx.trackToBone[t]] = t

  const nameToIdx = new Map<string, number>()
  for (let i = 0; i < n; i++) nameToIdx.set(hkx.bones[i].name, i)

  // Build mapped bone list with nearest mapped ancestor.
  const mappedBones: MappedBone[] = []
  for (const [erName, mmdName] of Object.entries(ER_BONE_MAP)) {
    const erIdx = nameToIdx.get(erName)
    if (erIdx === undefined) continue

    // Walk up the ER tree to find the nearest mapped ancestor.
    let parentMmdName: string | null = null
    let p = hkx.bones[erIdx].parentIndex
    while (p >= 0) {
      const parentErName = hkx.bones[p].name
      const parentMmd = ER_BONE_MAP[parentErName]
      if (parentMmd) {
        parentMmdName = parentMmd
        break
      }
      p = hkx.bones[p].parentIndex
    }

    mappedBones.push({ erName, mmdName, erIdx, parentMmdName })
  }

  // Whole-body translation source. Master is the top-level ER bone that carries
  // world movement (jump, lying down, locomotion).
  const rootPosIdx = nameToIdx.get("Master") ?? nameToIdx.get("Root") ?? -1

  return { hkx, mappedBones, erBindWorldRot, erBindWorldPos, boneToTrack, rootPosIdx }
}

/* ============================================================================
 * Per-frame retarget.
 * ========================================================================= */

function retargetFrame(ctx: HkxRetargetContext, frameIdx: number): FrameResult {
  const { hkx, mappedBones, erBindWorldRot, erBindWorldPos, boneToTrack } = ctx
  const n = hkx.bones.length
  const frame = hkx.frames[frameIdx]

  // Step 1: build per-bone animated local rotations and translations
  //         (track if present, else reference pose).
  const animLocal: Q4[] = new Array(n)
  const animLocalPos: [number, number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const ref = hkx.bones[i].referencePose
    const t = boneToTrack[i]
    if (t >= 0) {
      const ft = frame[t]
      animLocal[i] = [ft.rotation[0], ft.rotation[1], ft.rotation[2], ft.rotation[3]]
      animLocalPos[i] = [ft.translation[0], ft.translation[1], ft.translation[2]]
    } else {
      animLocal[i] = [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]]
      animLocalPos[i] = [ref.translation[0], ref.translation[1], ref.translation[2]]
    }
  }

  // Step 2: FK → animated ER world rotations.
  const erAnimWorldRot = fkWorldRotations(hkx, animLocal)

  // Step 3: per mapped bone, W_target = R_er · E⁻¹ (ER world delta from bind).
  const targetByMmd: Record<string, Q4> = {}
  for (const bone of mappedBones) {
    targetByMmd[bone.mmdName] = q4Mul(erAnimWorldRot[bone.erIdx], q4Conj(erBindWorldRot[bone.erIdx]))
  }

  // Step 4: q_vmd = W_target(mmd_parent)⁻¹ · W_target(mmd_b).
  const rotations: Record<string, Quat> = {}
  for (const bone of mappedBones) {
    const target = targetByMmd[bone.mmdName]
    const parentTarget = bone.parentMmdName ? targetByMmd[bone.parentMmdName] : null
    const local = parentTarget ? q4Mul(q4Conj(parentTarget), target) : target
    const nq = q4Normalize(local)
    rotations[bone.mmdName] = new Quat(nq[0], nq[1], nq[2], nq[3])
  }

  // Step 5: whole-body translation → 全ての親.
  // センター in MMD behaves like a waist bone (upper-body-ish), so for jumps
  // and lying-down poses we drive 全ての親 with the ER root's world-space
  // displacement from its bind position.
  const positions: Record<string, Vec3> = {}
  if (ctx.rootPosIdx >= 0) {
    const wp = fkWorldPositions(hkx, animLocal, animLocalPos)[ctx.rootPosIdx]
    const bp = erBindWorldPos[ctx.rootPosIdx]
    positions["全ての親"] = new Vec3(
      (wp[0] - bp[0]) * POSITION_SCALE,
      (wp[1] - bp[1]) * POSITION_SCALE,
      (wp[2] - bp[2]) * POSITION_SCALE,
    )
  }

  return { rotations, positions }
}

/* ============================================================================
 * Public API.
 * ========================================================================= */

export function computeHkxMmdFrame(hkx: HkxAnimation, frameIdx: number): FrameResult {
  return computeHkxMmdFrameWithCtx(createRetargetContext(hkx), frameIdx)
}

export function computeHkxMmdFrameWithCtx(ctx: HkxRetargetContext, frameIdx: number): FrameResult {
  if (frameIdx < 0 || frameIdx >= ctx.hkx.numFrames) return { rotations: {}, positions: {} }
  return retargetFrame(ctx, frameIdx)
}

export function retargetHkxClipWithCtx(ctx: HkxRetargetContext): RetargetedClip {
  const hkx = ctx.hkx
  const times = Array.from({ length: hkx.numFrames }, (_, i) => i / hkx.fps)
  const boneQuats: Record<string, Quat[]> = {}
  const rootPositions: Vec3[] = []

  for (let f = 0; f < hkx.numFrames; f++) {
    const { rotations, positions } = retargetFrame(ctx, f)
    for (const [name, q] of Object.entries(rotations)) {
      if (!boneQuats[name]) boneQuats[name] = []
      boneQuats[name].push(q)
    }
    if (positions["全ての親"]) rootPositions.push(positions["全ての親"])
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
    const rootOrig = ctx.rootPosIdx >= 0 ? hkx.bones[ctx.rootPosIdx].name : "Root"
    positionTracks.push({ name: "全ての親", originalName: rootOrig, times: [...times], positions: rootPositions })
  }

  return { name: hkx.name, duration: hkx.duration, fps: hkx.fps, boneTracks, positionTracks }
}

export function retargetHkxClip(hkx: HkxAnimation, options?: HkxRetargetOptions): RetargetedClip {
  return retargetHkxClipWithCtx(createRetargetContext(hkx, options))
}

/* ============================================================================
 * Debug helper.
 * ========================================================================= */

/** Dump ER skeleton (bones + ref poses + world positions/rotations) as JSON. */
export function logHkxSkeletonDefaultsToConsole(hkx: HkxAnimation): void {
  const n = hkx.bones.length
  const bindLocal: Q4[] = new Array(n)
  const bindLocalPos: [number, number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const r = hkx.bones[i].referencePose.rotation
    const t = hkx.bones[i].referencePose.translation
    bindLocal[i] = q4Normalize([r[0], r[1], r[2], r[3]])
    bindLocalPos[i] = [t[0], t[1], t[2]]
  }
  const worldRot = fkWorldRotations(hkx, bindLocal)
  const worldPos = fkWorldPositions(hkx, bindLocal, bindLocalPos)
  const bones = hkx.bones.map((b, i) => ({
    name: b.name,
    parentIndex: b.parentIndex,
    refTranslation: [...b.referencePose.translation],
    refRotation: [...b.referencePose.rotation],
    bindWorldPosition: worldPos[i],
    bindWorldRotation: worldRot[i],
  }))
  console.log("[hkx-skeleton.json]\n" + JSON.stringify({ skeletonName: hkx.name, bones }, null, 2))
}
