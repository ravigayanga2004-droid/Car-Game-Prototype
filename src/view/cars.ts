import * as THREE from 'three'
import { assets, CAR_KEYS } from '../engine/assets'
import { TRICK_TIME, WRECK_TIME, type CarState } from '../sim/car'
import { tagTexture } from './textures'

/**
 * Cosmetic-only vehicles. Every chassis shares the simulation's single car model; these meshes
 * only change silhouette and paint. Detailed catalogue GLBs (metres, +Z forward) are cloned per
 * car and re-painted with the selected livery. Until the GLB streams in, a neutral proxy body is
 * shown so nothing ever blocks on a download.
 */
/**
 * `dims` = real-world [width incl. mirrors, height, length] in metres. Generated models of real cars are
 * scaled per axis to these, because single-view image-to-3D tends to exaggerate height and depth.
 */
export interface ChassisInfo { name: string; blurb: string; dims?: [number, number, number] }
/**
 * `finish: 'solid'` renders a non-metallic gloss (e.g. factory solid paints) instead of the default
 * metallic flake; `stripe: false` drops the twin spine stripe for clean single-colour schemes.
 */
export interface LiveryInfo { name: string; primary: string; secondary: string; accent: string; finish?: 'metallic' | 'solid'; stripe?: boolean }

export const CHASSIS: ChassisInfo[] = [
  { name: 'Sandvane GT', blurb: 'Long-tail coupe with a towering rear wing.' },
  { name: 'Talusfin', blurb: 'Closed-cockpit prototype with a shark-fin spine.' },
  { name: 'Gullyjack', blurb: 'Compact cup coupe with a short, punchy stance.' },
  { name: 'Basaltback GT', blurb: 'Mid-engine GT with wide rear haunches.' },
  { name: 'Nightmesa', blurb: 'Classic long-tail endurance prototype.' },
  { name: 'Stingbolt', blurb: 'Five-door hot hatch with a honeycomb grille and a roof wing.', dims: [2.02, 1.412, 4.445] },
  // Modern open-wheel single-seater proportions: 2.0 m wide, ~0.97 m to the roll hoop, ~5.6 m long.
  { name: 'Scorchquill', blurb: 'Open-wheel single-seater with a cockpit halo, sculpted sidepods and a two-plane rear wing.', dims: [2.0, 0.97, 5.6] },
]

export const LIVERIES: LiveryInfo[] = [
  { name: 'Sunset Crimson', primary: '#b3121f', secondary: '#f1ede4', accent: '#1a1a1d' },
  { name: 'Canyon Orange', primary: '#e0561b', secondary: '#1d1d20', accent: '#f2c14e' },
  { name: 'Turquoise Mesa', primary: '#128a8c', secondary: '#f3efe6', accent: '#e0561b' },
  { name: 'Desert Gold', primary: '#c79a3a', secondary: '#231f1c', accent: '#b3121f' },
  { name: 'Midnight', primary: '#1d2233', secondary: '#d9dde6', accent: '#e8a33c' },
  { name: 'Pearl', primary: '#e9e6df', secondary: '#1a3f73', accent: '#c8102e' },
  // Stingbolt house scheme: solid (non-metallic) yellow gloss with black trim, no stripes.
  { name: 'Stingbolt Yellow', primary: '#d0b200', secondary: '#141414', accent: '#141414', finish: 'solid', stripe: false },
  // Scorchquill house scheme: solid deep violet with bone-white spine stripes and ember accents (no real team colours).
  { name: 'Quill Violet', primary: '#4b2a8c', secondary: '#efe8dc', accent: '#ff7a1a', finish: 'solid', stripe: true },
]

const WHEEL_NAMES = ['wheel-front-left', 'wheel-front-right', 'wheel-rear-left', 'wheel-rear-right']

