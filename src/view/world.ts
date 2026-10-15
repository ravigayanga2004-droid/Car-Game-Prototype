import * as THREE from 'three'
import { assets } from '../engine/assets'
import { propMesh, whenProp } from './props'
import { HORIZON_HAZE, skyDome, surfaceMaterial } from './materials'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { clamp, fbm2, hash3, lerp, mod, noise2, rng, smoothstep } from '../sim/math'
import { powerCellPlacements } from '../sim/power'
import type { RaceSim } from '../sim/race'
import { newCorkFrame, SHOULDER, type Track } from '../sim/track'
import { bannerTexture, checkerTexture, chevronTexture, gateNumberTexture, gridTexture, padTexture, rampTexture, roadTexture } from './textures'

/**
 * Builds the visible canyon for a Track: road, shoulders, barriers, canyon walls / ridge skirts,
 * heightfield desert with mesas, a gorge + river under every bridge, gates, pads, ramps, item
 * crystals and props. Purely presentational: it reads Track data and never alters it.
 */
const RIBBON_X = [0, 0.8, 2.4, 4.8, 8.5, 13.5, 20, 29, 40, 54, 72]
const MAX_EXT = 72
export const SUN_DIR = new THREE.Vector3(-0.62, 0.5, 0.6).normalize()

const STRATA = ['#a8401f', '#c25a2a', '#d9773c', '#9a3a1c', '#e39a5c', '#8e3319', '#cc6a34', '#e8b27a'].map(c => new THREE.Color(c))
const SAND = new THREE.Color('#d9965a')
const SAND_DARK = new THREE.Color('#b87440')

interface Gorge { cx: number; cz: number; dx: number; dz: number; nx: number; nz: number; ext: number; floor: number }
interface Butte { x: number; z: number; r: number; h: number }

export class TrackWorld {
  readonly scene = new THREE.Scene()
  readonly sun: THREE.DirectionalLight
  private readonly track: Track
  private readonly gorges: Gorge[] = []
  private readonly buttes: Butte[] = []
  private readonly ext: Float64Array
  private readonly wallH: Float64Array
  private readonly nearestCache = { i: 0, side: 1, x: 0 }
  private readonly gateGroups: THREE.Group[] = []
  private readonly gateMat: THREE.MeshStandardMaterial
  private readonly gateHi: THREE.MeshStandardMaterial
  private readonly curtain: THREE.Mesh
  private readonly padTex: THREE.Texture
  private readonly boxes: THREE.Group[] = []
  private readonly powerCells: THREE.Group[] = []
  private readonly disposables: { dispose(): void }[] = []
  private highlighted = -1
  private disposed = false
  constructor(track: Track, shadowMapSize: number, shadows: boolean) {
    this.track = track
    const n = track.n
    this.ext = new Float64Array(n * 2)
    this.wallH = new Float64Array(n)
    for (let i = 0; i < n; i += 1) this.wallH[i] = 30 + 34 * (0.5 + 0.5 * noise2((i * track.ds) / 210, 3.7, track.spec.seed))

    this.scene.background = new THREE.Color(HORIZON_HAZE)
    this.scene.fog = new THREE.Fog(HORIZON_HAZE, 420, 2600)
    this.scene.add(skyDome(SUN_DIR))
    const hemi = new THREE.HemisphereLight('#b9cdea', '#8a4a26', 0.72)
    this.scene.add(hemi)
    this.sun = new THREE.DirectionalLight('#ffcf9a', 3.4)
    this.sun.position.copy(SUN_DIR).multiplyScalar(300)
    this.sun.castShadow = shadows
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize)
    const sc = this.sun.shadow.camera
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 700
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.6
    this.scene.add(this.sun, this.sun.target)

    this.findGorges()
    this.placeButtes()
    this.computeExtents()

    this.scene.add(this.road())
    this.scene.add(this.shoulders())
    this.scene.add(this.barriers())
    this.scene.add(this.ribbons())
    this.scene.add(this.terrain())
    this.scene.add(this.bridges())
    this.scene.add(this.rivers())

    this.gateMat = new THREE.MeshStandardMaterial({ color: '#34373e', roughness: 0.55, metalness: 0.35, envMapIntensity: 0.3 })
    this.gateHi = new THREE.MeshStandardMaterial({ color: '#8ff1f7', emissive: '#1fb8c6', emissiveIntensity: 0.6, roughness: 0.6 })
    this.scene.add(this.gates())
    const curtainMat = new THREE.MeshBasicMaterial({ color: '#7ef9ff', transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    this.curtain = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), curtainMat)
    this.curtain.renderOrder = 5
    this.scene.add(this.curtain)

