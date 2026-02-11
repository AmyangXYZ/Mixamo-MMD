import { Quat, Vec3 } from 'reze-engine';
import Encoding from 'encoding-japanese';
import type { RetargetedClip, RetargetedBoneTrack, RetargetedPositionTrack } from './retarget';

interface VMDBoneKeyframe {
	boneName: string;
	frameNumber: number;
	position: Vec3;
	rotation: Quat;
}

function encodeShiftJIS(str: string): Uint8Array {
	const unicodeArray = Encoding.stringToCode(str);
	const sjisArray = Encoding.convert(unicodeArray, { to: 'SJIS', from: 'UNICODE' });
	return new Uint8Array(sjisArray);
}

function writeBoneFrame(dataView: DataView, offset: number, keyframe: VMDBoneKeyframe): number {
	const nameBytes = encodeShiftJIS(keyframe.boneName);
	for (let i = 0; i < 15; i++) {
		dataView.setUint8(offset + i, i < nameBytes.length ? nameBytes[i] : 0);
	}
	offset += 15;

	dataView.setUint32(offset, keyframe.frameNumber, true);
	offset += 4;

	const posX = isFinite(keyframe.position.x) ? keyframe.position.x : 0;
	const posY = isFinite(keyframe.position.y) ? keyframe.position.y : 0;
	const posZ = isFinite(keyframe.position.z) ? keyframe.position.z : 0;
	dataView.setFloat32(offset, posX, true);
	dataView.setFloat32(offset + 4, posY, true);
	dataView.setFloat32(offset + 8, posZ, true);
	offset += 12;

	const rotX = isFinite(keyframe.rotation.x) ? keyframe.rotation.x : 0;
	const rotY = isFinite(keyframe.rotation.y) ? keyframe.rotation.y : 0;
	const rotZ = isFinite(keyframe.rotation.z) ? keyframe.rotation.z : 0;
	const rotW = isFinite(keyframe.rotation.w) ? keyframe.rotation.w : 1;
	dataView.setFloat32(offset, rotX, true);
	dataView.setFloat32(offset + 4, rotY, true);
	dataView.setFloat32(offset + 8, rotZ, true);
	dataView.setFloat32(offset + 12, rotW, true);
	offset += 16;

	for (let i = 0; i < 64; i++) {
		dataView.setUint8(offset + i, 20);
	}
	offset += 64;

	return offset;
}

function interpolateQuat(track: RetargetedBoneTrack, time: number): Quat {
	const idx = track.times.findIndex(t => t >= time);
	if (idx === -1) return track.quats[track.quats.length - 1];
	if (idx === 0 || track.times[idx] === time) return track.quats[idx];
	
	const t0 = track.times[idx - 1];
	const t1 = track.times[idx];
	const t = (time - t0) / (t1 - t0);
	const q0 = track.quats[idx - 1];
	const q1 = track.quats[idx];
	
	// Use proper quaternion slerp
	const dot = q0.x * q1.x + q0.y * q1.y + q0.z * q1.z + q0.w * q1.w;
	const q1Adjusted = dot < 0 
		? new Quat(-q1.x, -q1.y, -q1.z, -q1.w)
		: q1;
	
	const angle = Math.acos(Math.abs(dot));
	if (Math.abs(angle) < 0.001) {
		// Quaternions are very close, use linear interpolation
		return new Quat(
			q0.x + (q1Adjusted.x - q0.x) * t,
			q0.y + (q1Adjusted.y - q0.y) * t,
			q0.z + (q1Adjusted.z - q0.z) * t,
			q0.w + (q1Adjusted.w - q0.w) * t
		).normalize();
	}
	
	const sinAngle = Math.sin(angle);
	const w0 = Math.sin((1 - t) * angle) / sinAngle;
	const w1 = Math.sin(t * angle) / sinAngle;
	
	return new Quat(
		w0 * q0.x + w1 * q1Adjusted.x,
		w0 * q0.y + w1 * q1Adjusted.y,
		w0 * q0.z + w1 * q1Adjusted.z,
		w0 * q0.w + w1 * q1Adjusted.w
	).normalize();
}

function interpolatePosition(track: RetargetedPositionTrack, time: number): Vec3 {
	const idx = track.times.findIndex(t => t >= time);
	if (idx === -1) return track.positions[track.positions.length - 1];
	if (idx === 0 || track.times[idx] === time) return track.positions[idx];
	
	const t0 = track.times[idx - 1];
	const t1 = track.times[idx];
	const t = (time - t0) / (t1 - t0);
	const p0 = track.positions[idx - 1];
	const p1 = track.positions[idx];
	
	return new Vec3(
		p0.x + (p1.x - p0.x) * t,
		p0.y + (p1.y - p0.y) * t,
		p0.z + (p1.z - p0.z) * t
	);
}

