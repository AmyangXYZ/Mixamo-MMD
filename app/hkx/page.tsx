"use client"

import { Engine, Model, Vec3 } from "reze-engine"
import { useCallback, useEffect, useRef, useState } from "react"
import Loading from "@/components/loading"
import { loadHkxJson, getFrameBoneData, setConversionMode, getConversionMode, ALL_MODES, type HkxAnimation, type ConversionMode } from "@/lib/hkx-loader"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Play, Pause, SkipBack } from "lucide-react"
import Link from "next/link"

const ANIM_FILES = [
  { id: 'a000_000000', label: 'Idle (4.0s)' },
  { id: 'a000_003000', label: 'Attack 1 (4.2s)' },
]

export default function HkxTest() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const modelRef = useRef<Model | null>(null)
  const hkxRef = useRef<HkxAnimation | null>(null)
  const rafRef = useRef<number | null>(null)
  const playStartRef = useRef<number>(0)
  const frameAtPlayStart = useRef<number>(0)

  const [loading, setLoading] = useState(true)
  const [loadingAnim, setLoadingAnim] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [animId, setAnimId] = useState(ANIM_FILES[0].id)
  const [animInfo, setAnimInfo] = useState('')
  const [convMode, setConvMode] = useState<ConversionMode>(getConversionMode())

  const applyFrame = useCallback((frameIdx: number) => {
    const model = modelRef.current
    const hkx = hkxRef.current
    if (!model || !hkx || frameIdx < 0 || frameIdx >= hkx.numFrames) return

    const { rotations, positions } = getFrameBoneData(hkx, frameIdx)
    model.rotateBones(rotations)
    if (Object.keys(positions).length > 0) {
      model.moveBones(positions)
    }
    setCurrentFrame(frameIdx)
  }, [])

  const stopPlayback = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setIsPlaying(false)
  }, [])

  const startPlayback = useCallback(() => {
    const hkx = hkxRef.current
    if (!hkx) return
    setIsPlaying(true)
    playStartRef.current = performance.now()
    frameAtPlayStart.current = currentFrame

    const tick = () => {
      const hkx = hkxRef.current
      if (!hkx) return
      const elapsed = (performance.now() - playStartRef.current) / 1000
      const frameDelta = Math.floor(elapsed * hkx.fps)
      let frame = frameAtPlayStart.current + frameDelta
      if (frame >= hkx.numFrames) {
        frame = frame % hkx.numFrames
        playStartRef.current = performance.now()
        frameAtPlayStart.current = 0
      }
      applyFrame(frame)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [currentFrame, applyFrame])

  const loadAnimation = useCallback(async (id: string) => {
    stopPlayback()
    modelRef.current?.resetAllBones()
    setLoadingAnim(true)
    setAnimInfo(`Loading ${id}...`)

    try {
      const resp = await fetch(`/hkx/${id}.json`)
      const json = await resp.json()
      const hkx = loadHkxJson(json)
      hkxRef.current = hkx
      setTotalFrames(hkx.numFrames)
      setCurrentFrame(0)
      setAnimInfo(`${id} | ${hkx.duration.toFixed(1)}s | ${hkx.numFrames}f @ ${hkx.fps}fps | ${hkx.bones.length} bones`)
      applyFrame(0)
    } catch (err) {
      console.error('Failed to load animation:', err)
      setAnimInfo(`Error loading ${id}`)
    } finally {
      setLoadingAnim(false)
    }
  }, [stopPlayback, applyFrame])

  const initEngine = useCallback(async () => {
    if (!canvasRef.current) return
    try {
      const engine = new Engine(canvasRef.current, {
        ambientColor: new Vec3(0.9, 0.9, 0.9),
        cameraDistance: 35,
        cameraTarget: new Vec3(0, 9, 0),
      })
      engineRef.current = engine
      await engine.init()
      const model = await engine.loadModel("/models/reze/reze.pmx")
      modelRef.current = model
      engine.addGround({ width: 200, height: 200, fadeEnd: 100, fadeStart: 50, diffuseColor: new Vec3(0.0, 0.0, 0.05) })
      engine.setIKEnabled(false)
      engine.setPhysicsEnabled(false)
      engine.runRenderLoop()
      model.setMorphWeight("抗穿模", 0.5)
      setLoading(false)
      await loadAnimation(ANIM_FILES[0].id)
    } catch (error) {
      setEngineError(error instanceof Error ? error.message : "Unknown error")
    }
  }, [loadAnimation])

  useEffect(() => {
    initEngine()
    return () => {
      stopPlayback()
      engineRef.current?.dispose()
    }
  }, [initEngine, stopPlayback])

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
    loadAnimation(id)
  }, [loadAnimation])

  const handleReset = useCallback(() => {
    stopPlayback()
    modelRef.current?.resetAllBones()
    setCurrentFrame(0)
    applyFrame(0)
  }, [stopPlayback, applyFrame])

  const handleConvModeChange = useCallback((mode: ConversionMode) => {
    setConvMode(mode)
    setConversionMode(mode)
    applyFrame(currentFrame)
  }, [applyFrame, currentFrame])

  return (
    <div className="fixed inset-0 w-full h-full overflow-hidden touch-none">
      <header className="absolute top-0 left-0 right-0 px-4 md:px-6 py-2 flex items-center gap-2 z-50 w-full select-none justify-between">
        <div className="flex items-center gap-2">
          <Link href="/">
            <h1
              className="text-2xl font-light tracking-[0.2em] md:tracking-[0.3em] text-white uppercase"
              style={{
                textShadow: "0 0 20px rgba(255, 255, 255, 0.3), 0 2px 10px rgba(0, 0, 0, 0.5)",
                fontFamily: "var(--font-geist-sans)",
              }}
            >
              HKX Test
            </h1>
          </Link>
        </div>

        <div className="flex items-center gap-2">
          {ANIM_FILES.map(a => (
            <Button
              key={a.id}
              size="sm"
              variant={animId === a.id ? "default" : "outline"}
              onClick={() => handleAnimChange(a.id)}
              disabled={loading || loadingAnim}
              className={animId === a.id ? "bg-white text-black hover:bg-white/90" : ""}
            >
              {a.label}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <span className="text-white/60 text-xs mr-1">Conv:</span>
          {(['identity', 'negate_zw', 'swap_yz_neg_w', 'swap_yz', 'negate_yw'] as ConversionMode[]).map(m => (
            <Button
              key={m}
              size="sm"
              variant={convMode === m ? "default" : "outline"}
              onClick={() => handleConvModeChange(m)}
              className={`text-xs px-2 ${convMode === m ? "bg-white text-black hover:bg-white/90" : ""}`}
            >
              {m}
            </Button>
          ))}
        </div>
      </header>

      {engineError && (
        <div className="absolute inset-0 flex items-center justify-center text-white p-6 z-50 text-lg font-medium">
          Engine Error: {engineError}
        </div>
      )}
      {loading && !engineError && <Loading loading={loading} />}

      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full touch-none z-1 bg-black" />

      {!loading && !engineError && totalFrames > 0 && (
        <div className="absolute bottom-4 left-4 right-4 z-50">
          <div className="max-w-4xl mx-auto px-2 pr-4 bg-black/30 backdrop-blur-xs rounded-full">
            <div className="flex items-center gap-3">
              <Button onClick={handleReset} size="icon" variant="ghost" aria-label="Reset">
                <SkipBack className="w-4 h-4" />
              </Button>

              {!isPlaying ? (
                <Button onClick={startPlayback} size="icon" variant="ghost" aria-label="Play">
                  <Play />
                </Button>
              ) : (
                <Button onClick={stopPlayback} size="icon" variant="ghost" aria-label="Pause">
                  <Pause />
                </Button>
              )}

              <div className="text-white text-sm font-mono tabular-nums w-16 text-center">
                {currentFrame} / {totalFrames - 1}
              </div>

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

              <div className="text-muted-foreground text-xs font-mono max-w-[300px] truncate">
                {animInfo}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
