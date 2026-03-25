"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Play, Pause } from "lucide-react"
import Link from "next/link"

const ANIM_IDS = [
	'a000_000000', 'a000_001020',
	'a000_002000', 'a000_002001', 'a000_002002', 'a000_002003', 'a000_002100',
	'a000_003000', 'a000_003001', 'a000_003003', 'a000_003004', 'a000_003005',
	'a000_003006', 'a000_003007', 'a000_003008', 'a000_003009', 'a000_003010',
	'a000_003011', 'a000_003012', 'a000_003013', 'a000_003014', 'a000_003015',
	'a000_003016', 'a000_003018', 'a000_003019', 'a000_003020', 'a000_003021',
	'a000_003022', 'a000_003023', 'a000_003024',
	'a000_006000', 'a000_006001', 'a000_006002', 'a000_006003',
	'a000_006010', 'a000_006011', 'a000_006012', 'a000_006013',
]

interface AnimData {
	bones: { name: string; parentIndex: number }[]
	refPose: { translation: number[]; rotation: number[]; scale: number[] }[]
	trackToBone: number[]
	frames: { translation: number[]; rotation: number[]; scale: number[] }[][]
	numFrames: number
	fps: number
	duration: number
}

function loadAnimJson(json: Record<string, unknown>): AnimData {
	const container = (json as { namedVariants: { variant: Record<string, unknown> }[] })
		.namedVariants[1].variant
	const skel = (container.skeletons as Record<string, unknown>[])[0]
	const anim = (container.animations as Record<string, unknown>[])[0]
	const binding = (container.bindings as Record<string, unknown>[])[0]

	return {
		bones: (skel.bones as { name: string }[]).map((b, i) => ({
			name: b.name,
			parentIndex: (skel.parentIndices as number[])[i],
		})),
		refPose: skel.referencePose as AnimData["refPose"],
		trackToBone: binding.transformTrackToBoneIndices as number[],
		frames: anim.frames as AnimData["frames"],
		numFrames: anim.numDecompressedFrames as number,
		fps: Math.round(1.0 / (anim.frameDuration as number)),
		duration: anim.duration as number,
	}
}

// FK: accumulate local transforms to produce world positions.
// Ref pose is Z-up (needs conversion). Animation root bone maps to Y-up natively.
function computeWorldPositions(anim: AnimData, frameIdx: number): THREE.Vector3[] {
	const n = anim.bones.length
	const wPos: [number, number, number][] = new Array(n)
	const wRot: [number, number, number, number][] = new Array(n)

	const boneToTrack = new Map<number, number>()
	for (let t = 0; t < anim.trackToBone.length; t++) {
		boneToTrack.set(anim.trackToBone[t], t)
	}

	const frame = frameIdx >= 0 ? anim.frames[frameIdx] : null

	for (let i = 0; i < n; i++) {
		const ref = anim.refPose[i]
		const track = boneToTrack.get(i)

		let lr: [number, number, number, number]
		let lt: [number, number, number]

		if (frame && track !== undefined) {
			const ft = frame[track]
			lr = [ft.rotation[0], ft.rotation[1], ft.rotation[2], ft.rotation[3]]
			lt = [ft.translation[0], ft.translation[1], ft.translation[2]]
		} else {
			lr = [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]]
			lt = [ref.translation[0], ref.translation[1], ref.translation[2]]
		}

		const pi = anim.bones[i].parentIndex
		if (pi < 0) {
			wRot[i] = lr
			wPos[i] = lt
		} else {
			wRot[i] = qmul4(wRot[pi], lr)
			const rotated = qrot4(wRot[pi], lt)
			wPos[i] = [rotated[0] + wPos[pi][0], rotated[1] + wPos[pi][1], rotated[2] + wPos[pi][2]]
		}
	}

	// Raw world positions — no axis swapping, preserves native Havok coordinates
	return wPos.map(p => new THREE.Vector3(p[0], p[1], p[2]))
}

function qmul4(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
	const [ax, ay, az, aw] = a; const [bx, by, bz, bw] = b
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	]
}

function qrot4(q: [number, number, number, number], v: [number, number, number]): [number, number, number] {
	const qc: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]]
	const t = qmul4(q, [v[0], v[1], v[2], 0])
	const r = qmul4(t, qc)
	return [r[0], r[1], r[2]]
}

// Key body bone names to highlight
const IMPORTANT_BONES = new Set([
	'Master', 'RootPos', 'Pelvis', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
	'L_Clavicle', 'L_UpperArm', 'L_Forearm', 'L_Hand',
	'R_Clavicle', 'R_UpperArm', 'R_Forearm', 'R_Hand',
	'L_Thigh', 'L_Calf', 'L_Foot', 'L_Toe0',
	'R_Thigh', 'R_Calf', 'R_Foot', 'R_Toe0',
	'RootRotY', 'RootRotXZ',
])

