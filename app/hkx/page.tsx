"use client"

import { Engine, Model, Vec3 } from "reze-engine"
import { useCallback, useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import Loading from "@/components/loading"
import { loadHkxJson, type HkxAnimation } from "@/lib/hkx-loader"
import {
  computeHkxMmdFrame,
  computeHkxMmdFrameWithCtx,
  createRetargetContext,
  retargetHkxClip,
  type HkxRetargetContext,
} from "@/lib/hkx-retarget"
import { computeWorldPositions, HKX_IMPORTANT_BONES, loadAnimJson, type AnimData } from "@/lib/hkx-three-view"
import { convertToVMD, downloadBlob } from "@/lib/vmd-writer"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Play, Pause, Download } from "lucide-react"
import Link from "next/link"

const ANIM_IDS = [
  //   "a000_000000",
  "a000_001020",
  "a000_002000",
  "a000_002001",
  "a000_002002",
  "a000_002003",
  "a000_002100",
  "a000_003000",
  "a000_003001",
  "a000_003003",
  "a000_003004",
  "a000_003005",
  "a000_003006",
  "a000_003007",
  "a000_003008",
  "a000_003009",
  "a000_003010",
  "a000_003011",
  "a000_003012",
  "a000_003013",
  "a000_003014",
  "a000_003015",
  "a000_003016",
  "a000_003018",
  "a000_003019",
  "a000_003020",
  "a000_003021",
  "a000_003022",
  "a000_003023",
  "a000_003024",
  "a000_006000",
  "a000_006001",
  "a000_006002",
  "a000_006003",
  "a000_006010",
  "a000_006011",
  "a000_006012",
  "a000_006013",
]

type ThreeSceneBundle = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
}

