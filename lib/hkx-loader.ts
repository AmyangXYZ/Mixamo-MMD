import { Quat, Vec3 } from 'reze-engine';

// Elden Ring (c0000 player skeleton) bone name → MMD bone name
// Only mapping head/neck for initial testing
const ER_BONE_MAP: Record<string, string> = {
	'Neck':        '首',
	'Head':        '頭',
};

// ── Quaternion helpers ──

function quat(x: number, y: number, z: number, w: number): Quat {
	return new Quat(x, y, z, w);
}

function conjugate(q: Quat): Quat {
	return new Quat(-q.x, -q.y, -q.z, q.w);
}

function multiply(a: Quat, b: Quat): Quat {
	return new Quat(
		a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
		a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
		a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
		a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	);
}

// ── Types ──

export interface HkxBone {
	name: string;
	parentIndex: number;
	referencePose: {
		translation: number[];
		rotation: number[];
		scale: number[];
	};
}

export interface HkxFrameTransform {
	translation: number[];
	rotation: number[];
	scale: number[];
}

export interface HkxAnimation {
	name: string;
	duration: number;
	fps: number;
	numFrames: number;
	bones: HkxBone[];
	trackToBone: number[];
	frames: HkxFrameTransform[][];
	// Frame 0 rotations used as "rest" for delta computation
	frame0Rotations: Quat[];
}

export function loadHkxJson(json: Record<string, unknown>): HkxAnimation {
	const container = (json as { namedVariants: { name: string; variant: Record<string, unknown> }[] })
		.namedVariants[1].variant;

	const skel = (container.skeletons as Record<string, unknown>[])[0];
	const anim = (container.animations as Record<string, unknown>[])[0];
	const binding = (container.bindings as Record<string, unknown>[])[0];

	const boneList = skel.bones as { name: string }[];
	const parentIndices = skel.parentIndices as number[];
	const refPose = skel.referencePose as { translation: number[]; rotation: number[]; scale: number[] }[];

	const bones: HkxBone[] = boneList.map((b, i) => ({
		name: b.name,
		parentIndex: parentIndices[i],
		referencePose: refPose[i],
	}));

	const trackToBone = binding.transformTrackToBoneIndices as number[];
	const frames = anim.frames as HkxFrameTransform[][];

	// Cache frame 0 rotations as Quats for delta computation
	const frame0 = frames[0];
	const frame0Rotations = frame0.map(ft => {
		const r = ft.rotation;
		return quat(r[0], r[1], r[2], r[3]);
	});

	return {
		name: (skel.name as string) || 'unknown',
		duration: anim.duration as number,
		fps: Math.round(1.0 / (anim.frameDuration as number)),
		numFrames: anim.numDecompressedFrames as number,
		bones,
		trackToBone,
		frames,
		frame0Rotations,
	};
}

export const POSITION_SCALE = 1 / 12.5;
export const POSITION_OFFSET_Y = -8.3;

// Convert delta quaternion from ER bone-local space to MMD bone-local space.
// ER is right-handed Z-up, MMD is left-handed Y-up.
// For a local-frame delta (small rotation relative to rest), we try these conversions:
// 'raw' = pass animation quat directly (no delta, no conversion)
// 'ref_delta' = classic ref_inv * anim delta, no conversion
// others = frame0-based delta with coordinate conversions
export type ConversionMode = 'raw' | 'ref_delta' | 'identity' | 'negate_zw' | 'swap_yz' | 'swap_yz_neg_w' | 'negate_yw';

export const ALL_MODES: ConversionMode[] = ['raw', 'ref_delta', 'identity', 'negate_zw', 'swap_yz', 'swap_yz_neg_w', 'negate_yw'];

function convertDelta(q: Quat, mode: ConversionMode): Quat {
	switch (mode) {
		case 'raw':           return q; // shouldn't reach here
		case 'ref_delta':     return q; // shouldn't reach here
		case 'identity':      return quat(q.x, q.y, q.z, q.w);
		case 'negate_zw':     return quat(q.x, q.y, -q.z, -q.w);
		case 'swap_yz':       return quat(q.x, q.z, q.y, q.w);
		case 'swap_yz_neg_w': return quat(q.x, q.z, q.y, -q.w);
		case 'negate_yw':     return quat(q.x, -q.y, q.z, -q.w);
	}
}

let currentMode: ConversionMode = 'raw';
export function setConversionMode(mode: ConversionMode) { currentMode = mode; }
export function getConversionMode(): ConversionMode { return currentMode; }

export function getFrameBoneData(
	hkx: HkxAnimation,
	frameIndex: number
): { rotations: Record<string, Quat>; positions: Record<string, Vec3> } {
	const frameData = hkx.frames[frameIndex];
	const rotations: Record<string, Quat> = {};
	const positions: Record<string, Vec3> = {};

	for (let track = 0; track < frameData.length; track++) {
		const boneIdx = hkx.trackToBone[track];
		const bone = hkx.bones[boneIdx];
		const mmdName = ER_BONE_MAP[bone.name];
		if (!mmdName) continue;

		const ft = frameData[track];
		const qAnim = quat(ft.rotation[0], ft.rotation[1], ft.rotation[2], ft.rotation[3]);

		if (currentMode === 'raw') {
			// Pass the absolute local rotation straight through
			rotations[mmdName] = qAnim;
		} else if (currentMode === 'ref_delta') {
			// Delta from bind-pose reference: ref_inv * anim
			const ref = bone.referencePose.rotation;
			const qRef = quat(ref[0], ref[1], ref[2], ref[3]);
			rotations[mmdName] = multiply(conjugate(qRef), qAnim);
		} else {
			// Delta from frame 0: frame0_inv * frameN, then coordinate convert
			const qFrame0 = hkx.frame0Rotations[track];
			const qDelta = multiply(conjugate(qFrame0), qAnim);
			rotations[mmdName] = convertDelta(qDelta, currentMode);
		}
	}

	return { rotations, positions };
}

export function getAvailableAnimations(): { id: string; name: string; category: string }[] {
	const anims = [
		{ id: 'a000_000000', category: 'Idle' },
		{ id: 'a000_003000', category: 'Attack' },
	];
	return anims.map(a => ({ ...a, name: a.id }));
}