export default function HkxThree() {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const sceneRef = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls } | null>(null)
	const skeletonGroupRef = useRef<THREE.Group | null>(null)
	const jointSpheresRef = useRef<THREE.Mesh[]>([])
	const boneLinesRef = useRef<THREE.Line | null>(null)
	const animRef = useRef<AnimData | null>(null)
	const rafRef = useRef<number | null>(null)
	const playStartRef = useRef(0)
	const frameAtPlayStart = useRef(0)

	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [currentFrame, setCurrentFrame] = useState(0)
	const [totalFrames, setTotalFrames] = useState(0)
	const [isPlaying, setIsPlaying] = useState(false)
	const [animId, setAnimId] = useState(ANIM_IDS[0])
	const [info, setInfo] = useState('')
	const [hoveredBone, setHoveredBone] = useState<string | null>(null)
	const [showRefPose, setShowRefPose] = useState(false)

	const applyFrame = useCallback((frameIdx: number) => {
		const anim = animRef.current
		const spheres = jointSpheresRef.current
		const boneLine = boneLinesRef.current
		if (!anim || !boneLine || frameIdx < 0 || frameIdx >= anim.numFrames) return

		const worldPos = computeWorldPositions(anim, frameIdx)

		// Update joint spheres
		for (let i = 0; i < anim.bones.length && i < spheres.length; i++) {
			spheres[i].position.copy(worldPos[i])
		}

		// Update bone lines
		const positions: number[] = []
		for (let i = 0; i < anim.bones.length; i++) {
			const pi = anim.bones[i].parentIndex
			if (pi < 0) continue
			positions.push(worldPos[pi].x, worldPos[pi].y, worldPos[pi].z)
			positions.push(worldPos[i].x, worldPos[i].y, worldPos[i].z)
		}
		const geo = boneLine.geometry as THREE.BufferGeometry
		geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
		geo.attributes.position.needsUpdate = true

		currentFrameRef.current = frameIdx
		setCurrentFrame(frameIdx)
	}, [])

	const stopPlayback = useCallback(() => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current)
			rafRef.current = null
		}
		setIsPlaying(false)
	}, [])

	const currentFrameRef = useRef(0)

	const startPlayback = useCallback(() => {
		const anim = animRef.current
		if (!anim) return
		setIsPlaying(true)
		playStartRef.current = performance.now()
		frameAtPlayStart.current = currentFrameRef.current

		const tick = () => {
			const a = animRef.current
			if (!a) return
			const elapsed = (performance.now() - playStartRef.current) / 1000
			const frameDelta = Math.floor(elapsed * a.fps)
			let frame = frameAtPlayStart.current + frameDelta
			if (frame >= a.numFrames) {
				frame = frame % a.numFrames
				playStartRef.current = performance.now()
				frameAtPlayStart.current = 0
			}
			applyFrame(frame)
			rafRef.current = requestAnimationFrame(tick)
		}
		rafRef.current = requestAnimationFrame(tick)
	}, [applyFrame])

	const buildSkeleton = useCallback((anim: AnimData, scene: THREE.Scene) => {
		// Remove old skeleton
		if (skeletonGroupRef.current) {
			scene.remove(skeletonGroupRef.current)
		}

		const group = new THREE.Group()

		// Create spheres for joints
		const spheres: THREE.Mesh[] = []
		const sphereGeoSmall = new THREE.SphereGeometry(0.008, 8, 8)
		const sphereGeoBig = new THREE.SphereGeometry(0.012, 8, 8)
		const matImportant = new THREE.MeshBasicMaterial({ color: 0x00ffff })
		const matNormal = new THREE.MeshBasicMaterial({ color: 0x88ff00 })
		const matRoot = new THREE.MeshBasicMaterial({ color: 0xff0044 })

		for (let i = 0; i < anim.bones.length; i++) {
			const name = anim.bones[i].name
			const isImportant = IMPORTANT_BONES.has(name)
			const isRoot = name === 'Master' || name === 'RootPos'
			const geo = isImportant || isRoot ? sphereGeoBig : sphereGeoSmall
			const mat = isRoot ? matRoot : isImportant ? matImportant : matNormal
			const sphere = new THREE.Mesh(geo, mat)
			sphere.userData.boneName = name
			sphere.userData.boneIdx = i
			spheres.push(sphere)
			group.add(sphere)
		}
		jointSpheresRef.current = spheres

		// Create line segments for bone connections
		const lineGeo = new THREE.BufferGeometry()
		const lineMat = new THREE.LineBasicMaterial({ color: 0x4488ff, linewidth: 1 })
		const boneLine = new THREE.LineSegments(lineGeo, lineMat)
		boneLinesRef.current = boneLine
		group.add(boneLine)

		scene.add(group)
		skeletonGroupRef.current = group
	}, [])

	const startPlaybackRef = useRef(startPlayback)
	startPlaybackRef.current = startPlayback

	const loadAnimation = useCallback(async (id: string, scene?: THREE.Scene) => {
		stopPlayback()
		setInfo(`Loading ${id}...`)
		try {
			const resp = await fetch(`/hkx/${id}.json`)
			const json = await resp.json()
			const anim = loadAnimJson(json)
			animRef.current = anim
			setTotalFrames(anim.numFrames)

			if (scene) buildSkeleton(anim, scene)

			setInfo(`${id} | ${anim.duration.toFixed(1)}s`)
			applyFrame(0)
			setShowRefPose(false)
			setTimeout(() => startPlaybackRef.current(), 50)
		} catch (err) {
			console.error('Anim load failed:', err)
			setInfo(`Error: ${err}`)
		}
	}, [stopPlayback, applyFrame, buildSkeleton])

	const loadAnimationRef = useRef(loadAnimation)
	loadAnimationRef.current = loadAnimation

	const initScene = useCallback(async () => {
		const canvas = canvasRef.current
		if (!canvas) return

		try {
			const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
			renderer.setPixelRatio(window.devicePixelRatio)
			renderer.setSize(window.innerWidth, window.innerHeight)
			renderer.setClearColor(0x111122)

			const scene = new THREE.Scene()

			const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100)
			camera.position.set(0, 0.8, 3)

			const controls = new OrbitControls(camera, canvas)
			controls.target.set(0, 0.8, 0)

			controls.enableDamping = true
			controls.update()

			const ambient = new THREE.AmbientLight(0xffffff, 1.0)
			scene.add(ambient)

			const grid = new THREE.GridHelper(4, 20, 0x334455, 0x222233)
			scene.add(grid)

			const axes = new THREE.AxesHelper(0.5)
			scene.add(axes)

			sceneRef.current = { renderer, scene, camera, controls }

			const onResize = () => {
				camera.aspect = window.innerWidth / window.innerHeight
				camera.updateProjectionMatrix()
				renderer.setSize(window.innerWidth, window.innerHeight)
			}
			window.addEventListener('resize', onResize)

			// Raycaster for bone hover
			const raycaster = new THREE.Raycaster()
			raycaster.params.Points = { threshold: 0.02 }
			const mouse = new THREE.Vector2()

			const onMouseMove = (e: MouseEvent) => {
				mouse.x = (e.clientX / window.innerWidth) * 2 - 1
				mouse.y = -(e.clientY / window.innerHeight) * 2 + 1
				raycaster.setFromCamera(mouse, camera)
				const spheres = jointSpheresRef.current
				if (spheres.length === 0) return
				const hits = raycaster.intersectObjects(spheres)
				if (hits.length > 0) {
					setHoveredBone(hits[0].object.userData.boneName)
				} else {
					setHoveredBone(null)
				}
			}
			canvas.addEventListener('mousemove', onMouseMove)

			// Render loop
			const animate = () => {
				requestAnimationFrame(animate)
				controls.update()
				renderer.render(scene, camera)
			}
			animate()

			await loadAnimationRef.current(ANIM_IDS[0], scene)
			setLoading(false)

			return () => {
				window.removeEventListener('resize', onResize)
				canvas.removeEventListener('mousemove', onMouseMove)
				renderer.dispose()
			}
		} catch (err) {
			console.error('Init failed:', err)
			setError(err instanceof Error ? err.message : String(err))
		}
	}, [])

	useEffect(() => {
		initScene()
		return () => {
			stopPlayback()
			sceneRef.current?.renderer.dispose()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const handleSliderChange = useCallback((value: number[]) => {
		const frame = Math.round(value[0])
		if (isPlaying) {
			playStartRef.current = performance.now()
			frameAtPlayStart.current = frame
		}
		applyFrame(frame)
	}, [applyFrame, isPlaying])

	const handleAnimChange = useCallback((id: string) => {
		setAnimId(id)
		if (sceneRef.current) {
			loadAnimationRef.current(id, sceneRef.current.scene)
		}
	}, [])

	const toggleRefPose = useCallback(() => {
		setShowRefPose(prev => {
			const next = !prev
			if (next) {
				stopPlayback()
				// Show bind/reference pose (frameIdx = -1)
				const anim = animRef.current
				const spheres = jointSpheresRef.current
				const boneLine = boneLinesRef.current
				if (anim && boneLine) {
					const worldPos = computeWorldPositions(anim, -1)
					for (let i = 0; i < anim.bones.length && i < spheres.length; i++) {
						spheres[i].position.copy(worldPos[i])
					}
					const positions: number[] = []
					for (let i = 0; i < anim.bones.length; i++) {
						const pi = anim.bones[i].parentIndex
						if (pi < 0) continue
						positions.push(worldPos[pi].x, worldPos[pi].y, worldPos[pi].z)
						positions.push(worldPos[i].x, worldPos[i].y, worldPos[i].z)
					}
					const geo = boneLine.geometry as THREE.BufferGeometry
					geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
				}
			} else {
				applyFrame(currentFrameRef.current)
			}
			return next
		})
	}, [stopPlayback, applyFrame])

	return (
		<div className="fixed inset-0 w-full h-full overflow-hidden touch-none">
			<header className="absolute top-0 left-0 right-0 px-4 py-2 flex items-center gap-2 z-50 select-none justify-between">
				<div className="flex items-center gap-4">
					<Link href="/hkx">
						<h1
							className="text-2xl font-light tracking-[0.2em] text-white uppercase"
							style={{ textShadow: "0 0 20px rgba(255,255,255,0.3), 0 2px 10px rgba(0,0,0,0.5)" }}
						>
							HKX Skeleton
						</h1>
					</Link>
					{hoveredBone && (
						<span className="text-cyan-300 text-sm font-mono bg-black/50 px-2 py-0.5 rounded">
							{hoveredBone}
						</span>
					)}
				</div>

				<div className="flex items-center gap-2 flex-wrap max-w-[80vw]">
					{ANIM_IDS.map(id => (
						<Button
							key={id}
							size="sm"
							variant={animId === id && !showRefPose ? "default" : "outline"}
							onClick={() => { setShowRefPose(false); handleAnimChange(id) }}
							disabled={loading}
							className={`text-xs px-2 py-1 h-7 ${animId === id && !showRefPose ? "bg-white text-black hover:bg-white/90" : ""}`}
						>
							{id.replace('a000_', '')}
						</Button>
					))}
					<Button
						size="sm"
						variant={showRefPose ? "default" : "outline"}
						onClick={toggleRefPose}
						disabled={loading}
						className={showRefPose ? "bg-cyan-500 text-black hover:bg-cyan-400" : ""}
					>
						Ref Pose
					</Button>
				</div>
			</header>

			{error && (
				<div className="absolute inset-0 flex items-center justify-center text-red-400 p-6 z-50 text-lg">
					{error}
				</div>
			)}

			{loading && !error && (
				<div className="absolute inset-0 flex items-center justify-center text-white z-50 bg-[#111122]">
					<div className="text-center">
						<div className="text-lg mb-2">Loading...</div>
						<div className="text-sm text-white/60">{info}</div>
					</div>
				</div>
			)}

			<canvas ref={canvasRef} className="absolute inset-0 w-full h-full touch-none z-1" />

			{!loading && !error && totalFrames > 0 && (() => {
				const anim = animRef.current
				const dur = anim?.duration ?? 0
				const cur = dur > 0 ? (currentFrame / Math.max(totalFrames - 1, 1)) * dur : 0
				const rem = dur - cur
				const fmt = (t: number) => {
					const m = Math.floor(Math.abs(t) / 60)
					const s = Math.floor(Math.abs(t) % 60)
					return `${t < 0 ? '-' : ''}${m}:${s.toString().padStart(2, '0')}`
				}
				return (
					<div className="absolute bottom-4 left-4 right-4 z-50">
						<div className="max-w-4xl mx-auto px-2 pr-4 bg-black/30 backdrop-blur-xs rounded-full">
							<div className="flex items-center gap-3">
								{!isPlaying ? (
									<Button onClick={startPlayback} size="icon" variant="ghost"><Play /></Button>
								) : (
									<Button onClick={stopPlayback} size="icon" variant="ghost"><Pause /></Button>
								)}

								<div className="text-white text-sm font-mono tabular-nums">{fmt(cur)}</div>

								<div className="flex-1">
									<Slider
										value={[currentFrame]}
										onValueChange={handleSliderChange}
										min={0}
										max={Math.max(totalFrames - 1, 1)}
										step={1}
										className="w-full"
									/>
								</div>

								<div className="text-muted-foreground text-sm font-mono tabular-nums text-right">{fmt(-rem)}</div>
							</div>
						</div>
					</div>
				)
			})()}
		</div>
	)
}
