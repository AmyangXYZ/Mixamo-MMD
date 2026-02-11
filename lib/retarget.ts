import { Quat, Vec3 } from 'reze-engine';
import type { AnimationClip, BoneTrack, PositionTrack } from './fbx';

const BONE_MAP: Record<string, string> = {
	'Hips': 'センター',
	'Spine': '腰',
	'Spine1': '上半身',
	'Spine2': '上半身2',
	'Neck': '首',
	'Head': '頭',
	'RightShoulder': '右肩',
	'RightArm': '右腕',
	'RightForeArm': '右ひじ',
	'RightHand': '右手首',
	'LeftShoulder': '左肩',
	'LeftArm': '左腕',
	'LeftForeArm': '左ひじ',
	'LeftHand': '左手首',
	'RightUpLeg': '右足',
	'RightLeg': '右ひざ',
	'RightFoot': '右足首',
	'RightToeBase': '右足先EX',
	'LeftUpLeg': '左足',
	'LeftLeg': '左ひざ',
	'LeftFoot': '左足首',
	'LeftToeBase': '左足先EX',
	'RightHandThumb1': '右親指１',
	'RightHandThumb2': '右親指２',
	'RightHandThumb3': '右親指３',
	'RightHandIndex1': '右人指１',
	'RightHandIndex2': '右人指２',
	'RightHandIndex3': '右人指３',
	'RightHandMiddle1': '右中指１',
	'RightHandMiddle2': '右中指２',
	'RightHandMiddle3': '右中指３',
	'RightHandRing1': '右薬指１',
	'RightHandRing2': '右薬指２',
	'RightHandRing3': '右薬指３',
	'RightHandPinky1': '右小指１',
	'RightHandPinky2': '右小指２',
	'RightHandPinky3': '右小指３',
	'LeftHandThumb1': '左親指１',
	'LeftHandThumb2': '左親指２',
	'LeftHandThumb3': '左親指３',
	'LeftHandIndex1': '左人指１',
	'LeftHandIndex2': '左人指２',
	'LeftHandIndex3': '左人指３',
	'LeftHandMiddle1': '左中指１',
	'LeftHandMiddle2': '左中指２',
	'LeftHandMiddle3': '左中指３',
	'LeftHandRing1': '左薬指１',
	'LeftHandRing2': '左薬指２',
	'LeftHandRing3': '左薬指３',
	'LeftHandPinky1': '左小指１',
	'LeftHandPinky2': '左小指２',
	'LeftHandPinky3': '左小指３',
};


const MIXAMO_MATRIX_LOCAL: Record<string, Quat> = {
	'Hips': new Quat(0.0065, 0, 0, 0.99998),
	'Spine': new Quat(-0.0737, 0, 0, 0.9973),
	'Spine1': new Quat(-0.0737, 0, 0, 0.9973),
	'Spine2': new Quat(-0.0609, 0, 0, 0.9981),
	'Neck': new Quat(-0.0609, 0, 0, 0.9981),
	'Head': new Quat(-0.0609, 0, 0, 0.9981),
	'RightShoulder': new Quat(0.459, -0.5379, 0.5599, 0.4318),
	'RightArm': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightForeArm': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHand': new Quat(0.5, -0.5, 0.5, 0.5),
	'LeftShoulder': new Quat(-0.459, -0.5379, 0.5599, -0.4318),
	'LeftArm': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftForeArm': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHand': new Quat(0.5, 0.5, -0.5, 0.5),
	'RightUpLeg': new Quat(0, 0.0039, 0.99999, 0),
	'RightLeg': new Quat(0, -0.0342, 0.99942, 0),
	'RightFoot': new Quat(0, 0.4291, 0.90326, 0),
	'RightToeBase': new Quat(0, 0.7071, 0.7071, 0),
	'LeftUpLeg': new Quat(0, 0.0039, 0.99999, 0),
	'LeftLeg': new Quat(0, -0.0342, 0.99942, 0),
	'LeftFoot': new Quat(0, 0.4291, 0.90326, 0),
	'LeftToeBase': new Quat(0, 0.7071, 0.7071, 0),
	'RightHandThumb1': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandThumb2': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandThumb3': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandIndex1': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandIndex2': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandIndex3': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandMiddle1': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandMiddle2': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandMiddle3': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandRing1': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandRing2': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandRing3': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandPinky1': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandPinky2': new Quat(0.5, -0.5, 0.5, 0.5),
	'RightHandPinky3': new Quat(0.5, -0.5, 0.5, 0.5),
	'LeftHandThumb1': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandThumb2': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandThumb3': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandIndex1': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandIndex2': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandIndex3': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandMiddle1': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandMiddle2': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandMiddle3': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandRing1': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandRing2': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandRing3': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandPinky1': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandPinky2': new Quat(0.5, 0.5, -0.5, 0.5),
	'LeftHandPinky3': new Quat(0.5, 0.5, -0.5, 0.5),
};