export function convertToVMD(clip: RetargetedClip, fps: number = 30): Blob {
	// Collect all unique times from both rotation and position tracks
	const allTimes = new Set<number>();
	clip.boneTracks.forEach(track => track.times.forEach(t => allTimes.add(t)));
	clip.positionTracks?.forEach(track => track.times.forEach(t => allTimes.add(t)));
	
	const sortedTimes = Array.from(allTimes).sort((a, b) => a - b);
	if (sortedTimes.length === 0) return new Blob();

	const positionTrackMap = new Map<string, RetargetedPositionTrack>();
	clip.positionTracks?.forEach(track => positionTrackMap.set(track.name, track));


	const keyframes: VMDBoneKeyframe[] = [];
	const keyframeMap = new Map<string, Map<number, VMDBoneKeyframe>>();
	
	for (const track of clip.boneTracks) {
		const boneKeyframes = new Map<number, VMDBoneKeyframe>();
		const posTrack = positionTrackMap.get(track.name);
		
		const boneTimes = new Set<number>(track.times);
		if (posTrack) {
			posTrack.times.forEach(t => boneTimes.add(t));
		}
		const sortedBoneTimes = Array.from(boneTimes).sort((a, b) => a - b);
		
		for (const time of sortedBoneTimes) {
			const frameNumber = Math.round(time * fps);
			
			const rotationIdx = track.times.findIndex(t => Math.abs(t - time) < 0.0001);
			const rotation = rotationIdx >= 0 ? track.quats[rotationIdx] : interpolateQuat(track, time);
			
			let position: Vec3;
			if (posTrack) {
				const positionIdx = posTrack.times.findIndex(t => Math.abs(t - time) < 0.0001);
				position = positionIdx >= 0 ? posTrack.positions[positionIdx] : interpolatePosition(posTrack, time);
			} else {
				position = new Vec3(0, 0, 0);
			}

			const vmdPosition = position;
			
			boneKeyframes.set(frameNumber, {
				boneName: track.name,
				frameNumber,
				position: vmdPosition,
				rotation
			});
		}
		
		keyframeMap.set(track.name, boneKeyframes);
	}
	
	const rotationBoneNames = new Set(clip.boneTracks.map(t => t.name));
	for (const posTrack of clip.positionTracks || []) {
		if (!rotationBoneNames.has(posTrack.name)) {
			const boneKeyframes = new Map<number, VMDBoneKeyframe>();
			
			for (const time of posTrack.times) {
				const frameNumber = Math.round(time * fps);
				const positionIdx = posTrack.times.findIndex(t => Math.abs(t - time) < 0.0001);
				const position = positionIdx >= 0 ? posTrack.positions[positionIdx] : interpolatePosition(posTrack, time);
				
				// Write positions as-is (same format as playClipDirectly uses with moveBones)
				const vmdPosition = position;
				
				boneKeyframes.set(frameNumber, {
					boneName: posTrack.name,
					frameNumber,
					position: vmdPosition,
					rotation: new Quat(0, 0, 0, 1)
				});
			}
			
			keyframeMap.set(posTrack.name, boneKeyframes);
		}
	}
	
	for (const boneKeyframes of keyframeMap.values()) {
		for (const keyframe of boneKeyframes.values()) {
			keyframes.push(keyframe);
		}
	}
	
	keyframes.sort((a, b) => {
		if (a.frameNumber !== b.frameNumber) {
			return a.frameNumber - b.frameNumber;
		}
		return a.boneName.localeCompare(b.boneName);
	});

	// IK bones to disable (Mixamo animations don't use IK)
	const ikDisabledBones = [
		'右足IK親',
		'左足IK親',
		'右足ＩＫ',
		'左足ＩＫ',
		'右つま先ＩＫ',
		'左つま先ＩＫ',
	];
	const hasPropertyKeyframes = ikDisabledBones.length > 0;
	const propertyKeyframeSize = 4 + 1 + 4 + (ikDisabledBones.length * (20 + 1)); // frame + visibility + ik_count + ik_states

	const headerSize = 50; // 30 bytes header + 20 bytes model name
	const boneFrameSize = 111; // 15 (name) + 4 (frame) + 12 (position) + 16 (rotation) + 64 (interpolation)
	const morphFrameCount = 0;
	const morphFrameSize = 23; // 15 (name) + 4 (frame) + 4 (weight)
	const cameraFrameCount = 0;
	const lightFrameCount = 0;
	const selfShadowFrameCount = 0;
	const propertyKeyframeCount = hasPropertyKeyframes ? 1 : 0;
	
	const totalSize = headerSize + 
		4 + (boneFrameSize * keyframes.length) + // bone frame count + frames
		4 + (morphFrameSize * morphFrameCount) + // morph frame count + frames
		4 + // camera keyframe count
		4 + // light keyframe count
		4 + // self shadow keyframe count
		4 + (propertyKeyframeSize * propertyKeyframeCount); // property keyframe count + frames

	const buffer = new ArrayBuffer(totalSize);
	const dataView = new DataView(buffer);
	let offset = 0;

	const header = 'Vocaloid Motion Data 0002';
	for (let i = 0; i < 30; i++) {
		dataView.setUint8(offset + i, i < header.length ? header.charCodeAt(i) : 0);
	}
	offset += 30;

	for (let i = 0; i < 20; i++) {
		dataView.setUint8(offset + i, 0);
	}
	offset += 20;

	dataView.setUint32(offset, keyframes.length, true);
	offset += 4;

	for (const keyframe of keyframes) {
		offset = writeBoneFrame(dataView, offset, keyframe);
	}

	dataView.setUint32(offset, morphFrameCount, true);
	offset += 4;
	dataView.setUint32(offset, cameraFrameCount, true);
	offset += 4;
	dataView.setUint32(offset, lightFrameCount, true);
	offset += 4;
	dataView.setUint32(offset, selfShadowFrameCount, true);
	offset += 4;
	dataView.setUint32(offset, propertyKeyframeCount, true);
	offset += 4;

	if (hasPropertyKeyframes) {
		dataView.setUint32(offset, 0, true);
		offset += 4;
		dataView.setUint8(offset, 1);
		offset += 1;
		dataView.setUint32(offset, ikDisabledBones.length, true);
		offset += 4;

		for (const boneName of ikDisabledBones) {
			const nameBytes = encodeShiftJIS(boneName);
			for (let i = 0; i < 20; i++) {
				dataView.setUint8(offset + i, i < nameBytes.length ? nameBytes[i] : 0);
			}
			offset += 20;
			dataView.setUint8(offset, 0);
			offset += 1;
		}
	}

	return new Blob([buffer], { type: 'application/octet-stream' });
}

