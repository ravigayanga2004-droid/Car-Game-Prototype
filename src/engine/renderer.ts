import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { Quality } from './save'

type Preset = { pixelRatio: number; shadows: boolean; shadowMap: number; bloom: boolean; antialias: boolean; splitPixelRatio: number }
export const QUALITY_PRESETS: Record<Quality, Preset> = {
  low: { pixelRatio: 1, shadows: false, shadowMap: 512, bloom: false, antialias: false, splitPixelRatio: 0.85 },
  medium: { pixelRatio: 1.5, shadows: true, shadowMap: 1024, bloom: false, antialias: true, splitPixelRatio: 1 },
  high: { pixelRatio: 2, shadows: true, shadowMap: 2048, bloom: true, antialias: true, splitPixelRatio: 1.25 },
}

/** Pick a starting quality from device hints; the player can override it in Settings. */
export function suggestQuality(): Quality {
  const coarse = matchMedia('(pointer: coarse)').matches
  const cores = navigator.hardwareConcurrency ?? 4
  if (coarse || cores <= 4) return 'medium'
  return 'high'
}

/** A camera drawn into a rectangle of the canvas (fractions, origin bottom-left). */
export interface View {
  camera: THREE.PerspectiveCamera
  x: number
  y: number
  w: number
  h: number
  /** Called right before this view renders (per-player highlights, shadow focus). */
  before?: () => void
}

/**
 * Owns the WebGL renderer, the optional bloom chain (single view only) and resize handling.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer
  private composer?: EffectComposer
  private bloom?: UnrealBloomPass
  private preset: Preset
  private scene?: THREE.Scene
  private camera?: THREE.PerspectiveCamera
  private split = false

  constructor(readonly canvas: HTMLCanvasElement, quality: Quality) {
    this.preset = QUALITY_PRESETS[quality]
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: this.preset.antialias, powerPreference: 'high-performance' })
    this.gl.outputColorSpace = THREE.SRGBColorSpace
    this.gl.toneMapping = THREE.ACESFilmicToneMapping
    this.gl.toneMappingExposure = 1.0
    this.gl.shadowMap.type = THREE.PCFShadowMap
    this.applyQuality(quality)
    window.addEventListener('resize', () => this.resize())
  }

  get shadowsEnabled(): boolean {
    return this.preset.shadows
  }

  get shadowMapSize(): number {
    return this.preset.shadowMap
  }

  applyQuality(quality: Quality): void {
    this.preset = QUALITY_PRESETS[quality]
    this.gl.shadowMap.enabled = this.preset.shadows
    this.bloom?.dispose()
    this.composer?.dispose()
    this.composer = undefined
    this.bloom = undefined
    this.updatePixelRatio()
    this.resize()
  }

  private updatePixelRatio(): void {
    const pr = this.split ? this.preset.splitPixelRatio : this.preset.pixelRatio
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, pr))
  }

  private ensureComposer(scene: THREE.Scene, camera: THREE.PerspectiveCamera): EffectComposer | undefined {
    if (!this.preset.bloom) return undefined
    if (this.composer && this.scene === scene && this.camera === camera) return this.composer
    this.composer?.dispose()
    this.bloom?.dispose()
    this.scene = scene
    this.camera = camera
    const size = this.gl.getSize(new THREE.Vector2())
    this.composer = new EffectComposer(this.gl)
    this.composer.addPass(new RenderPass(scene, camera))
    this.bloom = new UnrealBloomPass(size, 0.42, 0.4, 2.0)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.composer.setSize(size.x, size.y)
    return this.composer
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.gl.setSize(w, h, false)
    this.composer?.setSize(w, h)
  }

  render(scene: THREE.Scene, views: View[]): void {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    const split = views.length > 1
    if (split !== this.split) {
      this.split = split
      this.updatePixelRatio()
      this.resize()
    }
    if (!split) {
      const v = views[0]
      const aspect = w / h
      if (Math.abs(v.camera.aspect - aspect) > 1e-3) {
        v.camera.aspect = aspect
        v.camera.updateProjectionMatrix()
      }
      v.before?.()
      this.gl.setScissorTest(false)
      this.gl.setViewport(0, 0, w, h)
      const composer = this.ensureComposer(scene, v.camera)
      if (composer) composer.render()
      else this.gl.render(scene, v.camera)
      return
    }
    this.gl.setScissorTest(true)
    for (const v of views) {
      const px = Math.round(v.x * w)
      const py = Math.round(v.y * h)
      const pw = Math.round(v.w * w)
      const ph = Math.round(v.h * h)
      const aspect = pw / Math.max(1, ph)
      if (Math.abs(v.camera.aspect - aspect) > 1e-3) {
        v.camera.aspect = aspect
        v.camera.updateProjectionMatrix()
      }
      v.before?.()
      this.gl.setViewport(px, py, pw, ph)
      this.gl.setScissor(px, py, pw, ph)
      this.gl.render(scene, v.camera)
    }
    this.gl.setScissorTest(false)
  }
}