    this.padTex = padTexture()
    this.scene.add(this.pads())
    this.scene.add(this.ramps())
    this.scene.add(this.corkscrews())
    this.scene.add(this.startLine())
    this.scene.add(this.itemBoxes())
    this.scene.add(this.powerCellObjects())
    this.scene.add(this.signs())
    this.scene.add(this.props())
    this.dressing()
    this.setHighlight(0)
  }

  // ─── public API ─────────────────────────────────────────────────────────

  /** Highlight the next gate for the player about to be rendered. */
  setHighlight(gate: number): void {
    if (gate === this.highlighted) return
    if (this.highlighted >= 0) for (const m of this.gateParts(this.highlighted)) m.material = this.gateMat
    this.highlighted = gate
    if (gate < 0) {
      this.curtain.visible = false
      return
    }
    for (const m of this.gateParts(gate)) m.material = this.gateHi
    const g = this.gateGroups[gate]
    this.curtain.visible = true
    this.curtain.position.copy(g.position).add(new THREE.Vector3(0, 4.2, 0))
    this.curtain.rotation.set(0, g.rotation.y, 0)
    this.curtain.scale.set(g.userData.width as number, 8.4, 1)
  }

  private gateParts(k: number): THREE.Mesh[] {
    return (this.gateGroups[k]?.userData.parts as THREE.Mesh[]) ?? []
  }

  /** Keep the shadow frustum around the focused car. */
  focus(x: number, y: number, z: number): void {
    this.sun.target.position.set(x, y, z)
    this.sun.position.set(x + SUN_DIR.x * 300, y + SUN_DIR.y * 300, z + SUN_DIR.z * 300)
    this.sun.target.updateMatrixWorld()
  }

  update(time: number, sim?: RaceSim): void {
    this.padTex.offset.y = -time * 1.6
    const pulse = 1 + Math.sin(time * 6) * 0.35
    this.gateHi.emissiveIntensity = 0.5 * pulse
    ;(this.curtain.material as THREE.MeshBasicMaterial).opacity = 0.09 + Math.sin(time * 4) * 0.04
    for (let k = 0; k < this.boxes.length; k += 1) {
      const g = this.boxes[k]
      const box = sim?.boxes[k]
      const hidden = sim ? (box ? box.respawn > 0 : true) : false
      const target = hidden ? 0.001 : 1
      const s = lerp(g.scale.x, target, 0.2)
      g.scale.setScalar(s)
      g.visible = s > 0.02
      g.rotation.y = time * 1.4 + k
      g.position.y = (g.userData.baseY as number) + Math.sin(time * 2.2 + k) * 0.25
    }
    for (let k = 0; k < this.powerCells.length; k += 1) {
      const g = this.powerCells[k]
      const cell = sim?.powerCells[k]
      const hidden = sim ? (cell ? cell.respawn > 0 : true) : false
      const target = hidden ? 0.001 : 1
      const s = lerp(g.scale.x, target, 0.2)
      g.scale.setScalar(s)
      g.visible = s > 0.02
      g.rotation.y = -time * 1.8 + k * 1.7
      g.rotation.z = Math.sin(time * 2.6 + k) * 0.12
      const ring = g.userData.ring as THREE.Mesh | undefined
      if (ring) ring.rotation.z = time * 2.4 + k
      g.position.y = (g.userData.baseY as number) + Math.sin(time * 3 + k) * 0.3
    }
    if (!sim) {
      for (const g of this.boxes) g.visible = true
      for (const g of this.powerCells) g.visible = true
    }
  }

  dispose(): void {
    this.disposed = true
    this.scene.traverse(obj => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach(m => m.dispose())
      else mat?.dispose()
    })
    for (const d of this.disposables) d.dispose()
  }

  // ─── height model ───────────────────────────────────────────────────────

  private natural(x: number, z: number): number {
    const seed = this.track.spec.seed
    let h = 2 + 6 * fbm2(x / 280, z / 280, 3, seed) + 1.4 * noise2(x / 45, z / 45, seed + 9)
    for (const b of this.buttes) {
      const d = Math.hypot(x - b.x, z - b.z)
      if (d > b.r + 40) continue
      const tier = smoothstep(b.r + 36, b.r + 4, d) * 0.35 + smoothstep(b.r + 6, b.r - 6, d) * 0.65
      const top = b.h + 3 * noise2(x / 30, z / 30, seed + 3)
      h = Math.max(h, lerp(h, top, tier))
    }
    for (const g of this.gorges) {
      const along = (x - g.cx) * g.dx + (z - g.cz) * g.dz
      const across = Math.abs((x - g.cx) * g.nx + (z - g.cz) * g.nz)
      const endFade = Math.max(0, Math.abs(along) - g.ext) * 0.5
      const floor = g.floor + Math.max(0, across - 24) * 1.45 + endFade + 2 * noise2(x / 20, z / 20, seed + 5)
      h = Math.min(h, floor)
    }
    return h
  }

  private edgeY(i: number, side: number): number {
    const t = this.track
    return t.y[i] + t.bank[i] * side * (t.halfW[i] + SHOULDER)
  }

  private canyonW(i: number): number {
    return this.track.canyon[i] * (1 - this.track.bridge[i])
  }

  /** Height of the side ribbon at sample i / side, at unscaled profile offset xp (0..72). */
  private ribbonHeight(i: number, side: number, xp: number, wx: number, wz: number, k = -1): number {
    const e = this.edgeY(i, side)
    const c = this.canyonW(i)
    const canyonRel = this.wallH[i] * (1 - Math.exp(-xp / 8.5))
    const natRel = lerp(-0.7, this.natural(wx, wz) - e, Math.pow(smoothstep(2, 54, xp), 0.85))
    const jitter = k > 0 ? (hash3(i, k, side, this.track.spec.seed) - 0.5) * 3.4 * Math.min(1, xp / 4) * c : 0
    return e + c * canyonRel + (1 - c) * natRel + jitter
  }

  private nearest(x: number, z: number): { i: number; side: number; x: number } {
    const t = this.track
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < t.n; i += 6) {
      const d = (x - t.x[i]) ** 2 + (z - t.z[i]) ** 2
      if (d < bestD) { bestD = d; best = i }
    }
    for (let k = -7; k <= 7; k += 1) {
      const i = mod(best + k, t.n)
      const d = (x - t.x[i]) ** 2 + (z - t.z[i]) ** 2
      if (d < bestD) { bestD = d; best = i }
    }
    const lat = (x - t.x[best]) * t.rx[best] + (z - t.z[best]) * t.rz[best]
    this.nearestCache.i = best
    this.nearestCache.side = lat >= 0 ? 1 : -1
    this.nearestCache.x = Math.sqrt(bestD) - t.barrierAt(best)
    return this.nearestCache
  }

  /** Terrain height (kept below the ribbon inside its extent). */
  private terrainAt(x: number, z: number): number {
    const t = this.track
    const { i, side, x: off } = this.nearest(x, z)
    const nat = this.natural(x, z)
    if (off < 0) {
      // Under the road: stay below the banked road plane at this lateral offset (steep banks put
      // the low edge far below the centreline).
      const lat = (x - t.x[i]) * t.rx[i] + (z - t.z[i]) * t.rz[i]
      const w = t.halfW[i] + SHOULDER
      return Math.min(nat, t.y[i] + t.bank[i] * clamp(lat, -w, w) - 3, t.y[i] - Math.abs(t.bank[i]) * w * 0.35 - 3)
    }
    const ext = this.ext[i * 2 + (side > 0 ? 1 : 0)]
    const c = this.canyonW(i)
    const plateau = this.edgeY(i, side) + this.wallH[i] + 3 * noise2(x / 40, z / 40, 11)
    const far = lerp(nat, plateau, c * (1 - smoothstep(ext + 40, ext + 190, off)))
    if (off <= ext) {
      const rib = this.ribbonHeight(i, side, (off / ext) * MAX_EXT, x, z)
      return Math.min(far, rib - 2.2)
    }
    return far
  }

  /** Visible ground height (ribbon surface inside its extent) for prop placement. */
  surfaceAt(x: number, z: number): number {
    const { i, side, x: off } = this.nearest(x, z)
    if (off < 0) return this.track.y[i]
    const ext = this.ext[i * 2 + (side > 0 ? 1 : 0)]
    if (off <= ext) return this.ribbonHeight(i, side, (off / ext) * MAX_EXT, x, z)
    return this.terrainAt(x, z)
  }

  private findGorges(): void {
    const t = this.track
    let i = 0
    // Walk contiguous bridge spans.
    const visited = new Uint8Array(t.n)
    for (i = 0; i < t.n; i += 1) {
      if (visited[i] || t.bridge[i] < 0.5) continue
      let a = i
      while (t.bridge[mod(a - 1, t.n)] >= 0.5 && a > i - t.n) a -= 1
      let b = i
      while (t.bridge[mod(b + 1, t.n)] >= 0.5 && b < i + t.n) b += 1
      for (let k = a; k <= b; k += 1) visited[mod(k, t.n)] = 1
      const c = mod(Math.round((a + b) / 2), t.n)
      const g: Gorge = { cx: t.x[c], cz: t.z[c], dx: t.rx[c], dz: t.rz[c], nx: t.tx[c], nz: t.tz[c], ext: 700, floor: Math.min(t.y[c] - 60, -20) }
      // Stop the gorge before it undercuts any other stretch of road.
      for (const dir of [1, -1]) {
        for (let dist = 40; dist < 900; dist += 20) {
          const px = g.cx + g.dx * dist * dir
          const pz = g.cz + g.dz * dist * dir
          let blocked = false
          for (let j = 0; j < t.n; j += 3) {
            const trackDist = Math.min(Math.abs(j - c), t.n - Math.abs(j - c)) * t.ds
            if (trackDist < 120) continue
            if ((px - t.x[j]) ** 2 + (pz - t.z[j]) ** 2 < 95 * 95) { blocked = true; break }
          }
          if (blocked) { g.ext = Math.min(g.ext, dist - 60); break }
        }
      }
      g.ext = Math.max(60, g.ext)
      this.gorges.push(g)
    }
  }

  private placeButtes(): void {
    const t = this.track
    const r = rng(t.spec.seed * 13 + 1)
    const b = t.bounds
    for (let k = 0; k < 90 && this.buttes.length < 16; k += 1) {
      const x = lerp(b.minX - 1000, b.maxX + 1000, r())
      const z = lerp(b.minZ - 1000, b.maxZ + 1000, r())
      const rad = 50 + r() * 120
      const h = 55 + r() * 95
      let ok = true
      for (let i = 0; i < t.n; i += 5) if ((x - t.x[i]) ** 2 + (z - t.z[i]) ** 2 < (rad + 190) ** 2) { ok = false; break }
      for (const o of this.buttes) if (Math.hypot(o.x - x, o.z - z) < o.r + rad + 60) ok = false
      if (ok) this.buttes.push({ x, z, r: rad, h })
    }
  }

  private computeExtents(): void {
    const t = this.track
    const n = t.n
    for (let i = 0; i < n; i += 1) {
      for (const side of [-1, 1]) {
        const dirx = t.rx[i] * side
        const dirz = t.rz[i] * side
        let clear = 400
        for (let j = 0; j < n; j += 2) {
          const trackDist = Math.min(Math.abs(j - i), n - Math.abs(j - i)) * t.ds
          if (trackDist < 70) continue
          const px = t.x[j] - t.x[i]
          const pz = t.z[j] - t.z[i]
          const along = px * dirx + pz * dirz
          if (along <= 0) continue
          const perp = Math.abs(px * -dirz + pz * dirx)
          if (perp > along * 1.1 + 20) continue
          clear = Math.min(clear, Math.hypot(px, pz) - t.halfW[j] - SHOULDER - 6)
        }
        const ext = clamp((clear - t.barrierAt(i)) * 0.5, 6, MAX_EXT)
        this.ext[i * 2 + (side > 0 ? 1 : 0)] = ext
      }
    }
    // Smooth extents along the track to avoid jagged wall tops.
    const tmp = new Float64Array(this.ext.length)
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = 0; i < n; i += 1) for (let s = 0; s < 2; s += 1) {
        let m = Infinity
        for (let k = -4; k <= 4; k += 1) m = Math.min(m, this.ext[mod(i + k, n) * 2 + s])
        tmp[i * 2 + s] = m
      }
      this.ext.set(tmp)
    }
  }

  // ─── meshes ─────────────────────────────────────────────────────────────

  private road(): THREE.Mesh {
    const t = this.track
    const n = t.n
    const pos = new Float32Array((n + 1) * 2 * 3)
    const uv = new Float32Array((n + 1) * 2 * 2)
    for (let r = 0; r <= n; r += 1) {
      const i = r % n
      const inCork = this.inCorkZone(i * t.ds)
      for (let k = 0; k < 2; k += 1) {
        const side = k === 0 ? -1 : 1
        // Steep banks pave their shoulders (concrete apron up to the rim).
        const d = inCork ? 0 : side * t.pavedW(i)
        const o = (r * 2 + k) * 3
        pos[o] = t.x[i] + t.rx[i] * d
        pos[o + 1] = t.y[i] + t.bank[i] * d + (inCork ? -0.4 : 0.03)
        pos[o + 2] = t.z[i] + t.rz[i] * d
        uv[(r * 2 + k) * 2] = k
        uv[(r * 2 + k) * 2 + 1] = (r * t.ds) / 12
      }
    }
    const geo = stripGeometry(pos, uv, n, 2)
    const tex = roadTexture()
    this.disposables.push(tex)
    const mat = surfaceMaterial({ set: 'asphalt', planar: true, scale: 1 / 5.5, overlay: tex, roughness: 1, normalScale: 0.9, bright: 1.75, color: '#d8d2cc', envIntensity: 0.12 })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = true
    return mesh
  }

  private shoulders(): THREE.Group {
    const t = this.track
    const n = t.n
    const group = new THREE.Group()
    const mat = surfaceMaterial({ set: 'sand', planar: true, scale: 1 / 7, roughness: 1, normalScale: 1.1, color: '#f3dcc0' })
    for (const side of [-1, 1]) {
      const pos = new Float32Array((n + 1) * 2 * 3)
      const uv = new Float32Array((n + 1) * 2 * 2)
      for (let r = 0; r <= n; r += 1) {
        const i = r % n
        for (let k = 0; k < 2; k += 1) {
          const d = side * (k === 0 ? t.pavedW(i) - 0.05 : Math.max(t.pavedW(i), t.barrierAt(i) + 0.2))
          const o = (r * 2 + k) * 3
          pos[o] = t.x[i] + t.rx[i] * d
          pos[o + 1] = t.y[i] + t.bank[i] * clamp(d, -t.halfW[i] - SHOULDER, t.halfW[i] + SHOULDER) + 0.015
          pos[o + 2] = t.z[i] + t.rz[i] * d
          uv[(r * 2 + k) * 2] = pos[o] / 6
          uv[(r * 2 + k) * 2 + 1] = pos[o + 2] / 6
        }
      }
      const geo = stripGeometry(pos, uv, n, 2, side > 0)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.receiveShadow = true
      group.add(mesh)
    }
    return group
  }

  private barriers(): THREE.Group {
    const t = this.track
    const n = t.n
    const group = new THREE.Group()
    const stone = surfaceMaterial({ set: 'sandstone', scale: 1 / 2.6, roughness: 1, normalScale: 1.2, side: THREE.DoubleSide, color: '#e6c9b4' })
    const rail = new THREE.MeshStandardMaterial({ color: '#a3a8ae', roughness: 0.5, metalness: 0.45, side: THREE.DoubleSide, envMapIntensity: 0.3 })
    const post = new THREE.MeshStandardMaterial({ color: '#4a4448', roughness: 0.8, metalness: 0.1 })
    const stoneQuads: number[] = []
    const railQuads: number[] = []
    const posts: THREE.Matrix4[] = []
    const m = new THREE.Matrix4()
    for (const side of [-1, 1]) {
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n
        const wall = t.isWall(i)
        const hgt = wall ? 1.5 : 1.05
        const quad = (a: number, b: number, offA: number, offB: number, y0: number, y1: number) => {
          const ax = t.x[a] + t.rx[a] * side * offA, az = t.z[a] + t.rz[a] * side * offA
          const bx = t.x[b] + t.rx[b] * side * offB, bz = t.z[b] + t.rz[b] * side * offB
          const ay = this.edgeY(a, side), by = this.edgeY(b, side)
          const arr = wall ? stoneQuads : railQuads
          arr.push(ax, ay + y0, az, bx, by + y0, bz, bx, by + y1, bz, ax, ay + y1, az)
        }
        const offA = t.barrierAt(i) + 0.15
        const offB = t.barrierAt(j) + 0.15
        if (wall) {
          quad(i, j, offA, offB, -0.4, hgt)
          // Wall cap.
          const ax = t.x[i] + t.rx[i] * side * offA, az = t.z[i] + t.rz[i] * side * offA
          const bx = t.x[j] + t.rx[j] * side * offB, bz = t.z[j] + t.rz[j] * side * offB
          const cx = t.x[i] + t.rx[i] * side * (offA + 0.9), cz = t.z[i] + t.rz[i] * side * (offA + 0.9)
          const dx = t.x[j] + t.rx[j] * side * (offB + 0.9), dz = t.z[j] + t.rz[j] * side * (offB + 0.9)
          const ay = this.edgeY(i, side) + hgt, by = this.edgeY(j, side) + hgt
          stoneQuads.push(ax, ay, az, bx, by, bz, dx, by, dz, cx, ay, cz)
        } else {
          quad(i, j, offA, offB, 0.55, 0.95)
          if (i % 2 === 0) {
            m.makeTranslation(t.x[i] + t.rx[i] * side * (offA + 0.12), this.edgeY(i, side) + 0.45, t.z[i] + t.rz[i] * side * (offA + 0.12))
            posts.push(m.clone())
          }
        }
      }
    }
    group.add(quadMesh(stoneQuads, stone, true))
    group.add(quadMesh(railQuads, rail, false))
    const postGeo = new THREE.BoxGeometry(0.18, 1.0, 0.18)
    const inst = new THREE.InstancedMesh(postGeo, post, posts.length)
    posts.forEach((p, k) => inst.setMatrixAt(k, p))
    group.add(inst)
    return group
  }

  private ribbons(): THREE.Mesh {
    const t = this.track
    const n = t.n
    const rows = RIBBON_X.length
    const positions: number[] = []
    const colors: number[] = []
    const indices: number[] = []
    const col = new THREE.Color()
    for (const side of [-1, 1]) {
      const base = positions.length / 3
      for (let i = 0; i < n; i += 1) {
        const ext = this.ext[i * 2 + (side > 0 ? 1 : 0)]
        const c = this.canyonW(i)
        for (let k = 0; k < rows; k += 1) {
          const xp = RIBBON_X[k]
          const off = t.barrierAt(i) + 0.15 + (xp / MAX_EXT) * ext
          const lateral = k > 1 ? (hash3(i, k, side + 7, t.spec.seed) - 0.5) * 1.6 * c : 0
          const wx = t.x[i] + t.rx[i] * side * (off + lateral)
          const wz = t.z[i] + t.rz[i] * side * (off + lateral)
          const y = k === 0 ? this.edgeY(i, side) - 0.4 : this.ribbonHeight(i, side, xp, wx, wz, k)
          positions.push(wx, y, wz)
          const band = STRATA[mod(Math.floor((y + noise2(i * 0.05, k, 2) * 3) / 5.5), STRATA.length)]
          const sandy = (1 - c) * (1 - smoothstep(0, 1, k / 3) * 0.4)
          col.copy(band).lerp(k < 2 ? SAND_DARK : SAND, sandy)
          const shade = 0.88 + hash3(i, k, side, 5) * 0.2
          colors.push(col.r * shade, col.g * shade, col.b * shade)
        }
      }
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n
        if (t.bridge[i] > 0.5 || t.bridge[j] > 0.5) continue
        for (let k = 0; k < rows - 1; k += 1) {
          const a = base + i * rows + k
          const b = base + j * rows + k
          const c2 = base + j * rows + k + 1
          const d = base + i * rows + k + 1
          if (side > 0) indices.push(a, d, b, b, d, c2)
          else indices.push(a, b, d, b, c2, d)
        }
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geo.setIndex(indices)
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, surfaceMaterial({ set: 'cliff', scale: 1 / 13, tint: 1, gray: 0.85, streaks: 1, top: 'sand', topAmount: 0.75, vertexColors: true, roughness: 1, normalScale: 1.5, side: THREE.DoubleSide }))
    mesh.receiveShadow = true
    mesh.castShadow = true
    return mesh
  }

  private terrain(): THREE.Mesh {
    const b = this.track.bounds
    const pad = 1250
    const minX = b.minX - pad, maxX = b.maxX + pad, minZ = b.minZ - pad, maxZ = b.maxZ + pad
    const res = 210
    const geo = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, res, res)
    geo.rotateX(-Math.PI / 2)
    geo.translate((minX + maxX) / 2, 0, (minZ + maxZ) / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(pos.count * 3)
    const col = new THREE.Color()
    for (let v = 0; v < pos.count; v += 1) {
      const x = pos.getX(v)
      const z = pos.getZ(v)
      const jx = x + (hash3(v, 1, 2) - 0.5) * 5
      const jz = z + (hash3(v, 3, 4) - 0.5) * 5
      const h = this.terrainAt(jx, jz)
      pos.setXYZ(v, jx, h, jz)
      if (h > 14) col.copy(STRATA[mod(Math.floor((h + noise2(x / 60, z / 60, 4) * 4) / 7), STRATA.length)])
      else col.copy(SAND).lerp(SAND_DARK, 0.5 + 0.5 * noise2(x / 90, z / 90, 8))
      if (h < -8) col.lerp(new THREE.Color('#8a4a2e'), 0.6)
      const shade = 0.9 + hash3(v, 7, 7) * 0.16
      colors[v * 3] = col.r * shade
      colors[v * 3 + 1] = col.g * shade
      colors[v * 3 + 2] = col.b * shade
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, surfaceMaterial({ set: 'cliff', scale: 1 / 16, tint: 1, gray: 0.8, streaks: 0.7, top: 'sand', topAmount: 1, vertexColors: true, roughness: 1, normalScale: 1.2 }))
    mesh.receiveShadow = true
    return mesh
  }

  private bridges(): THREE.Group {
    const t = this.track
    const n = t.n
    const group = new THREE.Group()
    const girderQuads: number[] = []
    const pillars: THREE.Matrix4[] = []
    const cables: number[] = []
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n
      if (t.bridge[i] < 0.3 && t.bridge[j] < 0.3) continue
      const w = t.barrierAt(i) + 0.3
      const w2 = t.barrierAt(j) + 0.3
      const pt = (k: number, d: number, dy: number) => [t.x[k] + t.rx[k] * d, t.y[k] + t.bank[k] * d + dy, t.z[k] + t.rz[k] * d]
      // Deck underside box girder: two sides + bottom.
      for (const side of [-1, 1]) {
        const a = pt(i, side * w, 0), b = pt(j, side * w2, 0), c = pt(j, side * w2 * 0.7, -3.2), d = pt(i, side * w * 0.7, -3.2)
        girderQuads.push(...a, ...b, ...c, ...d)
      }
      const a = pt(i, -w * 0.7, -3.2), b = pt(j, -w2 * 0.7, -3.2), c = pt(j, w2 * 0.7, -3.2), d = pt(i, w * 0.7, -3.2)
      girderQuads.push(...a, ...b, ...c, ...d)
      if (i % 18 === 0 && t.bridge[i] > 0.6) {
        for (const side of [-0.45, 0.45]) {
          const [px, py, pz] = pt(i, side * w, -3)
          const ground = this.natural(px, pz)
          const height = Math.max(2, py - ground + 2)
          m.compose(new THREE.Vector3(px, py - height / 2, pz), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.heading[i]), new THREE.Vector3(1, height, 1))
          pillars.push(m.clone())
        }
      }
      // Suspension-style arches of cable along each side.
      if (t.bridge[i] > 0.5 && i % 3 === 0) {
        for (const side of [-1, 1]) {
          const [x0, y0, z0] = pt(i, side * (w - 0.1), 1)
          cables.push(x0, y0, z0, x0, y0 + 5 + 3 * Math.sin((i * t.ds) / 40), z0)
        }
      }
    }
    group.add(quadMesh(girderQuads, new THREE.MeshStandardMaterial({ color: '#6b605c', roughness: 0.85, metalness: 0.1, side: THREE.DoubleSide, envMapIntensity: 0.25 }), true))
    if (pillars.length) {
      const geo = new THREE.BoxGeometry(2.4, 1, 3.2)
      const inst = new THREE.InstancedMesh(geo, surfaceMaterial({ set: 'sandstone', scale: 1 / 3, roughness: 1, color: '#d8c2b2' }), pillars.length)
      pillars.forEach((p, k) => inst.setMatrixAt(k, p))
      inst.castShadow = true
      group.add(inst)
    }
    if (cables.length) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(cables, 3))
      group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#cfc6ba' })))
    }
    return group
  }

  private rivers(): THREE.Group {
    const group = new THREE.Group()
    const mat = new THREE.MeshStandardMaterial({ color: '#3f7f86', roughness: 0.22, metalness: 0, envMapIntensity: 0.55 })
    for (const g of this.gorges) {
      const len = g.ext * 2 + 120
      const geo = new THREE.PlaneGeometry(38, len)
      geo.rotateX(-Math.PI / 2)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(g.cx, g.floor + 2.4, g.cz)
      mesh.rotation.y = Math.atan2(g.dx, g.dz)
      group.add(mesh)
    }
    return group
  }

  private gates(): THREE.Group {
    const t = this.track
    const group = new THREE.Group()
    for (const gate of t.gates) {
      const i = gate.sample
      const w = t.barrierAt(i) + 0.8
      const g = new THREE.Group()
      g.position.set(t.x[i], t.y[i], t.z[i])
      g.rotation.y = t.heading[i]
      const finish = gate.index === t.gates.length - 1
      const pylonGeo = new THREE.BoxGeometry(1.1, 9.4, 1.1)
      const parts: THREE.Mesh[] = []
      for (const side of [-1, 1]) {
        const p = new THREE.Mesh(pylonGeo, this.gateMat)
        p.position.set(side * w, 4.7 + t.bank[i] * side * w * -1, 0)
        p.castShadow = true
        g.add(p)
        parts.push(p)
      }
      const tex = finish ? bannerTexture('FINISH', '#111', '#fff') : gateNumberTexture(gate.index + 1)
      this.disposables.push(tex)
      const faceMat = new THREE.MeshBasicMaterial({ map: tex })
      const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + 1.1, 1.7, 0.7), [this.gateMat, this.gateMat, this.gateMat, this.gateMat, faceMat, faceMat])
      beam.position.set(0, 8.9, 0)
      beam.castShadow = true
      g.add(beam)
      parts.push(beam)
      if (finish) {
        const chk = checkerTexture()
        chk.repeat.set(4, 1)
        this.disposables.push(chk)
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(w * 2, 1.2), new THREE.MeshBasicMaterial({ map: chk, side: THREE.DoubleSide }))
        flag.position.set(0, 7.5, 0)
        g.add(flag)
      }
      g.userData.parts = parts
      g.userData.width = w * 2
      this.gateGroups.push(g)
      group.add(g)
    }
    return group
  }

  private pads(): THREE.Group {
    const t = this.track
    const group = new THREE.Group()
    const mat = new THREE.MeshBasicMaterial({ map: this.padTex, toneMapped: false })
    this.padTex.repeat.set(1, 1.5)
    const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
    for (const pad of t.pads) {
      const seg = 6
      const pos = new Float32Array((seg + 1) * 2 * 3)
      const uv = new Float32Array((seg + 1) * 2 * 2)
      const ck = pad.cork >= 0 ? t.corks[pad.cork] : null
      for (let r = 0; r <= seg; r += 1) {
        const s = pad.s - pad.len / 2 + (r / seg) * pad.len
        t.frameAt(s, f)
        for (let k = 0; k < 2; k += 1) {
          const d = pad.d + (k === 0 ? -pad.halfW : pad.halfW)
          const o = (r * 2 + k) * 3
          if (ck) {
            t.corkPoint(ck, s, d, 0.1, this.cp)
            pos[o] = this.cp.x
            pos[o + 1] = this.cp.y
            pos[o + 2] = this.cp.z
          } else {
          pos[o] = f.x + f.rx * d
          pos[o + 1] = f.y + f.bank * d + 0.07
          pos[o + 2] = f.z + f.rz * d
          }
          uv[(r * 2 + k) * 2] = k
          uv[(r * 2 + k) * 2 + 1] = r / seg
        }
      }
      if (ck) {
        const geo = gridGeometry(pos, uv, seg, 2)
        const m = new THREE.Mesh(geo, this.padRibbonMat ??= Object.assign(mat.clone(), { side: THREE.DoubleSide }))
        group.add(m)
      } else group.add(new THREE.Mesh(stripGeometry(pos, uv, seg, 2, false, false), mat))
    }
    return group
  }

  private readonly cp = { x: 0, y: 0, z: 0 }
  private padRibbonMat: THREE.MeshBasicMaterial | undefined

  private inCorkZone(s: number): boolean {
    const t = this.track
    for (const c of t.corks) {
      const rel = mod(s - c.s0, t.length)
      if (rel > 0.4 && rel < c.len - 0.4) return true
    }
    return false
  }

  /** Boost-fed corkscrews: a rolled asphalt ribbon with rails, steel gantries and radial struts. */
  private corkscrews(): THREE.Group {
    const t = this.track
    const group = new THREE.Group()
    if (!t.corks.length) return group
    const tex = roadTexture()
    this.disposables.push(tex)
    const deckMat = surfaceMaterial({ set: 'asphalt', scale: 1 / 5.5, overlay: tex, roughness: 1, normalScale: 0.9, bright: 1.75, color: '#d8d2cc', envIntensity: 0.12, side: THREE.DoubleSide })
    const underMat = new THREE.MeshStandardMaterial({ color: '#3a3d42', roughness: 0.62, metalness: 0.35, envMapIntensity: 0.3, side: THREE.DoubleSide })
    const railMat = new THREE.MeshStandardMaterial({ color: '#c8552a', roughness: 0.5, metalness: 0.15, envMapIntensity: 0.3, side: THREE.DoubleSide })
    const lipMat = new THREE.MeshStandardMaterial({ color: '#ffd9a0', emissive: '#ff9d3c', emissiveIntensity: 0.35, roughness: 0.5, metalness: 0, side: THREE.DoubleSide })
    const steelMat = new THREE.MeshStandardMaterial({ color: '#4a4f57', roughness: 0.55, metalness: 0.4, envMapIntensity: 0.3 })
    this.disposables.push(deckMat, underMat, railMat, lipMat, steelMat)
    const beams: THREE.Matrix4[] = []
    const struts: THREE.Matrix4[] = []
    const up = new THREE.Vector3(0, 1, 0)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const beam = (a: THREE.Vector3, b: THREE.Vector3, w: number, into: THREE.Matrix4[]) => {
      const dir = new THREE.Vector3().subVectors(b, a)
      const len = dir.length()
      if (len < 0.05) return
      q.setFromUnitVectors(up, dir.divideScalar(len))
      into.push(m.compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(w, len, w)).clone())
    }
    for (const ck of t.corks) {
      const rows = Math.ceil(ck.len / 0.8)
      const sAt = (r: number) => ck.s0 + (r / rows) * ck.len
      const strip = (cols: [number, number][], mat: THREE.Material, uvAcross = false) => {
        const pos = new Float32Array((rows + 1) * cols.length * 3)
        const uv = new Float32Array((rows + 1) * cols.length * 2)
        for (let r = 0; r <= rows; r += 1) {
          const sv = sAt(r)
          const hw = t.corkHalfW(ck, sv)
          cols.forEach(([dk, h], c) => {
            t.corkPoint(ck, sv, dk * hw + (Math.abs(dk) > 1 ? Math.sign(dk) * (Math.abs(dk) - 1) : 0), h, this.cp)
            const o = (r * cols.length + c) * 3
            pos[o] = this.cp.x; pos[o + 1] = this.cp.y; pos[o + 2] = this.cp.z
            uv[(r * cols.length + c) * 2] = uvAcross ? (dk + 1) / 2 : c / (cols.length - 1)
            uv[(r * cols.length + c) * 2 + 1] = ((sv - ck.s0) * 1.12) / 12
          })
        }
        const mesh = new THREE.Mesh(gridGeometry(pos, uv, rows, cols.length), mat)
        mesh.castShadow = true
        mesh.receiveShadow = true
        group.add(mesh)
      }
      // Deck (paint overlay spans the full width), underside, side skirts, rails and lit lips.
      strip([[-1, 0.05], [-0.5, 0.05], [0, 0.05], [0.5, 0.05], [1, 0.05]], deckMat, true)
      strip([[-1, -0.6], [0, -0.75], [1, -0.6]], underMat)
      for (const sd of [-1, 1]) {
        strip([[sd, -0.6], [sd, 0.05]], underMat)
        strip([[sd * 1.02, 0.02], [sd * 1.02, 1.0]], railMat)
        strip([[sd * 0.975, 0.07], [sd * 0.93, 0.07]], lipMat)
      }
      // Steel gantry frames every ~18 m with radial struts to the ribbon's back.
      const env = Math.hypot(ck.radius, ck.hw + 1.2) + 1.6
      const frames = Math.max(3, Math.round(ck.len / 18))
      const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: 1, rz: 0, halfW: 0, bank: 0 }
      for (let g = 0; g <= frames; g += 1) {
        const sv = ck.s0 + 3 + (g / frames) * (ck.len - 6)
        t.frameAt(sv, f)
        const ground = Math.min(f.y - 0.6, this.natural(f.x, f.z) + 0.2)
        const axisY = f.y + ck.radius
        const topY = axisY + env
        const legs = [-1, 1].map(sd => new THREE.Vector3(f.x + f.rx * sd * env, 0, f.z + f.rz * sd * env))
        for (const L of legs) beam(new THREE.Vector3(L.x, ground, L.z), new THREE.Vector3(L.x, topY + 0.4, L.z), 0.8, beams)
        beam(new THREE.Vector3(legs[0].x, topY, legs[0].z), new THREE.Vector3(legs[1].x, topY, legs[1].z), 0.7, beams)
        // Radial strut from the ribbon's back out to the frame square.
        const rel = sv - ck.s0
        if (rel > 4 && rel < ck.len - 4) {
          const cf = t.corkFrame(ck, sv, 0, this.cf)
          const P = new THREE.Vector3(cf.x - cf.nx * 0.7, cf.y - cf.ny * 0.7, cf.z - cf.nz * 0.7)
          const D = new THREE.Vector3(-cf.nx, -cf.ny, -cf.nz)
          const lat = (v: THREE.Vector3) => (v.x - f.x) * f.rx + (v.z - f.z) * f.rz
          const dl = D.x * f.rx + D.z * f.rz
          let tt = Infinity
          if (Math.abs(dl) > 1e-3) { const want = (dl > 0 ? env : -env) - lat(P); if (want / dl > 0) tt = Math.min(tt, want / dl) }
          if (D.y > 1e-3) tt = Math.min(tt, (topY - P.y) / D.y)
          if (D.y < -1e-3) tt = Math.min(tt, (ground - P.y) / D.y)
          if (Number.isFinite(tt) && tt > 0.3) beam(P, P.clone().addScaledVector(D, tt), 0.45, struts)
        }
      }
      // Entry arch with the CORKSCREW banner facing the run-in.
      t.frameAt(ck.s0 - 5, f)
      const archW = Math.min(t.barrierAt(t.sampleIndex(ck.s0 - 5)) + 0.4, env)
      const archTop = f.y + 9.5
      for (const sd of [-1, 1]) beam(new THREE.Vector3(f.x + f.rx * sd * archW, f.y - 0.5, f.z + f.rz * sd * archW), new THREE.Vector3(f.x + f.rx * sd * archW, archTop + 1, f.z + f.rz * sd * archW), 0.9, beams)
      const btex = bannerTexture('CORKSCREW  ·  KEEP SPEED', '#1b1030', '#ffd23f')
      this.disposables.push(btex)
      const bmat = new THREE.MeshBasicMaterial({ map: btex, side: THREE.DoubleSide })
      this.disposables.push(bmat)
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(archW * 2, 2.2), bmat)
      banner.position.set(f.x, archTop, f.z)
      banner.rotation.y = Math.atan2(f.tx, f.tz) + Math.PI
      group.add(banner)
      this.corkBanners.push(banner)
    }
    const beamGeo = new THREE.BoxGeometry(1, 1, 1)
    const strutGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 8)
    this.disposables.push(beamGeo, strutGeo)
    for (const [list, geo] of [[beams, beamGeo], [struts, strutGeo]] as const) {
      if (!list.length) continue
      const inst = new THREE.InstancedMesh(geo, steelMat, list.length)
      list.forEach((mm, k) => inst.setMatrixAt(k, mm))
      inst.castShadow = true
      inst.receiveShadow = true
      group.add(inst)
    }
    return group
  }
  private readonly cf = newCorkFrame()
  private readonly corkBanners: THREE.Mesh[] = []

  private ramps(): THREE.Group {
    const t = this.track
    const group = new THREE.Group()
    const tex = rampTexture()
    tex.repeat.set(3, 1)
    this.disposables.push(tex)
    const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 })
    const sideMat = new THREE.MeshStandardMaterial({ color: '#3b2f45', roughness: 0.8, side: THREE.DoubleSide })
    const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
    for (const ramp of t.ramps) {
      const seg = 8
      const pos = new Float32Array((seg + 1) * 2 * 3)
      const uv = new Float32Array((seg + 1) * 2 * 2)
      const sides: number[] = []
      let lip: number[] = []
      for (let r = 0; r <= seg; r += 1) {
        const s = ramp.s0 + (r / seg) * ramp.len
        t.frameAt(s, f)
        const h = (ramp.height * r) / seg
        for (let k = 0; k < 2; k += 1) {
          const d = (k === 0 ? -1 : 1) * (f.halfW + 0.5)
          const o = (r * 2 + k) * 3
          pos[o] = f.x + f.rx * d
          pos[o + 1] = f.y + f.bank * d + h + 0.04
          pos[o + 2] = f.z + f.rz * d
          uv[(r * 2 + k) * 2] = k
          uv[(r * 2 + k) * 2 + 1] = r / seg
        }
        if (r < seg) {
          const s2 = ramp.s0 + ((r + 1) / seg) * ramp.len
          const f2 = { ...f }
          t.frameAt(s2, f2)
          const h2 = (ramp.height * (r + 1)) / seg
          for (const side of [-1, 1]) {
            const d1 = side * (f.halfW + 0.5)
            const d2 = side * (f2.halfW + 0.5)
            const ax = f.x + f.rx * d1, az = f.z + f.rz * d1, ay = f.y + f.bank * d1
            const bx = f2.x + f2.rx * d2, bz = f2.z + f2.rz * d2, by = f2.y + f2.bank * d2
            sides.push(ax, ay, az, bx, by, bz, bx, by + h2, bz, ax, ay + h, az)
          }
        } else {
          const l = f.x + f.rx * -(f.halfW + 0.5), lz = f.z + f.rz * -(f.halfW + 0.5)
          const rr = f.x + f.rx * (f.halfW + 0.5), rz = f.z + f.rz * (f.halfW + 0.5)
          lip = [l, f.y - f.bank * (f.halfW + 0.5), lz, rr, f.y + f.bank * (f.halfW + 0.5), rz, rr, f.y + f.bank * (f.halfW + 0.5) + h, rz, l, f.y - f.bank * (f.halfW + 0.5) + h, lz]
        }
      }
      const mesh = new THREE.Mesh(stripGeometry(pos, uv, seg, 2, false, false), top)
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
      group.add(quadMesh([...sides, ...lip], sideMat, false))
      if (ramp.mega) group.add(this.megaDressing(ramp.s0, ramp.len, ramp.height))
    }
    return group
  }

  /** Mega ramp dressing: side rails with hazard stripes, a steel back frame and approach pylons. */
  private megaDressing(s0: number, len: number, height: number): THREE.Group {
    const t = this.track
    const g = new THREE.Group()
    const steel = new THREE.MeshStandardMaterial({ color: '#3a3d44', roughness: 0.55, metalness: 0.5 })
    const hazard = new THREE.MeshStandardMaterial({ color: '#f08a1c', roughness: 0.6, emissive: '#5a2200', emissiveIntensity: 0.25 })
    const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
    const box = new THREE.BoxGeometry(1, 1, 1)
    const put = (mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, pitch = 0) => {
      const m = new THREE.Mesh(box, mat)
      m.position.set(x, y, z)
      m.rotation.set(pitch, yaw, 0, 'YXZ')
      m.scale.set(sx, sy, sz)
      m.castShadow = true
      g.add(m)
    }
    const seg = 6
    for (let r = 0; r < seg; r += 1) {
      const sa = s0 + (r / seg) * len
      const sb = s0 + ((r + 1) / seg) * len
      t.frameAt((sa + sb) / 2, f)
      const h = (height * (r + 0.5)) / seg
      const pitch = -Math.atan2(height, len)
      const yaw = Math.atan2(f.tx, f.tz)
      for (const side of [-1, 1]) {
        const d = side * (f.halfW + 0.7)
        put(r % 2 ? steel : hazard, f.x + f.rx * d, f.y + f.bank * d + h + 0.55, f.z + f.rz * d, 0.45, 0.7, (sb - sa) * 1.02, yaw, pitch)
      }
    }
    // Back frame under the lip: posts and cross braces.
    t.frameAt(s0 + len, f)
    const yaw = Math.atan2(f.tx, f.tz)
    for (let k = -2; k <= 2; k += 1) {
      const d = (k / 2) * f.halfW
      put(steel, f.x + f.rx * d + f.tx * 0.8, f.y + height / 2, f.z + f.rz * d + f.tz * 0.8, 0.6, height, 0.6, yaw)
    }
    for (let k = 1; k <= 3; k += 1) put(steel, f.x + f.tx * 0.8, f.y + (height * k) / 4, f.z + f.tz * 0.8, f.halfW * 2, 0.35, 0.35, yaw)
    // Approach pylons with hazard bands.
    t.frameAt(s0 - 6, f)
    for (const side of [-1, 1]) {
      const d = side * (f.halfW + 2.2)
      const x = f.x + f.rx * d, z = f.z + f.rz * d
      put(steel, x, f.y + 4, z, 0.8, 8, 0.8, yaw)
      for (let b = 0; b < 3; b += 1) put(hazard, x, f.y + 5.2 + b * 1.1, z, 0.95, 0.45, 0.95, yaw)
    }
    return g
  }

  private startLine(): THREE.Group {
    const t = this.track
    const group = new THREE.Group()
    const chk = checkerTexture()
    chk.repeat.set(3, 1)
    this.disposables.push(chk)
    const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
    t.frameAt(0, f)
    const line = new THREE.Mesh(new THREE.PlaneGeometry(f.halfW * 2, 2.4), new THREE.MeshStandardMaterial({ map: chk, roughness: 0.8 }))
    line.rotation.set(-Math.PI / 2, 0, 0)
    const holder = new THREE.Group()
    holder.position.set(f.x, f.y + 0.06, f.z)
    holder.rotation.y = Math.atan2(f.tx, f.tz)
    holder.add(line)
    group.add(holder)
    const grid = gridTexture()
    this.disposables.push(grid)
    const slotMat = new THREE.MeshBasicMaterial({ map: grid, transparent: true, depthWrite: false })
    for (const lane of [-5, 0, 5]) {
      t.frameAt(t.length - 14, f)
      const slot = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 5.4), slotMat)
      slot.rotation.set(-Math.PI / 2, 0, Math.atan2(f.tx, f.tz))
      slot.position.set(f.x + f.rx * lane * clamp(t.halfW[0] / 10, 0.8, 1.2), f.y + f.bank * lane + 0.06, f.z + f.rz * lane * clamp(t.halfW[0] / 10, 0.8, 1.2))
      group.add(slot)
    }
    // Title banner over the grid.
    t.frameAt(t.length - 40, f)
    const tex = bannerTexture(this.track.spec.name.toUpperCase())
    this.disposables.push(tex)
    const w = f.halfW * 2 + 8
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 8), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }))
    banner.position.set(f.x, f.y + 11, f.z)
    banner.rotation.y = Math.atan2(f.tx, f.tz) + Math.PI
    group.add(banner)
    const postGeo = new THREE.CylinderGeometry(0.35, 0.45, 13, 8)
    const postMat = new THREE.MeshStandardMaterial({ color: '#3a3438', roughness: 0.7, metalness: 0.15 })
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(postGeo, postMat)
      p.position.set(f.x + f.rx * side * (w / 2), f.y + 6.5, f.z + f.rz * side * (w / 2))
      group.add(p)
    }
    return group
  }

  private itemBoxes(): THREE.Group {
    const t = this.track
    const group = new THREE.Group()
    const crystal = new THREE.MeshStandardMaterial({ color: '#ff8ad9', emissive: '#a0206f', emissiveIntensity: 0.45, roughness: 0.18, metalness: 0, flatShading: true, transparent: true, opacity: 0.88, envMapIntensity: 0.6 })
    const core = new THREE.MeshBasicMaterial({ color: '#fff3a8' })
    const geo = new THREE.OctahedronGeometry(1.15, 0)
    const coreGeo = new THREE.IcosahedronGeometry(0.42, 0)
    const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
    for (const row of t.items) {
      t.frameAt(row.s, f)
      for (const lane of row.lanes) {
        const g = new THREE.Group()
        const c = new THREE.Mesh(geo, crystal)
        c.scale.set(1, 1.3, 1)
        c.castShadow = true
        g.add(c, new THREE.Mesh(coreGeo, core))
        g.position.set(f.x + f.rx * lane, f.y + f.bank * lane + 1.3, f.z + f.rz * lane)
        g.userData.baseY = g.position.y
        this.boxes.push(g)
        group.add(g)
      }
    }
    return group
  }

  private powerCellObjects(): THREE.Group {
    const group = new THREE.Group()
    const cellMat = new THREE.MeshStandardMaterial({ color: '#7ef9ff', emissive: '#08b7d3', emissiveIntensity: 1.6, roughness: 0.16, metalness: 0.05, flatShading: true })
    const coreMat = new THREE.MeshBasicMaterial({ color: '#fff5b8', toneMapped: false })
    const ringMat = new THREE.MeshBasicMaterial({ color: '#a8fbff', transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
    const crystalGeo = new THREE.OctahedronGeometry(0.8, 0)
    const coreGeo = new THREE.IcosahedronGeometry(0.26, 0)
    const ringGeo = new THREE.TorusGeometry(1.15, 0.055, 8, 24)
    const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
    for (const cell of powerCellPlacements(this.track)) {
      this.track.frameAt(cell.s, f)
      const g = new THREE.Group()
      const crystal = new THREE.Mesh(crystalGeo, cellMat)
      crystal.scale.set(0.82, 1.35, 0.82)
      crystal.castShadow = true
      const ring = new THREE.Mesh(ringGeo, ringMat)
      ring.rotation.x = Math.PI / 2
      g.add(crystal, new THREE.Mesh(coreGeo, coreMat), ring)
      g.position.set(f.x + f.rx * cell.lane, f.y + f.bank * cell.lane + 1.35, f.z + f.rz * cell.lane)
      g.userData.baseY = g.position.y
      g.userData.ring = ring
      this.powerCells.push(g)
      group.add(g)
    }
    return group
  }

  private signs(): THREE.Group {
    const t = this.track
    const group = new THREE.Group()
    const tex = chevronTexture()
    this.disposables.push(tex)
    const matR = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
    const texL = tex.clone()
    texL.repeat.set(-1, 1)
    texL.offset.set(1, 0)
    texL.wrapS = THREE.RepeatWrapping
    texL.needsUpdate = true
    this.disposables.push(texL)
    const matL = new THREE.MeshBasicMaterial({ map: texL, side: THREE.DoubleSide })
    const geo = new THREE.PlaneGeometry(3.2, 1.6)
    let last = -99
    for (let i = 0; i < t.n; i += 1) {
      const k = t.curv[i]
      if (Math.abs(k) < 1 / 75 || i - last < 7) continue
      last = i
      const outside = k < 0 ? -1 : 1
      const off = t.barrierAt(i) + 0.9
      const mesh = new THREE.Mesh(geo, k < 0 ? matR : matL)
      mesh.position.set(t.x[i] + t.rx[i] * outside * off, this.edgeY(i, outside) + 2.2, t.z[i] + t.rz[i] * outside * off)
      mesh.rotation.y = t.heading[i] + Math.PI
      group.add(mesh)
    }
    return group
  }

  private props(): THREE.Group {
    const t = this.track
    const group = new THREE.Group()
    const r = rng(t.spec.seed * 7 + 3)
    const rockGeo = boulder(11)
    const rockMat = surfaceMaterial({ set: 'rocks', scale: 1 / 3.2, tint: 0.35, roughness: 1, normalScale: 1.4 })
    const rocks: { m: THREE.Matrix4; c: THREE.Color }[] = []
    const cactusGeo = cactus()
    const cacti: THREE.Matrix4[] = []
    const spireGeo = new THREE.CylinderGeometry(2.2, 4.6, 1, 11, 6)
    jitter(spireGeo, 0.45, 5)
    const spires: { m: THREE.Matrix4; c: THREE.Color; x: number; y: number; z: number; h: number; rot: number }[] = []
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    for (let k = 0; k < 900; k += 1) {
      const i = Math.floor(r() * t.n)
      const side = r() < 0.5 ? -1 : 1
      const ext = this.ext[i * 2 + (side > 0 ? 1 : 0)]
      const c = this.canyonW(i)
      const kind = r()
      if (t.bridge[i] > 0.3) continue
      if (kind < 0.45) {
        // Boulders along the wall base / desert edge.
        const s = 0.8 + r() * 2.6
        const off = t.barrierAt(i) + 2 + s + r() * Math.min(ext, 14)
        const x = t.x[i] + t.rx[i] * side * off, z = t.z[i] + t.rz[i] * side * off
        if (this.nearest(x, z).x < s + 1.5) continue
        const y = this.surfaceAt(x, z)
        m.compose(new THREE.Vector3(x, y + s * 0.3, z), q.setFromEuler(e.set(r() * 3, r() * 3, r() * 3)), new THREE.Vector3(s, s * (0.6 + r() * 0.5), s))
        rocks.push({ m: m.clone(), c: STRATA[Math.floor(r() * STRATA.length)].clone().multiplyScalar(0.85 + r() * 0.2) })
      } else if (kind < 0.8 && c < 0.4) {
        const off = t.barrierAt(i) + 8 + r() * 180
        const x = t.x[i] + t.rx[i] * side * off, z = t.z[i] + t.rz[i] * side * off
        if (this.nearest(x, z).x < 6) continue
        const y = this.surfaceAt(x, z)
        const s = 0.8 + r() * 0.7
        m.compose(new THREE.Vector3(x, y - 0.3, z), q.setFromEuler(e.set(0, r() * 6.28, 0)), new THREE.Vector3(s, s, s))
        cacti.push(m.clone())
      } else if (c < 0.3) {
        const off = t.barrierAt(i) + 40 + r() * 260
        const x = t.x[i] + t.rx[i] * side * off, z = t.z[i] + t.rz[i] * side * off
        if (this.nearest(x, z).x < 30) continue
        const y = this.surfaceAt(x, z)
        const h = 14 + r() * 34
        const s = 0.7 + r() * 0.8
        const rot = r() * 6.28
        m.compose(new THREE.Vector3(x, y + h / 2 - 1, z), q.setFromEuler(e.set(0, rot, 0)), new THREE.Vector3(s, h, s))
        spires.push({ m: m.clone(), c: STRATA[Math.floor(r() * STRATA.length)].clone(), x, y, z, h, rot })
      }
    }
    const rockInst = new THREE.InstancedMesh(rockGeo, rockMat, rocks.length)
    rocks.forEach((v, k) => { rockInst.setMatrixAt(k, v.m); rockInst.setColorAt(k, v.c) })
    rockInst.castShadow = true
    rockInst.receiveShadow = true
    group.add(rockInst)
    const cactusInst = new THREE.InstancedMesh(cactusGeo, new THREE.MeshStandardMaterial({ color: '#5a7a44', roughness: 0.85, metalness: 0 }), cacti.length)
    cacti.forEach((v, k) => cactusInst.setMatrixAt(k, v))
    cactusInst.castShadow = true
    group.add(cactusInst)
    const spireInst = new THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>(spireGeo, surfaceMaterial({ set: 'sandstone', scale: 1 / 7, tint: 0.45, roughness: 1, normalScale: 1.2 }), spires.length)
    spires.forEach((v, k) => { spireInst.setMatrixAt(k, v.m); spireInst.setColorAt(k, v.c) })
    spireInst.castShadow = true
    group.add(spireInst)
    // Photoreal generated props replace the procedural proxies as soon as their GLBs stream in.
    const tint = new THREE.Color()
    whenProp('boulder', () => {
      const pm = propMesh('boulder', 'radius')
      if (!pm || this.disposed) return
      rockInst.geometry = pm.geometry
      rockInst.material = pm.material
      rocks.forEach((_, k) => rockInst.setColorAt(k, tint.setScalar(0.82 + hash3(k, 3, 9) * 0.26)))
      if (rockInst.instanceColor) rockInst.instanceColor.needsUpdate = true
    })
    whenProp('saguaro', () => {
      const pm = propMesh('saguaro', 'base')
      if (!pm || this.disposed) return
      const geo = pm.geometry.clone()
      geo.scale(7, 7, 7)
      geo.translate(0, 0.25, 0)
      cactusInst.geometry = geo
      cactusInst.material = pm.material
    })
    whenProp('spire', () => {
      const pm = propMesh('spire', 'base')
      if (!pm || this.disposed) return
      spireInst.geometry = pm.geometry
      spireInst.material = pm.material
      spires.forEach((v, k) => {
        const w = v.h * (0.75 + hash3(k, 5, 1) * 0.3)
        m.compose(new THREE.Vector3(v.x, v.y - 1.5, v.z), q.setFromEuler(e.set(0, v.rot, 0)), new THREE.Vector3(w, v.h * 1.15, w))
        spireInst.setMatrixAt(k, m)
        spireInst.setColorAt(k, tint.setScalar(0.85 + hash3(k, 2, 2) * 0.2))
      })
      spireInst.instanceMatrix.needsUpdate = true
      if (spireInst.instanceColor) spireInst.instanceColor.needsUpdate = true
      spireInst.computeBoundingSphere()
    })
    return group
  }

  /** Streamed set dressing: start/finish gantry and grid light towers (extra stage). */
  private dressing(): void {
    const t = this.track
    const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
    const place = (key: string, build: (src: THREE.Object3D) => void) => {
      const run = () => {
        const g = assets.models.get(key)
        if (!g || this.disposed) return
        build(g.scene)
      }
      if (assets.has(key)) run()
      else void assets.whenSettled(key).then(run)
    }
    place('model:gantry', src => {
      t.frameAt(t.length - 6, f)
      const obj = src.clone(true)
      const box = new THREE.Box3().setFromObject(obj)
      const width = box.max.x - box.min.x
      const target = (t.barrierAt(0) + 1.5) * 2
      const k = target / Math.max(1, width)
      obj.scale.set(k, Math.max(1, k * 0.8), Math.max(1, k * 0.6))
      obj.position.set(f.x, f.y, f.z)
      obj.rotation.y = Math.atan2(f.tx, f.tz)
      obj.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; tame(m.material, true) } })
      this.scene.add(obj)
    })
    place('model:tower', src => {
      for (const s of [t.length - 70, t.length - 30, 24]) {
        for (const side of [-1, 1]) {
          t.frameAt(mod(s, t.length), f)
          const obj = src.clone(true)
          const off = t.barrierAt(0) + 3.2
          obj.scale.setScalar(1.6)
          obj.position.set(f.x + f.rx * side * off, this.edgeY(0, side) - 0.2, f.z + f.rz * side * off)
          obj.rotation.y = Math.atan2(f.tx, f.tz) + (side > 0 ? Math.PI / 2 : -Math.PI / 2)
          obj.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; tame(m.material) } })
          this.scene.add(obj)
        }
      }
    })
  }

}