export default function HkxComparePage() {
  const threeContainerRef = useRef<HTMLDivElement>(null)
  const threeCanvasRef = useRef<HTMLCanvasElement>(null)
  const mmdCanvasRef = useRef<HTMLCanvasElement>(null)

  const sceneRef = useRef<ThreeSceneBundle | null>(null)
  const threeRenderRafRef = useRef<number | null>(null)
  const skeletonGroupRef = useRef<THREE.Group | null>(null)
  const jointSpheresRef = useRef<THREE.Mesh[]>([])
  const boneLinesRef = useRef<THREE.Line | null>(null)
  const animDataRef = useRef<AnimData | null>(null)

  const engineRef = useRef<Engine | null>(null)
  const modelRef = useRef<Model | null>(null)
  const hkxRef = useRef<HkxAnimation | null>(null)
  const retargetCtxRef = useRef<HkxRetargetContext | null>(null)

  const playRafRef = useRef<number | null>(null)
  const playStartRef = useRef(0)
  const frameAtPlayStart = useRef(0)
  const currentFrameRef = useRef(0)

  const [loading, setLoading] = useState(true)
  const [loadingAnim, setLoadingAnim] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [threeError, setThreeError] = useState<string | null>(null)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [animId, setAnimId] = useState(ANIM_IDS[0])
  const [animInfo, setAnimInfo] = useState("")
  const [clipReady, setClipReady] = useState(false)
  const [hoveredBone, setHoveredBone] = useState<string | null>(null)
  const [showRefPose, setShowRefPose] = useState(false)
  const showRefPoseRef = useRef(false)
  const [clipDuration, setClipDuration] = useState(0)

  const applyThreeSkeleton = useCallback((anim: AnimData, frameIdx: number) => {
    const spheres = jointSpheresRef.current
    const boneLine = boneLinesRef.current
    if (!boneLine) return
    const worldPos = computeWorldPositions(anim, frameIdx)
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
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
    geo.attributes.position.needsUpdate = true
  }, [])

  const applyFrame = useCallback(
    (frameIdx: number) => {
      const model = modelRef.current
      const hkx = hkxRef.current
      const anim = animDataRef.current
      if (!hkx || !anim || frameIdx < 0 || frameIdx >= hkx.numFrames) return

      currentFrameRef.current = frameIdx
      setCurrentFrame(frameIdx)

      const threeFrame = showRefPoseRef.current ? -1 : frameIdx
      applyThreeSkeleton(anim, threeFrame)

      if (!model) return

      const ctx = retargetCtxRef.current
      const { rotations, positions } = ctx
        ? computeHkxMmdFrameWithCtx(ctx, frameIdx)
        : computeHkxMmdFrame(hkx, frameIdx)
      model.rotateBones(rotations)
      if (Object.keys(positions).length > 0) {
        model.moveBones(positions)
      }
    },
    [applyThreeSkeleton],
  )

  const stopPlayback = useCallback(() => {
    if (playRafRef.current !== null) {
      cancelAnimationFrame(playRafRef.current)
      playRafRef.current = null
    }
    setIsPlaying(false)
  }, [])

  const startPlayback = useCallback(() => {
    const hkx = hkxRef.current
    if (!hkx) return
    setIsPlaying(true)
    showRefPoseRef.current = false
    setShowRefPose(false)
    playStartRef.current = performance.now()
    frameAtPlayStart.current = currentFrameRef.current

    const tick = () => {
      const h = hkxRef.current
      if (!h) return
      const elapsed = (performance.now() - playStartRef.current) / 1000
      const frameDelta = Math.floor(elapsed * h.fps)
      let frame = frameAtPlayStart.current + frameDelta
      if (frame >= h.numFrames) {
        frame = frame % h.numFrames
        playStartRef.current = performance.now()
        frameAtPlayStart.current = 0
      }
      applyFrame(frame)
      playRafRef.current = requestAnimationFrame(tick)
    }
    playRafRef.current = requestAnimationFrame(tick)
  }, [applyFrame])

  const buildSkeleton = useCallback((anim: AnimData, scene: THREE.Scene) => {
    if (skeletonGroupRef.current) scene.remove(skeletonGroupRef.current)

    const group = new THREE.Group()
    const spheres: THREE.Mesh[] = []
    const sphereGeoSmall = new THREE.SphereGeometry(0.008, 8, 8)
    const sphereGeoBig = new THREE.SphereGeometry(0.012, 8, 8)
    const matImportant = new THREE.MeshBasicMaterial({ color: 0x00ffff })
    const matNormal = new THREE.MeshBasicMaterial({ color: 0x88ff00 })
    const matRoot = new THREE.MeshBasicMaterial({ color: 0xff0044 })

    for (let i = 0; i < anim.bones.length; i++) {
      const name = anim.bones[i].name
      const isImportant = HKX_IMPORTANT_BONES.has(name)
      const isRoot = name === "Master" || name === "RootPos"
      const geo = isImportant || isRoot ? sphereGeoBig : sphereGeoSmall
      const mat = isRoot ? matRoot : isImportant ? matImportant : matNormal
      const sphere = new THREE.Mesh(geo, mat)
      sphere.userData.boneName = name
      sphere.userData.boneIdx = i
      spheres.push(sphere)
      group.add(sphere)
    }
    jointSpheresRef.current = spheres

    const lineGeo = new THREE.BufferGeometry()
    const lineMat = new THREE.LineBasicMaterial({ color: 0x4488ff, linewidth: 1 })
    const boneLine = new THREE.LineSegments(lineGeo, lineMat)
    boneLinesRef.current = boneLine
    group.add(boneLine)

    scene.add(group)
    skeletonGroupRef.current = group
  }, [])

  const loadAnimation = useCallback(
    async (id: string) => {
      stopPlayback()
      modelRef.current?.resetAllBones()
      setLoadingAnim(true)
      setAnimInfo(`Loading ${id}...`)
      showRefPoseRef.current = false
      setShowRefPose(false)

      try {
        const resp = await fetch(`/hkx/${id}.json`)
        const json = await resp.json()
        const hkx = loadHkxJson(json)
        const anim = loadAnimJson(json)

        hkxRef.current = hkx
        animDataRef.current = anim
        retargetCtxRef.current = createRetargetContext(hkx)

        const scene = sceneRef.current?.scene
        if (scene) buildSkeleton(anim, scene)

        const clip = retargetHkxClip(hkx)
        setClipReady(clip.boneTracks.length > 0 || (clip.positionTracks?.length ?? 0) > 0)
        setClipDuration(hkx.duration)
        setTotalFrames(hkx.numFrames)
        setCurrentFrame(0)
        setAnimInfo(
          `${id} · ${hkx.duration.toFixed(1)}s · ${hkx.numFrames}f@${hkx.fps} · ${clip.boneTracks.length} rot · ${clip.positionTracks?.length ?? 0} pos`,
        )
        applyFrame(0)
      } catch (err) {
        console.error(err)
        retargetCtxRef.current = null
        setClipReady(false)
        setAnimInfo(`Error loading ${id}`)
      } finally {
        setLoadingAnim(false)
      }
    },
    [stopPlayback, buildSkeleton, applyFrame],
  )

  const handleExportVmd = useCallback(() => {
    const hkx = hkxRef.current
    if (!hkx) return
    const clip = retargetHkxClip(hkx)
    const hasData = clip.boneTracks.length > 0 || (clip.positionTracks?.length ?? 0) > 0
    if (!hasData) return
    downloadBlob(convertToVMD(clip, 30), `${animId}_er_mmd.vmd`)
  }, [animId])

  const initThree = useCallback(() => {
    const container = threeContainerRef.current
    const canvas = threeCanvasRef.current
    if (!container || !canvas) return () => {}

    try {
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setClearColor(0x111122)

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100)
      camera.position.set(0, 0.8, 3)

      const controls = new OrbitControls(camera, canvas)
      controls.target.set(0, 0.8, 0)
      controls.enableDamping = true

      scene.add(new THREE.AmbientLight(0xffffff, 1.0))
      scene.add(new THREE.GridHelper(4, 20, 0x334455, 0x222233))
      scene.add(new THREE.AxesHelper(0.5))

      const raycaster = new THREE.Raycaster()
      const mouse = new THREE.Vector2()

      const onMouseMove = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect()
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(mouse, camera)
        const spheres = jointSpheresRef.current
        if (spheres.length === 0) return
        const hits = raycaster.intersectObjects(spheres)
        setHoveredBone(hits.length > 0 ? hits[0].object.userData.boneName : null)
      }

      const resize = () => {
        const w = container.clientWidth
        const h = container.clientHeight
        if (w < 1 || h < 1) return
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        renderer.setSize(w, h, false)
      }

      const ro = new ResizeObserver(() => resize())
      ro.observe(container)
      resize()

      canvas.addEventListener("mousemove", onMouseMove)

      const loop = () => {
        threeRenderRafRef.current = requestAnimationFrame(loop)
        controls.update()
        renderer.render(scene, camera)
      }
      threeRenderRafRef.current = requestAnimationFrame(loop)

      sceneRef.current = { renderer, scene, camera, controls }

      return () => {
        ro.disconnect()
        canvas.removeEventListener("mousemove", onMouseMove)
        if (threeRenderRafRef.current !== null) cancelAnimationFrame(threeRenderRafRef.current)
        threeRenderRafRef.current = null
        renderer.dispose()
        sceneRef.current = null
      }
    } catch (e) {
      setThreeError(e instanceof Error ? e.message : String(e))
      return () => {}
    }
  }, [])

  const initEngine = useCallback(async () => {
    const canvas = mmdCanvasRef.current
    if (!canvas) return
    try {
      const engine = new Engine(canvas, {
        ambientColor: new Vec3(0.9, 0.9, 0.9),
        cameraDistance: 35,
        cameraTarget: new Vec3(0, 9, 0),
      })
      engineRef.current = engine
      await engine.init()
      const model = await engine.loadModel("/models/reze/reze.pmx")
      modelRef.current = model
      // engine.addGround({
      // 	width: 200,
      // 	height: 200,
      // 	fadeEnd: 100,
      // 	fadeStart: 50,
      // 	diffuseColor: new Vec3(0.0, 0.0, 0.05),
      // })
      engine.setIKEnabled(false)
      engine.setPhysicsEnabled(false)
      engine.runRenderLoop()
      model.setMorphWeight("抗穿模", 0.5)
    } catch (error) {
      setEngineError(error instanceof Error ? error.message : "Unknown error")
    }
  }, [])

  useEffect(() => {
    let threeCleanup: (() => void) | undefined
    ;(async () => {
      threeCleanup = initThree()
      await initEngine()
      await loadAnimation(ANIM_IDS[0])
      setLoading(false)
    })()
    return () => {
      stopPlayback()
      threeCleanup?.()
      engineRef.current?.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
  }, [])

  const handleSliderChange = useCallback(
    (value: number[]) => {
      const frame = Math.round(value[0])
      showRefPoseRef.current = false
      setShowRefPose(false)
      if (isPlaying) {
        playStartRef.current = performance.now()
        frameAtPlayStart.current = frame
      }
      applyFrame(frame)
    },
    [applyFrame, isPlaying],
  )

  const handleAnimChange = useCallback(
    (id: string) => {
      setAnimId(id)
      loadAnimation(id)
    },
    [loadAnimation],
  )

  const toggleRefPose = useCallback(() => {
    setShowRefPose((prev) => {
      const next = !prev
      showRefPoseRef.current = next
      if (next) stopPlayback()
      queueMicrotask(() => {
        const anim = animDataRef.current
        if (!anim) return
        applyThreeSkeleton(anim, next ? -1 : currentFrameRef.current)
      })
      return next
    })
  }, [stopPlayback, applyThreeSkeleton])

  useEffect(() => {
    showRefPoseRef.current = showRefPose
  }, [showRefPose])

  const panelError = engineError || threeError

  const fmtTime = (t: number) => {
    const m = Math.floor(Math.abs(t) / 60)
    const s = Math.floor(Math.abs(t) % 60)
    return `${t < 0 ? "-" : ""}${m}:${s.toString().padStart(2, "0")}`
  }
  const curTime = clipDuration > 0 ? (currentFrame / Math.max(totalFrames - 1, 1)) * clipDuration : 0
  const remTime = clipDuration - curTime

  return (
    <div className="fixed inset-0 flex w-full h-full flex-col overflow-hidden touch-none bg-black">
      <header className="z-40 flex shrink-0 select-none items-center justify-between gap-2 border-b border-white/10 bg-black/90 px-4 py-2">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/">
            <h1
              className="text-2xl font-light tracking-[0.2em] text-white uppercase cursor-pointer"
              style={{ textShadow: "0 0 20px rgba(255,255,255,0.3), 0 2px 10px rgba(0,0,0,0.5)" }}
            >
              HKX · FK / MMD
            </h1>
          </Link>
          {hoveredBone && (
            <span className="text-cyan-300 text-sm font-mono bg-black/50 px-2 py-0.5 rounded truncate max-w-[min(30vw,200px)]">
              {hoveredBone}
            </span>
          )}
          <span className="text-white/45 text-xs font-mono truncate max-w-[min(28vw,240px)] hidden lg:inline">
            {animInfo}
          </span>
        </div>

        <div className="flex max-h-[40vh] max-w-[min(100%,56rem)] flex-wrap items-center justify-end gap-2 overflow-y-auto">
          {ANIM_IDS.map((id) => (
            <Button
              key={id}
              size="sm"
              variant={animId === id && !showRefPose ? "default" : "outline"}
              onClick={() => {
                showRefPoseRef.current = false
                setShowRefPose(false)
                handleAnimChange(id)
              }}
              disabled={loading || loadingAnim}
              className={`text-xs px-2 py-1 h-7 ${animId === id && !showRefPose ? "bg-white text-black hover:bg-white/90" : ""}`}
            >
              {id.replace("a000_", "")}
            </Button>
          ))}
          <Button
            size="sm"
            variant={showRefPose ? "default" : "outline"}
            onClick={toggleRefPose}
            disabled={loading || loadingAnim}
            className={showRefPose ? "bg-cyan-500 text-black hover:bg-cyan-400 h-7" : "h-7"}
          >
            Ref Pose
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportVmd}
            disabled={loading || loadingAnim || !clipReady}
            className="gap-1 h-7"
            title="ER→MMD retarget (30fps VMD)"
          >
            <Download className="w-4 h-4" />
            VMD
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div className="flex h-full min-h-0 w-full">
          <div ref={threeContainerRef} className="relative min-h-0 w-1/2 min-w-0 border-r border-white/10">
            <span className="pointer-events-none absolute left-2 top-2 z-10 text-[10px] uppercase tracking-wider text-white/50">
              Three.js · ER FK
            </span>
            <canvas ref={threeCanvasRef} className="block h-full w-full touch-none" />
          </div>
          <div className="relative min-h-0 w-1/2 min-w-0">
            <span className="pointer-events-none absolute left-2 top-2 z-10 text-[10px] uppercase tracking-wider text-white/50">
              reze · MMD (world Δ → MMD local)
            </span>
            <canvas ref={mmdCanvasRef} className="block h-full w-full touch-none" />
          </div>
        </div>

        {panelError && (
          <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/85 p-6 text-sm text-red-300">
            {panelError}
          </div>
        )}

        {loading && !panelError && <Loading loading={loading} />}

        {!loading && !panelError && totalFrames > 0 && (
          <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-50 flex justify-center">
            <div className="pointer-events-auto mx-auto w-full max-w-4xl px-2 pr-4">
              <div className="rounded-full bg-black/30 px-2 py-1 pr-4 backdrop-blur-xs">
                <div className="flex items-center gap-3">
                  {!isPlaying ? (
                    <Button onClick={startPlayback} size="icon" variant="ghost" aria-label="Play">
                      <Play />
                    </Button>
                  ) : (
                    <Button onClick={stopPlayback} size="icon" variant="ghost" aria-label="Pause">
                      <Pause />
                    </Button>
                  )}

                  <div className="font-mono text-sm tabular-nums text-white">{fmtTime(curTime)}</div>

                  <div className="min-w-0 flex-1">
                    <Slider
                      value={[currentFrame]}
                      onValueChange={handleSliderChange}
                      min={0}
                      max={Math.max(totalFrames - 1, 1)}
                      step={1}
                      className="w-full"
                    />
                  </div>

                  <div className="text-right font-mono text-sm tabular-nums text-muted-foreground">
                    {fmtTime(-remTime)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