const ROTATE_WAB_L_SET = new Set([
	'LeftArm', 'LeftForeArm',
	'LeftHandThumb1', 'LeftHandThumb2', 'LeftHandThumb3',
	'LeftHandIndex1', 'LeftHandIndex2', 'LeftHandIndex3',
	'LeftHandMiddle1', 'LeftHandMiddle2', 'LeftHandMiddle3',
	'LeftHandRing1', 'LeftHandRing2', 'LeftHandRing3',
	'LeftHandPinky1', 'LeftHandPinky2', 'LeftHandPinky3',
]);

const ROTATE_WAB_R_SET = new Set([
	'RightArm', 'RightForeArm',
	'RightHandThumb1', 'RightHandThumb2', 'RightHandThumb3',
	'RightHandIndex1', 'RightHandIndex2', 'RightHandIndex3',
	'RightHandMiddle1', 'RightHandMiddle2', 'RightHandMiddle3',
	'RightHandRing1', 'RightHandRing2', 'RightHandRing3',
	'RightHandPinky1', 'RightHandPinky2', 'RightHandPinky3',
]);

const ROTATE_WBA_L_SET = new Set([
	'LeftForeArm',
	'LeftHandThumb1', 'LeftHandThumb2', 'LeftHandThumb3',
	'LeftHandIndex1', 'LeftHandIndex2', 'LeftHandIndex3',
	'LeftHandMiddle1', 'LeftHandMiddle2', 'LeftHandMiddle3',
	'LeftHandRing1', 'LeftHandRing2', 'LeftHandRing3',
	'LeftHandPinky1', 'LeftHandPinky2', 'LeftHandPinky3',
]);

const ROTATE_WBA_R_SET = new Set([
	'RightForeArm',
	'RightHandThumb1', 'RightHandThumb2', 'RightHandThumb3',
	'RightHandIndex1', 'RightHandIndex2', 'RightHandIndex3',
	'RightHandMiddle1', 'RightHandMiddle2', 'RightHandMiddle3',
	'RightHandRing1', 'RightHandRing2', 'RightHandRing3',
	'RightHandPinky1', 'RightHandPinky2', 'RightHandPinky3',
]);

const ARM_ANGLE = 35 * Math.PI / 180;
const Q_ARM_L = Quat.fromAxisAngle(new Vec3(0, 0, 1), ARM_ANGLE);
const Q_ARM_R = Quat.fromAxisAngle(new Vec3(0, 0, 1), -ARM_ANGLE);

interface RetargetTransform {
	q_l: Quat;
	q_r: Quat;
}

const RETARGET_TRANSFORMS: Record<string, RetargetTransform> = {};

function computeRetargetTransforms(): void {
	for (const [mixamoName] of Object.entries(BONE_MAP)) {
		const q_a = MIXAMO_MATRIX_LOCAL[mixamoName];
		if (!q_a) continue;
		
		const q_ai = q_a.clone().conjugate();
		
		let q_r: Quat;
		if (ROTATE_WAB_L_SET.has(mixamoName)) {
			q_r = q_ai.multiply(Q_ARM_L);
		} else if (ROTATE_WAB_R_SET.has(mixamoName)) {
			q_r = q_ai.multiply(Q_ARM_R);
		} else {
			q_r = q_ai;
		}
		
		let q_l: Quat;
		if (ROTATE_WBA_L_SET.has(mixamoName)) {
			q_l = Q_ARM_R.multiply(q_a);
		} else if (ROTATE_WBA_R_SET.has(mixamoName)) {
			q_l = Q_ARM_L.multiply(q_a);
		} else {
			q_l = q_a;
		}
		
		RETARGET_TRANSFORMS[mixamoName] = { q_l, q_r };
	}
}