export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

export function getBlobURL(blob: Blob): string {
	return URL.createObjectURL(blob);
}

export function playClipDirectly(
	clip: RetargetedClip,
	engine: { rotateBones: (rotations: Record<string, Quat>, duration: number) => void; moveBones: (positions: Record<string, Vec3>, duration: number) => void }
): () => void {
	const allTimes = new Set<number>();
	clip.boneTracks.forEach(track => track.times.forEach(t => allTimes.add(t)));
	clip.positionTracks?.forEach(track => track.times.forEach(t => allTimes.add(t)));
	const sortedTimes = Array.from(allTimes).sort((a, b) => a - b);

	if (sortedTimes.length === 0) return () => {};

	const positionTrackMap = new Map<string, RetargetedPositionTrack>();
	clip.positionTracks?.forEach(track => positionTrackMap.set(track.name, track));

	let frameIndex = 0;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	const playFrame = () => {
		if (stopped) return;
		if (frameIndex >= sortedTimes.length) frameIndex = 0;

		const time = sortedTimes[frameIndex];
		const nextTime = sortedTimes[frameIndex + 1];
		const duration = nextTime ? (nextTime - time) * 1000 : 16;

		const rotations: Record<string, Quat> = {};
		clip.boneTracks.forEach(track => {
			rotations[track.name] = interpolateQuat(track, time);
		});

		const positions: Record<string, Vec3> = {};
		clip.positionTracks?.forEach(track => {
			positions[track.name] = interpolatePosition(track, time);
		});

		if (Object.keys(rotations).length > 0) engine.rotateBones(rotations, duration);
		if (Object.keys(positions).length > 0) engine.moveBones(positions, duration);

		frameIndex++;

		if (frameIndex < sortedTimes.length) {
			const delay = (sortedTimes[frameIndex] - time) * 1000;
			timeoutId = setTimeout(playFrame, delay);
		}
	};

	playFrame();

	return () => {
		stopped = true;
		if (timeoutId) clearTimeout(timeoutId);
	};
}