/** Shared additive sprite textures cut from the particle atlas (glow cell, flame cell). */
let glowTex: THREE.Texture | null = null
let flameTex: THREE.Texture | null = null
let blobTex: THREE.Texture | null = null
function atlasCell(col: number, row: number): THREE.Texture | null {
  const base = assets.tex('fx')
  if (!base) return null
  const t = base.clone()
  t.repeat.set(0.25, 0.5)
  t.offset.set(col * 0.25, row === 0 ? 0.5 : 0)
  t.needsUpdate = true
  return t
}
function blobShadow(): THREE.Texture {
  if (blobTex) return blobTex
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62)
  grad.addColorStop(0, 'rgba(0,0,0,0.62)')
  grad.addColorStop(0.55, 'rgba(0,0,0,0.35)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  blobTex = new THREE.CanvasTexture(c)
  return blobTex
}

const shieldMat = () => new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#6ff3ff') }, uFlash: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime; uniform vec3 uColor; uniform float uFlash;
    varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      float rim = pow(1.0 - abs(dot(vN, vV)), 2.4);
      float bands = smoothstep(0.82, 1.0, sin(vP.y * 9.0 - uTime * 6.0) * 0.5 + 0.5) * 0.35;
      float hex = smoothstep(0.9, 1.0, abs(sin(vP.x * 7.0 + uTime) * sin(vP.z * 7.0 - uTime))) * 0.25;
      float a = clamp(rim * 0.9 + bands * rim + hex * rim + uFlash * 0.5, 0.0, 1.0);
      gl_FragColor = vec4(uColor * (0.6 + uFlash), a * 0.85);
    }`,
})

interface Rig { body: THREE.Object3D; wheels: THREE.Object3D[]; front: THREE.Object3D[]; size: THREE.Vector3; min: THREE.Vector3; max: THREE.Vector3; wheelR: number }

function paintMaterials(src: THREE.Object3D, livery: LiveryInfo, ghost: boolean, owned: THREE.Material[]): void {
  const cache = new Map<THREE.Material, THREE.Material>()
  const make = (m: THREE.MeshStandardMaterial): THREE.Material => {
    let out: THREE.MeshStandardMaterial
    switch (m.name) {
      case 'paint':
        out = new THREE.MeshPhysicalMaterial({ color: livery.primary, metalness: 0.45, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.95 })
        break
      case 'accent':
        out = new THREE.MeshPhysicalMaterial({ color: livery.secondary, metalness: 0.3, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.12, envMapIntensity: 0.85 })
        break
      case 'glass':
        out = new THREE.MeshPhysicalMaterial({ color: '#141c24', metalness: 0.1, roughness: 0.04, clearcoat: 1, envMapIntensity: 1.1, transparent: true, opacity: 0.86 })
        break
      case 'white':
        out = new THREE.MeshStandardMaterial({ color: '#efebe2', roughness: 0.4, metalness: 0, emissive: '#fff3d6', emissiveIntensity: 0.18, envMapIntensity: 0.6 })
        break
      case 'alloy':
        out = new THREE.MeshStandardMaterial({ color: '#c3c6ca', metalness: 0.85, roughness: 0.28, envMapIntensity: 0.9 })
        break
      case 'steel':
        out = new THREE.MeshStandardMaterial({ color: '#6c7075', metalness: 0.7, roughness: 0.45, envMapIntensity: 0.6 })
        break
      case 'rubber':
        out = new THREE.MeshStandardMaterial({ color: '#141414', metalness: 0, roughness: 0.94, envMapIntensity: 0.2 })
        break
      default: // trim
        out = new THREE.MeshStandardMaterial({ color: m.color?.getStyle?.() ?? '#111', metalness: 0.1, roughness: 0.7, envMapIntensity: 0.4 })
    }
    out.name = m.name
    if (ghost) {
      out.transparent = true
      out.opacity = 0.38
      out.depthWrite = false
    }
    owned.push(out)
    return out
  }
  src.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mat = mesh.material as THREE.MeshStandardMaterial
    let m2 = cache.get(mat)
    if (!m2) { m2 = make(mat); cache.set(mat, m2) }
    mesh.material = m2
    mesh.castShadow = !ghost
    mesh.receiveShadow = !ghost
  })
}

/** Target body length (metres) for generated models, which arrive normalised to a unit box. */
const CAR_LENGTH = 4.6

/**
 * Livery repaint for the photoreal generated cars. Their bodies are baked white/silver, so the
 * shader keeps the texture's shading detail (lum) but swaps the hue on bright, unsaturated texels.
 * A twin racing stripe in the secondary colour runs along the spine (object-space, so it follows
 * the body regardless of UV layout).
 */
function livePaint(src: THREE.MeshStandardMaterial, livery: LiveryInfo, ghost: boolean, scorch: { value: number }): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    map: src.map, normalMap: src.normalMap, roughnessMap: src.roughnessMap, metalnessMap: src.metalnessMap,
    roughness: 1, metalness: 1, clearcoat: 0.55, clearcoatRoughness: 0.18, envMapIntensity: 0.7,
  })
  if (src.normalMap) m.normalScale.copy(src.normalScale)
  const u = {
    uPrimary: { value: new THREE.Color(livery.primary) },
    uSecondary: { value: new THREE.Color(livery.secondary) },
    uScorch: scorch,
    uStripe: { value: livery.stripe === false ? 0 : 1 },
    // Solid paints: no metallic flake and a slightly glossier base under the clearcoat.
    uPaintMetal: { value: livery.finish === 'solid' ? 0.0 : 0.35 },
    uPaintRough: { value: livery.finish === 'solid' ? 0.26 : 0.32 },
  }
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;\nuniform vec3 uPrimary; uniform vec3 uSecondary; uniform float uScorch; uniform float uStripe; uniform float uPaintMetal; uniform float uPaintRough;\nfloat paintMask; float scorchK;')
      .replace('#include <map_fragment>', `#include <map_fragment>
  {
    vec3 c = diffuseColor.rgb;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    paintMask = smoothstep(0.34, 0.6, lum) * (1.0 - smoothstep(0.1, 0.22, sat));
    float stripe = (1.0 - smoothstep(0.018, 0.024, abs(abs(vObj.z) - 0.045))) * step(0.02, vObj.y) * uStripe;
    vec3 paint = mix(uPrimary, uSecondary, stripe) * clamp(lum * 1.25, 0.0, 1.2);
    diffuseColor.rgb = mix(c, paint, paintMask);
    // Damage scorch: patchy soot that spreads as the car takes damage (burnt shell when wrecked).
    float n = fract(sin(dot(floor(vObj * 22.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float n2 = fract(sin(dot(floor(vObj * 7.0), vec3(39.34, 11.13, 83.17))) * 24634.6345);
    scorchK = smoothstep(0.0, 0.35, uScorch * 1.5 - (n * 0.45 + n2 * 0.55));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.04, 0.036) * (0.7 + 0.6 * n), scorchK);
  }`)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, uPaintMetal, paintMask);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(roughnessFactor, uPaintRough, paintMask), 0.92, scorchK);')
  }
  m.customProgramCacheKey = () => 'livery-paint'
  if (ghost) { m.transparent = true; m.opacity = 0.38; m.depthWrite = false }
  return m
}

function rigFromGenerated(scene: THREE.Object3D, livery: LiveryInfo, ghost: boolean, owned: THREE.Material[], scorch: { value: number }, dims?: [number, number, number]): Rig {
  const inner = scene.clone(true)
  inner.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mat = livePaint(mesh.material as THREE.MeshStandardMaterial, livery, ghost, scorch)
    owned.push(mat)
    mesh.material = mat
    mesh.castShadow = !ghost
    mesh.receiveShadow = !ghost
  })
  // Generated cars face +X in a unit box: rotate to +Z forward, scale to metres, sit on y = 0.
  const body = new THREE.Group()
  inner.rotation.y = -Math.PI / 2
  body.add(inner)
  body.updateMatrixWorld(true)
  let box = new THREE.Box3().setFromObject(body)
  const size = box.getSize(new THREE.Vector3())
  const k = (dims?.[2] ?? CAR_LENGTH) / Math.max(1e-3, size.z)
  // Rotated by -90deg about Y, so the model's local X is world Z (length) and local Z is world X (width).
  if (dims) inner.scale.set(k, dims[1] / Math.max(1e-3, size.y), dims[0] / Math.max(1e-3, size.x))
  else inner.scale.setScalar(k)
  body.updateMatrixWorld(true)
  box = new THREE.Box3().setFromObject(body)
  inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
  body.updateMatrixWorld(true)
  box = new THREE.Box3().setFromObject(body)
  return { body, wheels: [], front: [], size: box.getSize(new THREE.Vector3()), min: box.min.clone(), max: box.max.clone(), wheelR: 0.34 }
}

function isGenerated(scene: THREE.Object3D): boolean {
  let gen = false
  scene.traverse(o => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m && m.name?.startsWith('tripo')) gen = true })
  return gen
}

function rigFromGltf(scene: THREE.Object3D, livery: LiveryInfo, ghost: boolean, owned: THREE.Material[], scorch: { value: number }, dims?: [number, number, number]): Rig {
  if (isGenerated(scene)) return rigFromGenerated(scene, livery, ghost, owned, scorch, dims)
  const body = scene.clone(true)
  paintMaterials(body, livery, ghost, owned)
  body.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(body)
  const wheels: THREE.Object3D[] = []
  const front: THREE.Object3D[] = []
  let wheelR = 0.34
  for (const name of WHEEL_NAMES) {
    const w = body.getObjectByName(name)
    if (!w || !w.parent) continue
    const holder = new THREE.Group()
    holder.position.copy(w.position)
    w.parent.add(holder)
    w.position.set(0, 0, 0)
    holder.add(w)
    wheels.push(w)
    if (name.includes('front')) front.push(holder)
    wheelR = Math.max(0.2, holder.position.y)
  }
  return { body, wheels, front, size: box.getSize(new THREE.Vector3()), min: box.min.clone(), max: box.max.clone(), wheelR }
}

function proxyRig(livery: LiveryInfo, ghost: boolean, owned: THREE.Material[]): Rig {
  const mat = new THREE.MeshPhysicalMaterial({ color: livery.primary, roughness: 0.35, metalness: 0.4, clearcoat: 1, transparent: ghost, opacity: ghost ? 0.38 : 1 })
  owned.push(mat)
  const body = new THREE.Group()
  const shell = new THREE.Mesh(new THREE.CapsuleGeometry(0.75, 3, 6, 12), mat)
  shell.rotation.x = Math.PI / 2
  shell.scale.set(1.25, 1, 0.55)
  shell.position.y = 0.62
  body.add(shell)
  const size = new THREE.Vector3(2, 1.2, 4.6)
  return { body, wheels: [], front: [], size, min: new THREE.Vector3(-1, 0, -2.3), max: new THREE.Vector3(1, 1.2, 2.3), wheelR: 0.34 }
}

export class CarModel {
  readonly root = new THREE.Group()
  readonly tilt = new THREE.Group()
  readonly trickGroup = new THREE.Group()
  readonly body = new THREE.Group()
  /** Exhaust flame emitters (visibility toggled by boost; ghosts toggle them from net flags). */
  readonly flames: THREE.Object3D[] = []
  readonly shield: THREE.Mesh
  readonly tag: THREE.Sprite
  exhausts: THREE.Vector3[] = [new THREE.Vector3(-0.4, 0.45, -2.3), new THREE.Vector3(0.4, 0.45, -2.3)]
  /** Rear corners (local) for tyre smoke and drift sparks. */
  rearWheels: THREE.Vector3[] = [new THREE.Vector3(-0.85, 0.1, -1.4), new THREE.Vector3(0.85, 0.1, -1.4)]
  wheelR = 0.34
  length = 4.6
  private rig: Rig
  private wheelAngle = 0
  private readonly owned: THREE.Material[] = []
  private readonly brakeMat: THREE.SpriteMaterial
  private readonly headMat: THREE.SpriteMaterial
  private readonly flameMats: THREE.MeshBasicMaterial[] = []
  private readonly lights = new THREE.Group()
  private readonly blob: THREE.Mesh
  private disposed = false
  private shieldFlash = 0
  private lastV = 0
  private brakeHold = 0
  /** Shared scorch amount for every paint material of this car (0 clean – 1 burnt out). */
  private readonly scorch = { value: 0 }

  constructor(readonly chassis: number, readonly livery: number, readonly ghost = false, name = '') {
    const liv = LIVERIES[livery] ?? LIVERIES[0]
    const key = `car:${CAR_KEYS[chassis] ?? CAR_KEYS[0]}`
    const gltf = assets.models.get(key)
    this.rig = gltf ? rigFromGltf(gltf.scene, liv, ghost, this.owned, this.scorch, CHASSIS[chassis]?.dims) : proxyRig(liv, ghost, this.owned)
    this.body.add(this.rig.body)
    this.brakeMat = new THREE.SpriteMaterial({ color: '#ff2a1a', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5, toneMapped: false })
    this.headMat = new THREE.SpriteMaterial({ color: '#fff1cf', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.32, toneMapped: false })
    this.body.add(this.lights)
    const blobMat = new THREE.MeshBasicMaterial({ map: blobShadow(), transparent: true, depthWrite: false, opacity: ghost ? 0.25 : 1 })
    this.owned.push(blobMat)
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), blobMat)
    this.blob.rotation.x = -Math.PI / 2
    this.blob.position.y = 0.04
    this.blob.renderOrder = 1
    this.tilt.add(this.blob)
    const sm = shieldMat()
    this.owned.push(sm)
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), sm)
    this.shield.visible = false
    this.body.add(this.shield)
    const tex = tagTexture(name || CHASSIS[chassis]?.name || 'Racer', liv.primary)
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, opacity: ghost ? 0.7 : 0.95 }))
    this.tag.scale.set(2.3, 0.575, 1)
    this.tag.position.set(0, 3.4, 0)
    this.tag.renderOrder = 20
    this.root.add(this.tag)
    this.trickGroup.add(this.body)
    this.tilt.add(this.trickGroup)
    this.root.add(this.tilt)
    this.layout()
    if (!gltf) {
      void assets.whenSettled(key).then(() => {
        const g = assets.models.get(key)
        if (!g || this.disposed) return
        this.body.remove(this.rig.body)
        this.rig = rigFromGltf(g.scene, liv, ghost, this.owned, this.scorch, CHASSIS[chassis]?.dims)
        this.body.add(this.rig.body)
        this.layout()
      })
    }
    if (!assets.has('fx')) void assets.whenSettled('fx').then(() => !this.disposed && this.layout())
  }

  /** Position lights, flames, shield and blob from the current rig's bounds. */
  private layout(): void {
    const { min, max, size, wheelR } = this.rig
    this.wheelR = wheelR
    this.length = size.z
    const halfW = size.x / 2
    const exY = Math.min(0.42, size.y * 0.3)
    this.exhausts = [new THREE.Vector3(-0.42, exY, min.z + 0.05), new THREE.Vector3(0.42, exY, min.z + 0.05)]
    const rearHolders = this.rig.wheels.map(w => w.parent!).filter(h => !this.rig.front.includes(h))
    const rz = rearHolders.length ? rearHolders[0].position.z : -1.4
    this.rearWheels = [new THREE.Vector3(-halfW + 0.3, 0.08, rz), new THREE.Vector3(halfW - 0.3, 0.08, rz)]
    this.blob.scale.set(size.x * 1.35, size.z * 1.18, 1)
    this.shield.scale.set(halfW * 1.55, size.y * 1.05, size.z * 0.66)
    this.shield.position.set(0, size.y * 0.5, (min.z + max.z) / 2)
    // Light glows.
    this.lights.clear()
    glowTex ??= atlasCell(0, 1)
    flameTex ??= atlasCell(2, 0)
    if (glowTex) {
      this.brakeMat.map = glowTex
      this.headMat.map = glowTex
      this.brakeMat.needsUpdate = this.headMat.needsUpdate = true
    }
    for (const side of [-1, 1]) {
      const b = new THREE.Sprite(this.brakeMat)
      b.position.set(side * (halfW - 0.32), Math.min(0.78, size.y * 0.55), min.z + 0.05)
      b.scale.setScalar(0.34)
      // Daylight race: no headlight glare sprites, only brake lights.
      this.lights.add(b)
    }
    // Exhaust flames: two crossed quads per pipe with the flame cell.
    for (const f of this.flames) f.parent?.remove(f)
    this.flames.length = 0
    for (const m of this.flameMats) m.dispose()
    this.flameMats.length = 0
    const geo = new THREE.PlaneGeometry(0.55, 1.8)
    geo.rotateX(-Math.PI / 2)
    geo.translate(0, 0, -0.9)
    for (const p of this.exhausts) {
      const mat = new THREE.MeshBasicMaterial({ map: flameTex, color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, opacity: flameTex ? 1 : 0.8 })
      this.flameMats.push(mat)
      const g = new THREE.Group()
      const a = new THREE.Mesh(geo, mat)
      const b = new THREE.Mesh(geo, mat)
      b.rotation.z = Math.PI / 2
      g.add(a, b)
      g.position.copy(p)
      g.visible = false
      this.body.add(g)
      this.flames.push(g)
    }
  }

  /** Visual pose from an interpolated position plus car state. */
  /** Last posed heading (the root quaternion may carry corkscrew roll, so read yaw from here). */
  yaw = 0
  pose(x: number, y: number, z: number, yaw: number, car: CarState | null, dt: number, time: number, pitch: number, roll: number): void {
    this.root.position.set(x, y, z)
    this.root.rotation.set(0, yaw, 0)
    this.yaw = yaw
    const speed = car ? car.vF : 0
    this.wheelAngle += (speed * dt) / this.wheelR
    for (const w of this.rig.wheels) w.rotation.x = this.wheelAngle
    const steer = car ? car.steerVis : 0
    for (const f of this.rig.front) f.rotation.y = -steer * 0.42
    if (!car) {
      this.tilt.rotation.set(pitch, 0, roll)
      for (const f of this.flames) if (f.visible) f.scale.set(1, 1, 0.85 + Math.sin(time * 55 + f.position.x * 9) * 0.2)
      return
    }
    const driftLean = car.drift ? car.driftDir * 0.07 : 0
    const turnLean = car.grounded ? -steer * Math.min(1, Math.abs(speed) / 40) * 0.045 : 0
    this.tilt.rotation.set(pitch, car.drift ? -car.driftDir * 0.28 : 0, roll + driftLean + turnLean)
    const k = car.trick !== 0 ? Math.min(1, car.trickT / TRICK_TIME) : 0
    const ease = k * k * (3 - 2 * k)
    const burnt = car.wreck > 0 ? 1 : Math.min(0.8, Math.max(0, (car.damage - 0.18) / 0.82))
    this.scorch.value += (burnt - this.scorch.value) * Math.min(1, dt * 6)
    if (car.wreck > 0) {
      // Destroyed: blown into the air, flipped onto its roof, then burning.
      const w = 1 - car.wreck / WRECK_TIME
      const up = Math.min(1, w / 0.38)
      this.trickGroup.rotation.set(Math.sin(up * Math.PI) * 0.5, up * 1.3, up * Math.PI)
      this.trickGroup.position.y = Math.sin(up * Math.PI) * 2.6 + (up >= 1 ? this.rig.size.y * 0.92 : up * this.rig.size.y * 0.92)
    } else {
      this.trickGroup.rotation.set(car.trick === 1 ? -Math.PI * 2 * ease : 0, car.spin > 0 ? car.spin * 14 : 0, car.trick === 2 ? Math.PI * 2 * ease : car.trick === 3 ? -Math.PI * 2 * ease : 0)
      this.trickGroup.position.y = car.trick !== 0 ? Math.sin(ease * Math.PI) * 0.8 : 0
    }
    this.body.position.y = -car.landImpact * 0.16
    // Blob shadow fades with height above the road.
    this.blob.visible = car.grounded || this.trickGroup.position.y < 2
    ;(this.blob.material as THREE.MeshBasicMaterial).opacity = (this.ghost ? 0.25 : 1) * (car.grounded ? 1 : 0.45)
    const boosting = car.boostTime > 0 || car.meterBoosting || car.powerBoosting
    const cyan = car.meterBoosting
    const power = car.powerBoosting
    for (let i = 0; i < this.flames.length; i += 1) {
      const f = this.flames[i]
      f.visible = boosting && car.wreck <= 0
      if (boosting) {
        const flick = 0.85 + Math.sin(time * 61 + i * 2.1) * 0.12 + Math.sin(time * 37 + i) * 0.08
        // Nitro: long blue-hot cones that flare on ignition and taper as the burst ends.
        const nit = car.nitro > 0 ? Math.min(1, car.nitro / 0.3) * (1 + 0.8 * Math.max(0, (car.nitro - 1.05) / 0.35)) : 0
        const w = power ? 1.35 : cyan ? 1.2 + nit * 0.25 : 1
        f.scale.set(w * 1.15, w * 1.15, flick * (cyan ? 2.2 + nit * 1.6 : 1.1))
        const fm = this.flameMats[i]
        if (fm) {
          fm.color.set(power ? '#ffd23f' : cyan ? (nit > 1.2 ? '#dcebff' : '#6f9cff') : '#ffffff')
          // The flame cell is orange: tinting it blue turns it green, so nitro burns on the neutral glow cell.
          const want = cyan && glowTex ? glowTex : flameTex
          if (want && fm.map !== want) { fm.map = want; fm.needsUpdate = true }
        }
      }
    }
    const decel = dt > 0 ? (this.lastV - car.vF) / dt : 0
    this.lastV = car.vF
    this.brakeHold = decel > 7 && car.vF > 2 ? 0.25 : Math.max(0, this.brakeHold - dt)
    const braking = this.brakeHold > 0
    this.brakeMat.opacity = braking ? 0.9 : 0
    this.lights.visible = braking
    this.shield.visible = car.shield > 0
    if (this.shield.visible) {
      const u = (this.shield.material as THREE.ShaderMaterial).uniforms
      u.uTime.value = time
      this.shieldFlash = Math.max(0, this.shieldFlash - dt * 2.5)
      u.uFlash.value = this.shieldFlash
    }
    // Respawn hold / grace: slow blink while waiting, fast blink once released.
    const flicker = car.ghostT > 0 && (car.hold > 0 ? (time * 3) % 1 < 0.22 : Math.floor(time * 12) % 2 === 0)
    this.body.visible = !flicker || this.ghost
  }

  /** Corkscrew ride: align the whole car to the ribbon (forward f, surface normal n). */
  orient(fx: number, fy: number, fz: number, nx: number, ny: number, nz: number): void {
    const f = CarModel.tf.set(fx, fy, fz).normalize()
    const n = CarModel.tn.set(nx, ny, nz).normalize()
    const xAxis = CarModel.tx.crossVectors(n, f).normalize()
    CarModel.tm.makeBasis(xAxis, n, f)
    this.root.quaternion.setFromRotationMatrix(CarModel.tm)
    this.tilt.rotation.set(0, this.tilt.rotation.y, 0)
  }
  private static readonly tf = new THREE.Vector3()
  private static readonly tn = new THREE.Vector3()
  private static readonly tx = new THREE.Vector3()
  private static readonly tm = new THREE.Matrix4()

  /** Brief bright pulse on the shield bubble (block / activation). */
  flashShield(): void {
    this.shieldFlash = 1
  }

  dispose(): void {
    this.disposed = true
    this.shield.geometry.dispose()
    this.blob.geometry.dispose()
    for (const m of this.owned) m.dispose()
    for (const m of this.flameMats) { m.map?.dispose(); m.dispose() }
    this.brakeMat.dispose()
    this.headMat.dispose()
    ;(this.tag.material as THREE.SpriteMaterial).map?.dispose()
    this.tag.material.dispose()
  }
}