computeRetargetTransforms();

export interface RetargetedBoneTrack {
	name: string;
	originalName: string;
	times: number[];
	quats: Quat[];
}

export interface RetargetedPositionTrack {
	name: string;
	originalName: string;
	times: number[];
	positions: Vec3[];
}

export interface RetargetedClip {
	name: string;
	duration: number;
	fps: number;
	boneTracks: RetargetedBoneTrack[];
	positionTracks: RetargetedPositionTrack[];
}


export const POSITION_SCALE = 1 / 12.5;
export const POSITION_OFFSET_Y = -8.3;

/**
 * Calculate duration from animation clip times
 */
function calculateDuration(clip: AnimationClip): number {
	if (clip.duration > 0) return clip.duration;
	
	// Collect all unique times from all tracks
	const allTimes = new Set<number>();
	clip.tracks.forEach(track => track.times.forEach(t => allTimes.add(t)));
	clip.positionTracks?.forEach(track => track.times.forEach(t => allTimes.add(t)));
	
	const sortedTimes = Array.from(allTimes).sort((a, b) => a - b);
	if (sortedTimes.length === 0) return 0;
	
	return sortedTimes[sortedTimes.length - 1];
}

export function retargetClips(clips: AnimationClip[]): RetargetedClip[] {
	return clips.map(clip => {
		const duration = calculateDuration(clip);
		return {
			name: clip.name,
			duration,
			fps: 30, // Hardcoded to 30 FPS
			boneTracks: clip.tracks.map(retargetBoneTrack),
			positionTracks: (clip.positionTracks || []).map(retargetPositionTrack)
		};
	});
}

function mapBoneName(name: string): { mixamoName: string; mmdName: string } {
	const match = name.match(/^mixamorig:(.+)$/);
	const mixamoName = match?.[1] ?? name;
	const mmdName = BONE_MAP[mixamoName] ?? mixamoName;
	return { mixamoName, mmdName };
}

function retargetBoneTrack(track: BoneTrack): RetargetedBoneTrack {
	const { mixamoName, mmdName } = mapBoneName(track.name);
	const transform = RETARGET_TRANSFORMS[mixamoName];
	
	return {
		name: mmdName,
		originalName: track.original_name,
		times: track.times,
		quats: track.quats.map(q => {
			if (!transform) {
				return new Quat(q.x, q.y, -q.z, -q.w);
			}
			
			const result = transform.q_l.multiply(q).multiply(transform.q_r);
			return new Quat(result.x, result.y, -result.z, -result.w);
		})
	};
}

function retargetPositionTrack(track: PositionTrack): RetargetedPositionTrack {
	const { mixamoName, mmdName } = mapBoneName(track.name);
	const transform = RETARGET_TRANSFORMS[mixamoName];
	const q_l = transform?.q_l ?? Quat.identity();
	
	return {
		name: mmdName,
		originalName: track.original_name,
		times: track.times,
		positions: track.positions.map((p) => {
			if (!Array.isArray(p) || p.length !== 3) {
				return new Vec3(0, 0, 0);
			}
			const px = p[0], py = p[1], pz = p[2];
			const qx = q_l.x, qy = q_l.y, qz = q_l.z, qw = q_l.w;
			
			const tx = 2 * (qy * pz - qz * py);
			const ty = 2 * (qz * px - qx * pz);
			const tz = 2 * (qx * py - qy * px);
			
			const rx = px + qw * tx + (qy * tz - qz * ty);
			const ry = py + qw * ty + (qz * tx - qx * tz);
			const rz = pz + qw * tz + (qx * ty - qy * tx);
			
			const sx = rx * POSITION_SCALE ;
			const sy = ry * POSITION_SCALE  + POSITION_OFFSET_Y;
			const sz = rz * POSITION_SCALE;
			
			return new Vec3(sx, sy, -sz);
		})
	};
}