// ─── geometry helpers ──────────────────────────────────────────────────────

/** Triangle strip grid (rows × cols) from flat arrays. */
/** Plain row-major grid (no auto-orientation): used for rolled corkscrew surfaces drawn double-sided. */
function gridGeometry(pos: Float32Array, uv: Float32Array, rows: number, cols: number): THREE.BufferGeometry {
  const idx: number[] = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const a = r * cols + c
      const b = (r + 1) * cols + c
      idx.push(a, a + 1, b, b, a + 1, b + 1)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

function stripGeometry(pos: Float32Array, uv: Float32Array, rows: number, cols: number, flip = false, closed = true): THREE.BufferGeometry {
  void closed
  // Auto-orient mostly-horizontal strips so their front faces look up (back faces are culled).
  if (!flip && cols >= 2) {
    const ax = pos[0], ay = pos[1], az = pos[2]
    const bx = pos[cols * 3] - ax, by = pos[cols * 3 + 1] - ay, bz = pos[cols * 3 + 2] - az
    const cx = pos[3] - ax, cy = pos[4] - ay, cz = pos[5] - az
    const ny = bz * cx - bx * cz
    const horizontal = Math.abs(ny) > 0.5 * Math.hypot(by * cz - bz * cy, ny, bx * cy - by * cx)
    if (horizontal && ny < 0) flip = true
  }
  const idx: number[] = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const a = r * cols + c
      const b = (r + 1) * cols + c
      if (flip) idx.push(a, a + 1, b, b, a + 1, b + 1)
      else idx.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  // Road normals point up regardless of winding.
  const nrm = geo.attributes.normal as THREE.BufferAttribute
  for (let k = 0; k < nrm.count; k += 1) if (nrm.getY(k) < 0) nrm.setXYZ(k, -nrm.getX(k), -nrm.getY(k), -nrm.getZ(k))
  return geo
}

function quadMesh(quads: number[], mat: THREE.Material, cast: boolean): THREE.Mesh {
  const count = quads.length / 12
  const idx: number[] = []
  for (let k = 0; k < count; k += 1) {
    const b = k * 4
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(quads, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = cast
  mesh.receiveShadow = true
  if (!(mat as THREE.MeshStandardMaterial).side) (mat as THREE.MeshStandardMaterial).side = THREE.DoubleSide
  return mesh
}

function jitter(geo: THREE.BufferGeometry, amount: number, seed: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const map = new Map<string, [number, number, number]>()
  for (let k = 0; k < pos.count; k += 1) {
    const key = `${pos.getX(k).toFixed(3)},${pos.getY(k).toFixed(3)},${pos.getZ(k).toFixed(3)}`
    let off = map.get(key)
    if (!off) {
      off = [(hash3(k, 1, seed) - 0.5) * amount, (hash3(k, 2, seed) - 0.5) * amount, (hash3(k, 3, seed) - 0.5) * amount]
      map.set(key, off)
    }
    pos.setXYZ(k, pos.getX(k) + off[0], pos.getY(k) + off[1], pos.getZ(k) + off[2])
  }
  geo.computeVertexNormals()
}

function cactus(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const trunk = new THREE.CylinderGeometry(0.45, 0.55, 6, 14, 4)
  trunk.translate(0, 3, 0)
  parts.push(trunk)
  for (const [side, h, len] of [[1, 2.6, 2.2], [-1, 3.4, 1.8]] as const) {
    const arm = new THREE.CylinderGeometry(0.32, 0.34, 1.4, 10)
    arm.rotateZ(Math.PI / 2)
    arm.translate(side * 0.9, h, 0)
    const up = new THREE.CylinderGeometry(0.3, 0.32, len, 10)
    up.translate(side * 1.5, h + len / 2, 0)
    parts.push(arm, up)
  }
  const geo = mergeGeometries(parts.map(p => p.toNonIndexed()))
  return geo
}

/** Tone down catalogue materials: no glare from big metallic or emissive panels. */
function tame(mat: THREE.Material | THREE.Material[], steel = false): void {
  for (const m of Array.isArray(mat) ? mat : [mat]) {
    const sm = m as THREE.MeshStandardMaterial
    if (!sm.isMeshStandardMaterial) continue
    // Large pale structural parts read as flat plaster in sunlight: repaint as graphite steel.
    if (steel && !sm.map && sm.color.r + sm.color.g + sm.color.b > 1.8) {
      sm.color.set('#3b3e45')
      sm.metalness = 0.4
      sm.roughness = 0.5
    } else if (steel && sm.map) {
      // Palette-textured catalog parts: knock the pale beige down towards graphite.
      sm.color.setRGB(0.42, 0.43, 0.46)
    }
    sm.metalness = Math.min(sm.metalness, 0.3)
    sm.roughness = Math.max(sm.roughness, 0.45)
    sm.envMapIntensity = 0.35
    if (sm.emissiveIntensity > 0.6) sm.emissiveIntensity = 0.6
  }
}

/** Smooth, lumpy boulder: subdivided icosahedron with layered radial noise. */
function boulder(seed: number): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 3)
  geo.deleteAttribute('normal')
  geo.deleteAttribute('uv')
  geo = mergeVertices(geo)
  const pos = geo.attributes.position as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let k = 0; k < pos.count; k += 1) {
    v.fromBufferAttribute(pos, k).normalize()
    const n1 = noise2(v.x * 1.7 + v.z * 0.6, v.y * 1.7 - v.z * 0.4, seed)
    const n2 = noise2(v.x * 4.1 - v.y * 1.3, v.z * 4.1 + v.y, seed + 3)
    let r = 0.82 + n1 * 0.32 + n2 * 0.1
    if (v.y < -0.2) r *= 0.85 + 0.15 * (1 + v.y)
    // Flatten a couple of facets for a fractured look.
    const flat = Math.max(0, v.dot(new THREE.Vector3(0.6, 0.5, 0.62)) - 0.72)
    r -= flat * 0.6
    v.multiplyScalar(r)
    pos.setXYZ(k, v.x, v.y, v.z)
  }
  geo.computeVertexNormals()
  return geo
}
