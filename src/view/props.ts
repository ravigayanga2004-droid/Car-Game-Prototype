import * as THREE from 'three'
import { assets } from '../engine/assets'

/**
 * Photoreal generated props (Tripo GLBs: one mesh, one PBR material, unit bounding box).
 * Each is normalised once into a shared geometry + material so instanced scatter and pooled item
 * meshes can reuse it. Environment props drop metalness and keep environment reflections weak so
 * sunlit rock never glares.
 */
export type PropKey = 'boulder' | 'spire' | 'saguaro' | 'seeker' | 'mine'
export type Fit =
  /** Centred, largest half-extent = 1 (boulders, mines). */
  | 'radius'
  /** Base at y = 0, height = 1, centred on x/z (spires, cacti). */
  | 'base'
  /** Length along +Z = 1, centred (seeker: generated facing +X). */
  | 'length'

export interface PropMesh { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial; size: THREE.Vector3 }

const cache = new Map<string, PropMesh>()

export function propKey(k: PropKey): string { return `prop:${k}` }

/** Returns the normalised prop if its GLB is loaded, else null (callers keep their proxy). */
export function propMesh(k: PropKey, fit: Fit, env = true): PropMesh | null {
  const id = `${k}:${fit}`
  const hit = cache.get(id)
  if (hit) return hit
  const g = assets.models.get(propKey(k))
  if (!g) return null
  let src: THREE.Mesh | null = null
  g.scene.traverse(o => { if (!src && (o as THREE.Mesh).isMesh) src = o as THREE.Mesh })
  if (!src) return null
  const mesh = src as THREE.Mesh
  mesh.updateWorldMatrix(true, false)
  const geo = dequantize(mesh.geometry)
  geo.applyMatrix4(mesh.matrixWorld)
  // Dequantise-friendly: ensure float normals exist for lighting.
  if (!geo.attributes.normal) geo.computeVertexNormals()
  if (fit === 'length') geo.rotateY(-Math.PI / 2)
  geo.computeBoundingBox()
  const b = geo.boundingBox!
  const size = b.getSize(new THREE.Vector3())
  const c = b.getCenter(new THREE.Vector3())
  if (fit === 'radius') {
    geo.translate(-c.x, -c.y, -c.z)
    const k2 = 2 / Math.max(size.x, size.y, size.z)
    geo.scale(k2, k2, k2)
  } else if (fit === 'base') {
    geo.translate(-c.x, -b.min.y, -c.z)
    const k2 = 1 / size.y
    geo.scale(k2, k2, k2)
  } else {
    geo.translate(-c.x, -c.y, -c.z)
    const k2 = 1 / size.z
    geo.scale(k2, k2, k2)
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  const sm = mesh.material as THREE.MeshStandardMaterial
  const mat = new THREE.MeshStandardMaterial({
    map: sm.map, normalMap: sm.normalMap, roughnessMap: sm.roughnessMap,
    metalnessMap: env ? null : sm.metalnessMap, metalness: env ? 0 : 1, roughness: env ? 1 : 1,
  })
  if (sm.normalMap) mat.normalScale.copy(sm.normalScale)
  mat.envMapIntensity = env ? 0.3 : 0.6
  const out = { geometry: geo, material: mat, size: geo.boundingBox!.getSize(new THREE.Vector3()) }
  cache.set(id, out)
  return out
}

/** Runs `fn` once the prop GLB is available (immediately if already loaded). */
export function whenProp(k: PropKey, fn: () => void): void {
  if (assets.has(propKey(k))) fn()
  else void assets.whenSettled(propKey(k)).then(() => { if (assets.has(propKey(k))) fn() })
}

/**
 * KHR_mesh_quantization stores positions/normals as normalised int16/int8, which clamp to ±1 when
 * transformed. Expand every attribute to Float32 before baking transforms into the geometry.
 */
function dequantize(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  for (const [name, attr] of Object.entries(src.attributes)) {
    const a = attr as THREE.BufferAttribute
    const out = new Float32Array(a.count * a.itemSize)
    for (let i = 0; i < a.count; i += 1) {
      out[i * a.itemSize] = a.getX(i)
      if (a.itemSize > 1) out[i * a.itemSize + 1] = a.getY(i)
      if (a.itemSize > 2) out[i * a.itemSize + 2] = a.getZ(i)
      if (a.itemSize > 3) out[i * a.itemSize + 3] = a.getW(i)
    }
    geo.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize))
  }
  if (src.index) geo.setIndex(src.index.clone())
  return geo
}
