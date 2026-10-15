import * as THREE from 'three'
import { assets } from '../engine/assets'
import { propMesh } from './props'
import type { RaceSim } from '../sim/race'
import { mod } from '../sim/math'

/**
 * Presentation-only effects: GPU-billboarded, atlas-textured particles (additive and alpha pools),
 * ground shock rings, flashes, and the seeker / mine / lock-warning visuals. Effects read
 * simulation state but never feed anything back into it.
 *
 * Atlas cells (4×2): 0 smoke, 1 dust, 2 flame, 3 spark, 4 glow, 5 ring, 6 confetti, 7 line.
 */
export const CELL = { smoke: 0, dust: 1, flame: 2, spark: 3, glow: 4, ring: 5, confetti: 6, line: 7 } as const

export interface SpawnOpts {
  cell: number
  life: number
  size: number
  /** End size multiplier. */
  grow?: number
  color: THREE.ColorRepresentation
  alpha?: number
  gravity?: number
  drag?: number
  spin?: number
  /** > 0 stretches the sprite along its screen-space velocity (length multiplier). */
  stretch?: number
  /** Fraction of life spent fading in. */
  fadeIn?: number
}

const VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iDir;
  attribute vec4 iColor;
  attribute vec4 iMisc; // size, stretch, rotation, cell
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vCell;
  varying float vFade;
  void main() {
    vUv = uv;
    vColor = iColor;
    vCell = iMisc.w;
    vec4 mv = viewMatrix * vec4(iPos, 1.0);
    vec2 q = position.xy;
    float size = iMisc.x;
    // Never let effects block the driver's view: fade sprites that are close to the camera
    // (the chase camera sits ~7.4 m behind the car) or that would cover a big part of the screen.
    float dist = max(-mv.z, 0.05);
    float cover = size * max(iMisc.y, 1.0) / dist;
    vFade = smoothstep(1.6, 5.2, dist) * (1.0 - smoothstep(0.4, 1.1, cover) * 0.85);
    if (iMisc.y > 0.0) {
      vec3 dv = (viewMatrix * vec4(iDir, 0.0)).xyz;
      vec2 a = length(dv.xy) > 1e-4 ? normalize(dv.xy) : vec2(1.0, 0.0);
      vec2 b = vec2(-a.y, a.x);
      mv.xy += a * q.x * size * iMisc.y + b * q.y * size;
    } else {
      float c = cos(iMisc.z), s = sin(iMisc.z);
      mv.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y) * size;
    }
    gl_Position = projectionMatrix * mv;
  }`

const FRAG = (additive: boolean) => /* glsl */ `
  uniform sampler2D tAtlas;
  uniform float uLoaded;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vCell;
  varying float vFade;
  void main() {
    float col = mod(vCell, 4.0);
    float row = floor(vCell / 4.0);
    vec2 uv = vec2((col + vUv.x) * 0.25, (1.0 - row) * 0.5 + vUv.y * 0.5);
    vec4 tex = texture2D(tAtlas, uv);
    // Fallback before the atlas streams in: soft round dot.
    float d = length(vUv - 0.5) * 2.0;
    tex = mix(vec4(1.0, 1.0, 1.0, smoothstep(1.0, 0.2, d)), tex, uLoaded);
    vec4 c = tex * vColor;
    c.a *= vFade;
    ${additive ? 'gl_FragColor = vec4(c.rgb * c.a, c.a);' : 'if (c.a < 0.004) discard; gl_FragColor = c;'}
  }`

class SpritePool {
  readonly mesh: THREE.Mesh
  private readonly geo: THREE.InstancedBufferGeometry
  private readonly aPos: THREE.InstancedBufferAttribute
  private readonly aDir: THREE.InstancedBufferAttribute
  private readonly aColor: THREE.InstancedBufferAttribute
  private readonly aMisc: THREE.InstancedBufferAttribute
  private readonly p: Float32Array
  private readonly v: Float32Array
  private readonly c: Float32Array
  /** life, max, size, grow, gravity, drag, spin, rot, stretch, cell, alpha, fadeIn */
  private readonly s: Float32Array
  private static readonly S = 12
  count = 0
  budget = 1
  private readonly col = new THREE.Color()

  constructor(readonly max: number, additive: boolean, uniforms: Record<string, THREE.IUniform>) {
    const base = new THREE.PlaneGeometry(1, 1)
    this.geo = new THREE.InstancedBufferGeometry()
    this.geo.index = base.index
    this.geo.setAttribute('position', base.getAttribute('position'))
    this.geo.setAttribute('uv', base.getAttribute('uv'))
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage)
    this.aDir = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage)
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage)
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage)
    this.geo.setAttribute('iPos', this.aPos)
    this.geo.setAttribute('iDir', this.aDir)
    this.geo.setAttribute('iColor', this.aColor)
    this.geo.setAttribute('iMisc', this.aMisc)
    this.geo.instanceCount = 0
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG(additive),
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.CustomBlending : THREE.NormalBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    })
    if (additive) {
      mat.blendSrc = THREE.OneFactor
      mat.blendDst = THREE.OneFactor
    }
    this.mesh = new THREE.Mesh(this.geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = additive ? 12 : 11
    this.p = new Float32Array(max * 3)
    this.v = new Float32Array(max * 3)
    this.c = new Float32Array(max * 3)
    this.s = new Float32Array(max * SpritePool.S)
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, o: SpawnOpts): void {
    if (this.budget < 1 && Math.random() > this.budget) return
    if (this.count >= this.max) return
    const k = this.count
    this.count += 1
    this.p[k * 3] = x; this.p[k * 3 + 1] = y; this.p[k * 3 + 2] = z
    this.v[k * 3] = vx; this.v[k * 3 + 1] = vy; this.v[k * 3 + 2] = vz
    this.col.set(o.color)
    this.c[k * 3] = this.col.r; this.c[k * 3 + 1] = this.col.g; this.c[k * 3 + 2] = this.col.b
    const S = SpritePool.S
    const s = this.s
    s[k * S] = o.life
    s[k * S + 1] = o.life
    s[k * S + 2] = o.size
    s[k * S + 3] = o.grow ?? 1
    s[k * S + 4] = o.gravity ?? 0
    s[k * S + 5] = o.drag ?? 1.5
    s[k * S + 6] = o.spin ?? 0
    s[k * S + 7] = Math.random() * Math.PI * 2
    s[k * S + 8] = o.stretch ?? 0
    s[k * S + 9] = o.cell
    s[k * S + 10] = o.alpha ?? 1
    s[k * S + 11] = o.fadeIn ?? 0.08
  }

  private kill(k: number): void {
    const last = this.count - 1
    if (k !== last) {
      this.p.copyWithin(k * 3, last * 3, last * 3 + 3)
      this.v.copyWithin(k * 3, last * 3, last * 3 + 3)
      this.c.copyWithin(k * 3, last * 3, last * 3 + 3)
      this.s.copyWithin(k * SpritePool.S, last * SpritePool.S, last * SpritePool.S + SpritePool.S)
    }
    this.count -= 1
  }

  update(dt: number): void {
    const S = SpritePool.S
    const s = this.s
    for (let k = this.count - 1; k >= 0; k -= 1) {
      s[k * S] -= dt
      if (s[k * S] <= 0) this.kill(k)
    }
    const pos = this.aPos.array as Float32Array
    const dir = this.aDir.array as Float32Array
    const colr = this.aColor.array as Float32Array
    const misc = this.aMisc.array as Float32Array
    for (let k = 0; k < this.count; k += 1) {
      const o = k * 3
      const drag = Math.exp(-dt * s[k * S + 5])
      this.v[o + 1] -= s[k * S + 4] * dt
      this.v[o] *= drag; this.v[o + 1] *= drag; this.v[o + 2] *= drag
      this.p[o] += this.v[o] * dt
      this.p[o + 1] += this.v[o + 1] * dt
      this.p[o + 2] += this.v[o + 2] * dt
      s[k * S + 7] += s[k * S + 6] * dt
      const age = 1 - s[k * S] / s[k * S + 1]
      const fin = s[k * S + 11]
      const a = (age < fin ? age / Math.max(1e-3, fin) : 1 - (age - fin) / (1 - fin)) * s[k * S + 10]
      const size = s[k * S + 2] * (1 + (s[k * S + 3] - 1) * age)
      pos[o] = this.p[o]; pos[o + 1] = this.p[o + 1]; pos[o + 2] = this.p[o + 2]
      dir[o] = this.v[o]; dir[o + 1] = this.v[o + 1]; dir[o + 2] = this.v[o + 2]
      colr[k * 4] = this.c[o]; colr[k * 4 + 1] = this.c[o + 1]; colr[k * 4 + 2] = this.c[o + 2]; colr[k * 4 + 3] = Math.max(0, a)
      misc[k * 4] = size
      misc[k * 4 + 1] = s[k * S + 8]
      misc[k * 4 + 2] = s[k * S + 7]
      misc[k * 4 + 3] = s[k * S + 9]
    }
    this.geo.instanceCount = this.count
    for (const at of [this.aPos, this.aDir, this.aColor, this.aMisc]) {
      at.needsUpdate = true
      at.clearUpdateRanges()
      at.addUpdateRange(0, this.count * at.itemSize)
    }
  }

  clear(): void {
    this.count = 0
    this.geo.instanceCount = 0
  }
}

/** Expanding flat ring decals on the road (landings, pads, gate crossings, explosions). */
class RingPool {
  readonly group = new THREE.Group()
  private readonly items: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; max: number; r0: number; r1: number }[] = []
  private next = 0

  constructor(count: number) {
    const geo = new THREE.PlaneGeometry(2, 2)
    geo.rotateX(-Math.PI / 2)
    for (let i = 0; i < count; i += 1) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.visible = false
      mesh.renderOrder = 10
      this.group.add(mesh)
      this.items.push({ mesh, mat, life: 0, max: 1, r0: 1, r1: 2 })
    }
  }

  setTexture(t: THREE.Texture): void {
    for (const it of this.items) { it.mat.map = t; it.mat.needsUpdate = true }
  }

  spawn(x: number, y: number, z: number, r0: number, r1: number, life: number, color: THREE.ColorRepresentation, tiltX = 0, yaw = 0): void {
    const it = this.items[this.next]
    this.next = (this.next + 1) % this.items.length
    it.mesh.position.set(x, y, z)
    it.mesh.rotation.set(tiltX, yaw, 0)
    it.mat.color.set(color)
    it.life = life
    it.max = life
    it.r0 = r0
    it.r1 = r1
    it.mesh.visible = true
  }

  update(dt: number): void {
    for (const it of this.items) {
      if (!it.mesh.visible) continue
      it.life -= dt
      if (it.life <= 0) { it.mesh.visible = false; continue }
      const k = 1 - it.life / it.max
      const e = 1 - (1 - k) * (1 - k)
      it.mesh.scale.setScalar(it.r0 + (it.r1 - it.r0) * e)
      it.mat.opacity = (1 - k) * (1 - k)
    }
  }

  clear(): void {
    for (const it of this.items) it.mesh.visible = false
  }
}

const TIER_COLORS = ['#ffd27a', '#56c8ff', '#ff8a2a', '#e45cff']
export const tierColor = (tier: number): string => TIER_COLORS[Math.max(0, Math.min(3, tier))]

export class Effects {
  readonly group = new THREE.Group()
  readonly add: SpritePool
  readonly alpha: SpritePool
  readonly rings: RingPool
  private readonly uniforms = { tAtlas: { value: null as THREE.Texture | null }, uLoaded: { value: 0 } }
  private readonly seekerMeshes = new Map<number, THREE.Group>()
  private readonly mineMeshes = new Map<number, THREE.Group>()
  private readonly lockMarkers: THREE.Group[] = []
  private readonly frame = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
  private readonly seekerParts: { body: THREE.BufferGeometry; nose: THREE.BufferGeometry; fin: THREE.BufferGeometry; bodyMat: THREE.Material; noseMat: THREE.Material; finMat: THREE.Material }
  private readonly mineParts: { body: THREE.BufferGeometry; cap: THREE.BufferGeometry; spike: THREE.BufferGeometry; metal: THREE.Material; dark: THREE.Material }
  private readonly lockRingMat = new THREE.MeshBasicMaterial({ color: '#ff3b4a', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
  private readonly beamMat = new THREE.MeshBasicMaterial({ color: '#ff3b4a', transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false })
  private readonly glowMat = new THREE.SpriteMaterial({ color: '#ff3b4a', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
  private readonly mineRingMat = new THREE.MeshBasicMaterial({ color: '#ff3b4a', transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
  private readonly quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2)
  private readonly beamGeo = new THREE.CylinderGeometry(1.4, 1.4, 24, 20, 1, true)

  constructor() {
    this.add = new SpritePool(1600, true, this.uniforms)
    this.alpha = new SpritePool(900, false, this.uniforms)
    this.rings = new RingPool(24)
    this.group.add(this.alpha.mesh, this.add.mesh, this.rings.group)
    const apply = () => {
      const t = assets.tex('fx')
      if (!t) return
      this.uniforms.tAtlas.value = t
      this.uniforms.uLoaded.value = 1
      const ring = t.clone()
      ring.repeat.set(0.25, 0.5)
      ring.offset.set(0.25, 0)
      ring.needsUpdate = true
      this.rings.setTexture(ring)
      this.lockRingMat.map = ring
      this.mineRingMat.map = ring
      const glow = t.clone()
      glow.repeat.set(0.25, 0.5)
      glow.offset.set(0, 0)
      glow.needsUpdate = true
      this.glowMat.map = glow
      for (const m of [this.lockRingMat, this.mineRingMat, this.glowMat]) m.needsUpdate = true
    }
    apply()
    void assets.whenSettled('fx').then(apply)
    // Seeker: slim missile with nose cone and cross fins.
    const body = new THREE.CylinderGeometry(0.22, 0.26, 1.7, 14)
    body.rotateX(Math.PI / 2)
    const nose = new THREE.ConeGeometry(0.22, 0.6, 14)
    nose.rotateX(Math.PI / 2)
    nose.translate(0, 0, 1.15)
    const fin = new THREE.BoxGeometry(0.9, 0.04, 0.4)
    fin.translate(0, 0, -0.7)
    this.seekerParts = {
      body, nose, fin,
      bodyMat: new THREE.MeshStandardMaterial({ color: '#d9d6d0', roughness: 0.4, metalness: 0.4, envMapIntensity: 0.6 }),
      noseMat: new THREE.MeshStandardMaterial({ color: '#d7263d', roughness: 0.35, metalness: 0.2, emissive: '#5a0610', emissiveIntensity: 0.6 }),
      finMat: new THREE.MeshStandardMaterial({ color: '#2a2a2e', roughness: 0.6, metalness: 0.3 }),
    }
    // Mine: squat armoured disc with spikes and a blinking dome.
    const mb = new THREE.CylinderGeometry(0.95, 1.1, 0.42, 24)
    const cap = new THREE.SphereGeometry(0.34, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)
    cap.translate(0, 0.21, 0)
    const spike = new THREE.ConeGeometry(0.1, 0.42, 8)
    spike.translate(0, 0.2, 0)
    this.mineParts = {
      body: mb, cap, spike,
      metal: new THREE.MeshStandardMaterial({ color: '#3b3a3f', roughness: 0.55, metalness: 0.5, envMapIntensity: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: '#8a1320', roughness: 0.3, metalness: 0.1, emissive: '#ff2a3a', emissiveIntensity: 0.7 }),
    }
  }

  get activeCount(): number {
    return this.add.count + this.alpha.count
  }

  setBudget(b: number): void {
    this.add.budget = b
    this.alpha.budget = b
  }

  // ─── generic helpers ─────────────────────────────────────────────────

  spray(pool: 'add' | 'alpha', x: number, y: number, z: number, n: number, speed: number, o: SpawnOpts, up = 0.5, spread = 1): void {
    const p = pool === 'add' ? this.add : this.alpha
    for (let k = 0; k < n; k += 1) {
      const a = Math.random() * Math.PI * 2
      const u = Math.random() * 2 - 1
      const r = Math.sqrt(1 - u * u) * spread
      const s = speed * (0.35 + Math.random() * 0.65)
      p.spawn(x, y, z, Math.cos(a) * r * s, (Math.abs(u) * (1 - up) + up) * s, Math.sin(a) * r * s, { ...o, life: o.life * (0.65 + Math.random() * 0.6), size: o.size * (0.7 + Math.random() * 0.6) })
    }
  }

  flash(x: number, y: number, z: number, color: THREE.ColorRepresentation, size = 6, life = 0.22): void {
    this.add.spawn(x, y, z, 0, 0, 0, { cell: CELL.glow, life, size, grow: 1.6, color, fadeIn: 0.05 })
  }

  shock(x: number, y: number, z: number, color: THREE.ColorRepresentation, r1 = 7, life = 0.5): void {
    this.rings.spawn(x, y + 0.12, z, 0.6, r1, life, color)
  }

  /** Compatibility burst used by session events (glow sparks or dust clouds). */
  burst(x: number, y: number, z: number, n: number, speed: number, color: THREE.ColorRepresentation, size = 0.25, life = 0.6, gravity = 9, pool: 'glow' | 'dust' = 'glow', stretch = 0): void {
    if (pool === 'dust') {
      this.spray('alpha', x, y, z, Math.ceil(n * 0.7), speed * 0.8, { cell: CELL.dust, life: life * 1.6, size: size * 4.2, grow: 2.2, color, alpha: 0.75, gravity: -gravity * 0.2, drag: 2.2, spin: (Math.random() - 0.5) * 1.5, fadeIn: 0.12 }, 0.35)
      return
    }
    this.spray('add', x, y, z, n, speed * 1.2, { cell: CELL.spark, life, size: size * 2.6, color, gravity, drag: 1.2, stretch: stretch || 3.2 }, 0.4)
    this.spray('add', x, y, z, Math.ceil(n / 3), speed * 0.5, { cell: CELL.glow, life: life * 0.8, size: size * 5, grow: 0.3, color, gravity: gravity * 0.2, drag: 3 }, 0.4)
    this.flash(x, y, z, color, 3 + size * 10, 0.18)
  }

  // ─── driving effects ─────────────────────────────────────────────────

  driftSparks(x: number, y: number, z: number, vx: number, vz: number, tier: number): void {
    const c = tierColor(tier)
    const n = tier > 0 ? 3 : 1
    for (let k = 0; k < n; k += 1) {
      this.add.spawn(x, y, z, -vx * 0.12 + (Math.random() - 0.5) * 7, 2 + Math.random() * 4.5, -vz * 0.12 + (Math.random() - 0.5) * 7, { cell: CELL.spark, life: 0.25 + Math.random() * 0.25, size: tier > 0 ? 0.55 : 0.35, color: c, gravity: 16, drag: 0.8, stretch: 3.5 })
    }
    if (tier > 0 && Math.random() < 0.5) this.add.spawn(x, y + 0.1, z, 0, 0.4, 0, { cell: CELL.glow, life: 0.12, size: 1.3 + tier * 0.3, color: c, fadeIn: 0.1 })
  }

  tyreSmoke(x: number, y: number, z: number, vx: number, vz: number, amount: number, color = '#ded2c4'): void {
    if (Math.random() > amount) return
    this.alpha.spawn(x + (Math.random() - 0.5) * 0.6, y + 0.35, z + (Math.random() - 0.5) * 0.6, vx * 0.15 + (Math.random() - 0.5) * 2, 0.8 + Math.random() * 1.2, vz * 0.15 + (Math.random() - 0.5) * 2, {
      cell: CELL.smoke, life: 1.1 + Math.random() * 0.8, size: 1.2 + Math.random() * 0.8, grow: 3.2, color, alpha: 0.42, gravity: -0.6, drag: 1.4, spin: (Math.random() - 0.5) * 1.2, fadeIn: 0.12,
    })
  }

  dustTrail(x: number, y: number, z: number, amount: number, color = '#cfa274'): void {
    if (Math.random() > amount) return
    this.alpha.spawn(x + (Math.random() - 0.5), y + 0.4, z + (Math.random() - 0.5), (Math.random() - 0.5) * 2.5, 1 + Math.random() * 1.8, (Math.random() - 0.5) * 2.5, {
      cell: CELL.dust, life: 1.2 + Math.random() * 0.8, size: 1.6 + Math.random() * 1.2, grow: 2.6, color, alpha: 0.6, gravity: -0.3, drag: 1.6, spin: (Math.random() - 0.5), fadeIn: 0.1,
    })
  }

  /** Exhaust fire puffs while boosting (in addition to the car's flame quads). */
  exhaust(x: number, y: number, z: number, bx: number, by: number, bz: number, cyan: boolean): void {
    const c = cyan ? '#7ff3ff' : '#ffb04a'
    this.add.spawn(x, y, z, bx * 8 + (Math.random() - 0.5), by * 8 + Math.random() * 0.6, bz * 8 + (Math.random() - 0.5), { cell: CELL.flame, life: 0.14 + Math.random() * 0.08, size: 0.9, grow: 0.4, color: c, drag: 3, spin: (Math.random() - 0.5) * 4 })
    if (Math.random() < 0.35) this.alpha.spawn(x, y, z, bx * 4, 0.6, bz * 4, { cell: CELL.smoke, life: 0.8, size: 0.6, grow: 3, color: '#6a625c', alpha: 0.25, gravity: -0.8, drag: 2 })
  }

  /** Nitro: long blue-white flame jets with a hot core, shock diamonds and heat shimmer. */
  nitroJet(x: number, y: number, z: number, bx: number, by: number, bz: number, cvx: number, cvy: number, cvz: number, fresh: number): void {
    const len = 20 + fresh * 14
    for (let k = 0; k < 4; k += 1) {
      const j = 0.8
      const core = k === 0
      this.add.spawn(x, y, z, cvx + bx * len + (Math.random() - 0.5) * j, cvy + by * len + (Math.random() - 0.5) * j, cvz + bz * len + (Math.random() - 0.5) * j, {
        cell: core ? CELL.flame : CELL.glow, life: 0.16 + Math.random() * 0.1, size: (core ? 1.1 : 1.3) + fresh * 0.8, grow: core ? 0.3 : 0.9, color: core ? '#ffffff' : k === 1 ? '#a9c6ff' : '#4d7dff', drag: 1.2, spin: (Math.random() - 0.5) * 6, stretch: 2.8,
      })
    }
    // Hot glow right at the nozzle.
    this.add.spawn(x, y, z, cvx, cvy, cvz, { cell: CELL.glow, life: 0.06, size: 2.2 + fresh * 1.4, color: '#7fa6ff' })
    // Shock-diamond glow pulses along the jet.
    if (Math.random() < 0.55) this.add.spawn(x + bx * 0.9, y + by * 0.9, z + bz * 0.9, cvx + bx * 6, cvy, cvz + bz * 6, { cell: CELL.glow, life: 0.09, size: 1.5 + fresh, color: '#8fb4ff', fadeIn: 0.2 })
    if (Math.random() < 0.3) this.add.spawn(x, y, z, cvx + bx * 10 + (Math.random() - 0.5) * 4, cvy + Math.random() * 2, cvz + bz * 10 + (Math.random() - 0.5) * 4, { cell: CELL.spark, life: 0.3, size: 0.22, color: '#bfe0ff', gravity: 4, drag: 1, stretch: 3 })
    if (Math.random() < 0.25) this.alpha.spawn(x + bx * 1.5, y, z + bz * 1.5, cvx * 0.6 + bx * 3, 0.8, cvz * 0.6 + bz * 3, { cell: CELL.smoke, life: 0.6, size: 0.8, grow: 2.6, color: '#9aa7c0', alpha: 0.16, gravity: -0.6, drag: 2 })
  }
  /** Nitro ignition: blue flash, twin shock rings and a fan of sparks out the back. */
  nitroIgnite(x: number, y: number, z: number, bx: number, bz: number): void {
    this.flash(x, y + 0.5, z, '#9cc2ff', 7, 0.2)
    this.shock(x, y + 0.2, z, '#7fa8ff', 6.5, 0.4)
    this.shock(x, y + 0.2, z, '#e3f0ff', 3.5, 0.28)
    for (let k = 0; k < 26; k += 1) {
      const a = (Math.random() - 0.5) * 1.4
      const sp = 10 + Math.random() * 14
      const c = Math.cos(a), s = Math.sin(a)
      this.add.spawn(x, y + 0.4, z, (bx * c - bz * s) * sp, 1 + Math.random() * 4, (bz * c + bx * s) * sp, { cell: CELL.spark, life: 0.35 + Math.random() * 0.25, size: 0.26, color: k % 3 ? '#a9c8ff' : '#ffffff', gravity: 9, drag: 1.2, stretch: 3.5 })
    }
  }
  /** Corkscrew entry/exit: a ring of speed glints spinning off the ribbon. */
  corkRing(x: number, y: number, z: number, fx: number, fz: number, color: THREE.ColorRepresentation): void {
    this.shock(x, y, z, color, 4.5, 0.35)
    for (let k = 0; k < 24; k += 1) {
      const a = (k / 24) * Math.PI * 2
      const r = 6 + Math.random() * 4
      this.add.spawn(x, y + 1, z, Math.cos(a) * r * fz + fx * 8, Math.sin(a) * r, -Math.cos(a) * r * fx + fz * 8, { cell: CELL.spark, life: 0.45, size: 0.3, color, drag: 1.8, stretch: 3 })
    }
  }
  streak(x: number, y: number, z: number, vx: number, vy: number, vz: number, color = '#ffffff'): void {
    this.add.spawn(x, y, z, vx, vy, vz, { cell: CELL.line, life: 0.32, size: 0.22, color, alpha: 0.6, drag: 0, stretch: 9, fadeIn: 0.25 })
  }

  /** Big celebratory bursts. */
  confetti(x: number, y: number, z: number, n = 60): void {
    const colors = ['#ffcf3f', '#ff5a36', '#3fd0ff', '#ffffff', '#ff4fa3', '#7dff8a']
    for (let k = 0; k < n; k += 1) {
      const a = Math.random() * Math.PI * 2
      const s = 4 + Math.random() * 9
      this.alpha.spawn(x, y, z, Math.cos(a) * s, 6 + Math.random() * 9, Math.sin(a) * s, { cell: CELL.confetti, life: 1.8 + Math.random() * 1.2, size: 0.32 + Math.random() * 0.2, color: colors[k % colors.length], gravity: 7, drag: 1.8, spin: (Math.random() - 0.5) * 16, fadeIn: 0.02 })
    }
  }

  explosion(x: number, y: number, z: number): void {
    this.flash(x, y + 1, z, '#ffb45a', 14, 0.3)
    this.spray('add', x, y + 1, z, 26, 14, { cell: CELL.flame, life: 0.45, size: 2.2, grow: 1.8, color: '#ff8a3a', drag: 3.5, spin: 3 }, 0.3)
    this.spray('add', x, y + 1, z, 40, 22, { cell: CELL.spark, life: 0.6, size: 0.7, color: '#ffd07a', gravity: 14, drag: 0.9, stretch: 4 }, 0.35)
    this.spray('alpha', x, y + 1, z, 18, 6, { cell: CELL.smoke, life: 2.2, size: 3.2, grow: 2.4, color: '#4a423e', alpha: 0.6, gravity: -1.2, drag: 1.4, spin: 0.8, fadeIn: 0.1 }, 0.5)
    this.shock(x, y, z, '#ff9a4a', 11, 0.6)
  }

  // ─── damage ──────────────────────────────────────────────────────────
  /** Tumbling body shards and carbon chips. */
  debris(x: number, y: number, z: number, n: number, vx = 0, vz = 0, tint: THREE.ColorRepresentation = '#2a2624'): void {
    const colors = [tint, '#1b1918', '#3c3733', '#6b6258']
    for (let k = 0; k < n; k += 1) {
      const a = Math.random() * Math.PI * 2
      const sp = 4 + Math.random() * 10
      this.alpha.spawn(x, y, z, Math.cos(a) * sp + vx * 0.4, 4 + Math.random() * 9, Math.sin(a) * sp + vz * 0.4, {
        cell: CELL.confetti, life: 1.1 + Math.random() * 0.9, size: 0.3 + Math.random() * 0.35, color: colors[k % colors.length], gravity: 22, drag: 0.7, spin: (Math.random() - 0.5) * 22, fadeIn: 0.01,
      })
    }
  }
  /** Engine-bay smoke: grey wisps when damaged, thick black billows when heavily damaged. */
  engineSmoke(x: number, y: number, z: number, vx: number, vz: number, heavy: number): void {
    // Roughly one puff per frame at most; lighter damage emits only some frames.
    const n = heavy > 0.5 ? (Math.random() < 0.5 ? 2 : 1) : 1
    for (let k = 0; k < n; k += 1) {
      const c = heavy > 0.5 ? (Math.random() < 0.5 ? '#1f1c1a' : '#2e2a27') : (Math.random() < 0.5 ? '#6f6a66' : '#8d8782')
      this.alpha.spawn(x + (Math.random() - 0.5) * 0.7, y, z + (Math.random() - 0.5) * 0.7, vx * 0.98 + (Math.random() - 0.5) * 1.6, 2.2 + Math.random() * 2.4, vz * 0.98 + (Math.random() - 0.5) * 1.6, {
        cell: CELL.smoke, life: 1.4 + Math.random() * 1.1 + heavy * 0.9, size: 0.95 + Math.random() * 0.55 + heavy * 0.75, grow: 3.4 + heavy * 1.3, color: c, alpha: 0.48 + heavy * 0.27, gravity: -1.4, drag: 0.12, spin: (Math.random() - 0.5) * 1.4, fadeIn: 0.08,
      })
    }
  }
  /** Licking flames with embers. */
  fire(x: number, y: number, z: number, vx: number, vz: number, scale = 1): void {
    const n = Math.ceil(scale * 2)
    for (let k = 0; k < n; k += 1) {
      this.add.spawn(x + (Math.random() - 0.5) * 0.9 * scale, y + Math.random() * 0.3, z + (Math.random() - 0.5) * 0.9 * scale, vx + (Math.random() - 0.5), 2.5 + Math.random() * 3 * scale, vz + (Math.random() - 0.5), {
        cell: CELL.flame, life: 0.28 + Math.random() * 0.24, size: (0.95 + Math.random() * 0.7) * scale, grow: 0.6, color: Math.random() < 0.3 ? '#ffd27a' : '#ff7a2a', drag: 0.5, spin: (Math.random() - 0.5) * 4, fadeIn: 0.06,
      })
    }
    if (Math.random() < 0.35 * scale) this.add.spawn(x, y + 0.4, z, vx * 0.5 + (Math.random() - 0.5) * 3, 4 + Math.random() * 5, vz * 0.5 + (Math.random() - 0.5) * 3, { cell: CELL.spark, life: 0.6 + Math.random() * 0.5, size: 0.28, color: '#ffb347', gravity: 3, drag: 1, stretch: 2 })
    if (Math.random() < 0.5) this.add.spawn(x, y + 0.2, z, 0, 0.5, 0, { cell: CELL.glow, life: 0.16, size: 1.7 * scale, color: '#ff8a3a', fadeIn: 0.1 })
  }
  /** Full car destruction: double fireball, shockwave, debris and a smoke column. */
  wreckBlast(x: number, y: number, z: number, vx: number, vz: number): void {
    this.explosion(x, y, z)
    this.flash(x, y + 1.5, z, '#fff0c8', 22, 0.35)
    this.spray('add', x, y + 1.2, z, 34, 18, { cell: CELL.flame, life: 0.7, size: 3.2, grow: 2.2, color: '#ff7a2a', drag: 3, spin: 3 }, 0.45)
    this.spray('add', x, y + 1, z, 60, 30, { cell: CELL.spark, life: 0.9, size: 0.8, color: '#ffcf6b', gravity: 16, drag: 0.7, stretch: 4 }, 0.4)
    this.spray('alpha', x, y + 2, z, 26, 7, { cell: CELL.smoke, life: 2.6, size: 3.2, grow: 2.2, color: '#221f1d', alpha: 0.5, gravity: -2.2, drag: 1.2, spin: 0.6, fadeIn: 0.12 }, 0.7)
    this.debris(x, y + 1, z, 34, vx, vz)
    this.shock(x, y, z, '#ffb45a', 18, 0.8)
    this.rings.spawn(x, y + 0.2, z, 1, 26, 1.1, '#ffe2b8')
  }
  // ─── items ───────────────────────────────────────────────────────────

  /** Sync seeker / mine meshes and lock markers with the simulation. */
  syncItems(sim: RaceSim, time: number): void {
    const t = sim.track
    const alive = new Set<number>()
    const sp = this.seekerParts
    for (const p of sim.seekers) {
      alive.add(p.id)
      let g = this.seekerMeshes.get(p.id)
      if (!g) {
        g = new THREE.Group()
        const missile = new THREE.Group()
        const real = propMesh('seeker', 'length', false)
        if (real) {
          const mm = new THREE.Mesh(real.geometry, real.material)
          mm.scale.setScalar(2.4)
          missile.add(mm)
        } else {
          missile.add(new THREE.Mesh(sp.body, sp.bodyMat), new THREE.Mesh(sp.nose, sp.noseMat))
          const f1 = new THREE.Mesh(sp.fin, sp.finMat)
          const f2 = new THREE.Mesh(sp.fin, sp.finMat)
          f2.rotation.z = Math.PI / 2
          missile.add(f1, f2)
        }
        missile.traverse(o => { (o as THREE.Mesh).castShadow = true })
        g.add(missile)
        const glow = new THREE.Sprite(this.glowMat)
        glow.scale.setScalar(2.4)
        glow.position.z = -1
        g.add(glow)
        this.group.add(g)
        this.seekerMeshes.set(p.id, g)
      }
      t.frameAt(mod(p.odo, t.length), this.frame)
      const f = this.frame
      const prev = g.position.clone()
      g.position.set(f.x + f.rx * p.d, f.y + f.bank * p.d + 1.2 + Math.sin(time * 10) * 0.12, f.z + f.rz * p.d)
      g.rotation.set(0, Math.atan2(f.tx, f.tz), 0)
      g.children[0].rotation.z = time * 9
      // Flame + smoke trail.
      const bx = -f.tx, bz = -f.tz
      this.add.spawn(g.position.x + bx * 1.1, g.position.y, g.position.z + bz * 1.1, bx * 6, 0, bz * 6, { cell: CELL.flame, life: 0.12, size: 0.8, grow: 0.5, color: '#ff9a4a', drag: 4 })
      if (prev.distanceToSquared(g.position) < 400) this.alpha.spawn(g.position.x + bx * 1.3, g.position.y, g.position.z + bz * 1.3, (Math.random() - 0.5), 0.5, (Math.random() - 0.5), { cell: CELL.smoke, life: 1.1, size: 0.7, grow: 3.4, color: '#bdb3aa', alpha: 0.4, gravity: -0.4, drag: 1.2, spin: 1 })
    }
    for (const [id, g] of this.seekerMeshes) if (!alive.has(id)) { this.group.remove(g); this.seekerMeshes.delete(id) }
    // Lock markers: pulsing red ring + translucent warning beam where a locked seeker will strike.
    let li = 0
    for (const p of sim.seekers) {
      if (!p.locked) continue
      const tgt = sim.cars[p.target]
      if (!tgt) continue
      let m = this.lockMarkers[li]
      if (!m) {
        m = new THREE.Group()
        const ring = new THREE.Mesh(this.quad, this.lockRingMat)
        ring.renderOrder = 10
        const beam = new THREE.Mesh(this.beamGeo, this.beamMat)
        beam.position.y = 12
        m.add(ring, beam)
        this.lockMarkers.push(m)
        this.group.add(m)
      }
      t.frameAt(mod(tgt.loc.s + 6, t.length), this.frame)
      const f = this.frame
      m.visible = true
      m.position.set(f.x + f.rx * p.lockD, f.y + f.bank * p.lockD + 0.14, f.z + f.rz * p.lockD)
      const pulse = 1 + Math.sin(time * 14) * 0.12
      m.children[0].scale.setScalar(2.3 * pulse)
      this.lockRingMat.opacity = 0.75 + Math.sin(time * 14) * 0.25
      li += 1
    }
    for (let k = li; k < this.lockMarkers.length; k += 1) this.lockMarkers[k].visible = false
    const mines = new Set<number>()
    const mp = this.mineParts
    for (const m of sim.mines) {
      mines.add(m.id)
      let g = this.mineMeshes.get(m.id)
      if (!g) {
        g = new THREE.Group()
        const real = propMesh('mine', 'radius', false)
        if (real) {
          const body = new THREE.Mesh(real.geometry, real.material)
          body.scale.setScalar(1.15)
          body.position.y = 0.05
          body.castShadow = true
          g.add(body)
        } else {
          const body = new THREE.Mesh(mp.body, mp.metal)
          body.castShadow = true
          g.add(body)
          g.add(new THREE.Mesh(mp.cap, mp.dark))
        }
        for (let k = 0; k < (real ? 0 : 8); k += 1) {
          const s = new THREE.Mesh(mp.spike, mp.metal)
          const a = (k / 8) * Math.PI * 2
          s.position.set(Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95)
          s.rotation.set(0, 0, 0)
          s.lookAt(Math.cos(a) * 3, 0.4, Math.sin(a) * 3)
          s.rotateX(Math.PI / 2)
          g.add(s)
        }
        const glow = new THREE.Sprite(this.glowMat)
        glow.position.y = 0.5
        glow.scale.setScalar(1.8)
        g.add(glow)
        const ring = new THREE.Mesh(this.quad, this.mineRingMat)
        ring.scale.setScalar(2.8)
        ring.position.y = -0.18
        ring.renderOrder = 10
        g.add(ring)
        g.position.set(m.x, m.y + 0.3, m.z)
        g.userData.glow = glow
        g.userData.ring = ring
        this.group.add(g)
        this.mineMeshes.set(m.id, g)
      }
      const armed = m.arm <= 0
      const blink = Math.floor(time * (armed ? 4 : 10)) % 2 === 0
      ;(g.userData.glow as THREE.Sprite).visible = blink
      ;(g.userData.ring as THREE.Mesh).visible = armed
      if (armed) (g.userData.ring as THREE.Mesh).scale.setScalar(2.8 + Math.sin(time * 5) * 0.15)
      g.rotation.y = time * 0.8
    }
    for (const [id, g] of this.mineMeshes) if (!mines.has(id)) { this.group.remove(g); this.mineMeshes.delete(id) }
  }

  update(dt: number): void {
    this.add.update(dt)
    this.alpha.update(dt)
    this.rings.update(dt)
  }

  clear(): void {
    for (const g of this.seekerMeshes.values()) this.group.remove(g)
    for (const g of this.mineMeshes.values()) this.group.remove(g)
    this.seekerMeshes.clear()
    this.mineMeshes.clear()
    for (const r of this.lockMarkers) r.visible = false
    this.add.clear()
    this.alpha.clear()
    this.rings.clear()
  }
}
