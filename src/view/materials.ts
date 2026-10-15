import * as THREE from 'three'
import { assets } from '../engine/assets'

/**
 * Realistic surface materials built on MeshStandardMaterial with injected world-space texturing:
 * - triplanar for canyon walls, boulders, arches and spires (no UV stretching on cliffs),
 * - planar-Y for the desert floor, shoulders and road (with painted-line overlay for asphalt).
 * Textures stream in through the asset store; until then materials render with flat placeholders
 * so the title screen never waits on PBR maps. Environment reflections are deliberately weak
 * (low envMapIntensity, zero metalness) to avoid glare on large surfaces.
 */
export type TexSet = 'cliff' | 'sand' | 'asphalt' | 'sandstone' | 'rocks'

export interface SurfaceOptions {
  set: TexSet
  /** World units → texture repeats (1 / metres per tile). */
  scale: number
  /** Planar Y projection (floors) instead of triplanar. */
  planar?: boolean
  normalScale?: number
  /** How much vertex colours tint the texture (0 = ignore, 1 = full multiply). */
  tint?: number
  roughness?: number
  /** Albedo brightness multiplier. */
  bright?: number
  /** Optional sand drift on up-facing surfaces (triplanar only). */
  top?: TexSet
  topAmount?: number
  /** Painted overlay from UVs (road lines), mixed by its alpha. */
  overlay?: THREE.Texture
  color?: THREE.ColorRepresentation
  side?: THREE.Side
  vertexColors?: boolean
  envIntensity?: number
  /** 0..1: use the texture only as grey detail and take hue from vertex colours (strata). */
  gray?: number
  /** Vertical erosion streaks on steep faces (triplanar only). */
  streaks?: number
}

const placeholders = {
  diff: flat(255, 255, 255, true),
  nor: flat(128, 128, 255, false),
  arm: flat(255, 200, 0, false),
}

function flat(r: number, g: number, b: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.needsUpdate = true
  return t
}

/** Mean colours of each set, used as placeholder tint so the world reads right before maps load. */
const SET_TINT: Record<TexSet, string> = {
  cliff: '#a4745a', sand: '#c99a6c', asphalt: '#5d5a58', sandstone: '#b0603f', rocks: '#9d8069',
}

type Uniforms = Record<string, THREE.IUniform>

function bindSet(u: Uniforms, prefix: string, set: TexSet, onLoaded: () => void): void {
  const apply = () => {
    const d = assets.tex(`${set}_diff`)
    const n = assets.tex(`${set}_nor`)
    const a = assets.tex(`${set}_arm`)
    if (d) u[`${prefix}Diff`].value = d
    if (n) u[`${prefix}Nor`].value = n
    if (a) u[`${prefix}Arm`].value = a
    if (d) onLoaded()
  }
  apply()
  if (!assets.has(`${set}_diff`)) {
    void Promise.all([assets.whenSettled(`${set}_diff`), assets.whenSettled(`${set}_nor`), assets.whenSettled(`${set}_arm`)]).then(apply)
  }
}

const TRI_COMMON = /* glsl */ `
uniform sampler2D tDiff; uniform sampler2D tNor; uniform sampler2D tArm;
uniform sampler2D tTopDiff; uniform sampler2D tTopNor;
uniform float uScale; uniform float uNormalScale; uniform float uTint; uniform float uBright;
uniform float uTopAmount; uniform float uLoaded; uniform float uGray; uniform float uStreaks;
varying vec3 vTriPos; varying vec3 vTriNrm;
vec3 triWeights(vec3 n) { vec3 w = pow(abs(n), vec3(5.0)); return w / (w.x + w.y + w.z + 1e-5); }
vec4 triSample(sampler2D t, vec3 p, vec3 w) {
  return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
}
vec3 triNormal(sampler2D t, vec3 p, vec3 n, vec3 w, float strength) {
  vec3 nx = texture2D(t, p.zy).xyz * 2.0 - 1.0;
  vec3 ny = texture2D(t, p.xz).xyz * 2.0 - 1.0;
  vec3 nz = texture2D(t, p.xy).xyz * 2.0 - 1.0;
  nx.xy *= strength; ny.xy *= strength; nz.xy *= strength;
  nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
  ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
  nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
  return normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
}
`

export function surfaceMaterial(o: SurfaceOptions): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: o.color ?? '#ffffff',
    roughness: o.roughness ?? 1,
    metalness: 0,
    side: o.side ?? THREE.FrontSide,
    vertexColors: o.vertexColors ?? false,
    map: o.overlay ?? null,
  })
  mat.envMapIntensity = o.envIntensity ?? 0.25
  const u: Uniforms = {
    tDiff: { value: placeholders.diff }, tNor: { value: placeholders.nor }, tArm: { value: placeholders.arm },
    tTopDiff: { value: placeholders.diff }, tTopNor: { value: placeholders.nor },
    uScale: { value: o.scale }, uNormalScale: { value: o.normalScale ?? 1 }, uTint: { value: o.tint ?? 0 },
    uBright: { value: o.bright ?? 1 }, uTopAmount: { value: o.top ? (o.topAmount ?? 0.6) : 0 },
    uLoaded: { value: 0 }, uGray: { value: o.gray ?? 0 }, uStreaks: { value: o.streaks ?? 0 }, uPlaceholder: { value: new THREE.Color(SET_TINT[o.set]) },
  }
  bindSet(u, 't', o.set, () => { u.uLoaded.value = 1 })
  if (o.top) {
    const top = o.top
    const apply = () => {
      const d = assets.tex(`${top}_diff`)
      const n = assets.tex(`${top}_nor`)
      if (d) u.tTopDiff.value = d
      if (n) u.tTopNor.value = n
    }
    apply()
    void assets.whenSettled(`${top}_diff`).then(apply)
  }
  const planar = !!o.planar
  const overlay = !!o.overlay
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNrm;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  {
    vec4 triWp = vec4(transformed, 1.0);
    vec3 triN = objectNormal;
    #ifdef USE_INSTANCING
      triWp = instanceMatrix * triWp;
      triN = mat3(instanceMatrix) * triN;
    #endif
    triWp = modelMatrix * triWp;
    vTriPos = triWp.xyz;
    vTriNrm = normalize(mat3(modelMatrix) * triN);
  }`)
    const frag = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TRI_COMMON}\nuniform vec3 uPlaceholder;`)
      .replace('#include <map_fragment>', planar ? /* glsl */ `
  vec3 tn = normalize(vTriNrm);
  vec2 tp = vTriPos.xz * uScale;
  vec3 texA = texture2D(tDiff, tp).rgb;
  vec3 texB = texture2D(tDiff, tp * 0.173 + 0.31).rgb;
  vec4 triArm = texture2D(tArm, tp);
  float macro = 0.82 + 0.36 * texture2D(tDiff, vTriPos.xz * uScale * 0.031).g;
  vec3 albedo = mix(texA, texA * (0.7 + 0.6 * texB), 0.5) * macro * mix(1.0, triArm.r, 0.5);
  albedo = mix(uPlaceholder, albedo, uLoaded) * uBright;
  ${overlay ? `vec4 paint = texture2D(map, vMapUv); albedo = mix(albedo, paint.rgb, paint.a);` : ''}
  diffuseColor.rgb *= albedo;
` : /* glsl */ `
  vec3 tn = normalize(vTriNrm);
  vec3 tw = triWeights(tn);
  vec3 tp = vTriPos * uScale;
  vec3 texA = triSample(tDiff, tp, tw).rgb;
  vec3 texB = triSample(tDiff, tp * 0.21 + 0.37, tw).rgb;
  vec4 triArm = triSample(tArm, tp, tw);
  vec3 albedo = mix(texA, texB, 0.4) * mix(1.0, triArm.r, 0.55);
  float lumA = dot(albedo, vec3(0.299, 0.587, 0.114));
  albedo = mix(albedo, vec3(clamp(lumA * 2.3, 0.0, 1.35)), uGray * uLoaded);
  // Desert-varnish streaks running down steep faces.
  float steep = 1.0 - smoothstep(0.35, 0.75, abs(tn.y));
  vec2 sp = vec2((tn.x * tn.x > tn.z * tn.z ? vTriPos.z : vTriPos.x) * 0.045, vTriPos.y * 0.004);
  float streak = texture2D(tDiff, sp).g;
  albedo *= mix(1.0, 0.62 + 0.62 * streak, steep * uStreaks * uLoaded);
  float topMask = smoothstep(0.62, 0.86, tn.y + (texA.r - 0.5) * 0.35) * uTopAmount;
  vec3 topCol = texture2D(tTopDiff, vTriPos.xz * uScale * 1.7).rgb;
  albedo = mix(albedo, topCol, topMask);
  albedo = mix(uPlaceholder, albedo, uLoaded) * uBright;
  ${overlay ? `vec4 paint = texture2D(map, vMapUv); albedo = mix(albedo, paint.rgb, paint.a);` : ''}
  diffuseColor.rgb *= albedo;
`)
      .replace('#include <color_fragment>', `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  diffuseColor.rgb *= mix(vec3(1.0), vColor.rgb, uTint);
#endif`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness * mix(1.0, triArm.g, uLoaded);`)
      .replace('#include <normal_fragment_maps>', planar ? /* glsl */ `
  {
    vec3 nm = texture2D(tNor, tp).xyz * 2.0 - 1.0;
    vec3 wn = normalize(tn + vec3(nm.x, 0.0, -nm.y) * uNormalScale * uLoaded);
    normal = normalize((viewMatrix * vec4(wn * faceDirection, 0.0)).xyz);
  }` : /* glsl */ `
  {
    vec3 wn = triNormal(tNor, tp, tn, tw, uNormalScale * uLoaded);
    vec3 topN = texture2D(tTopNor, vTriPos.xz * uScale * 1.7).xyz * 2.0 - 1.0;
    wn = normalize(mix(wn, normalize(tn + vec3(topN.x, 0.0, -topN.y) * 0.6), topMask));
    normal = normalize((viewMatrix * vec4(wn * faceDirection, 0.0)).xyz);
  }`)
    shader.fragmentShader = frag
  }
  mat.customProgramCacheKey = () => `surf-${planar ? 'p' : 't'}-${overlay ? 'o' : ''}`
  return mat
}

// ─── Sky ─────────────────────────────────────────────────────────────────

export const HORIZON_HAZE = '#e8a37f'
const HORIZON_V = 0.105

/** Dome textured with the golden-hour panorama; the painted sun is aligned to `sunDir`. */
export function skyDome(sunDir: THREE.Vector3): THREE.Mesh {
  const az = Math.atan2(sunDir.x, sunDir.z) / (Math.PI * 2)
  const u: Uniforms = {
    tSky: { value: placeholders.diff },
    uLoaded: { value: 0 },
    uOffset: { value: 0.3125 - az },
    uHaze: { value: new THREE.Color(HORIZON_HAZE) },
  }
  const apply = () => {
    const t = assets.tex('sky')
    if (t) { u.tSky.value = t; u.uLoaded.value = 1 }
  }
  apply()
  void assets.whenSettled('sky').then(apply)
  const mat = new THREE.ShaderMaterial({
    uniforms: u,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tSky; uniform float uLoaded; uniform float uOffset; uniform vec3 uHaze;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float elev = asin(clamp(d.y, -1.0, 1.0));
        float u = fract(atan(d.x, d.z) / 6.2831853 + uOffset);
        float v = elev >= 0.0 ? ${HORIZON_V} + (1.0 - ${HORIZON_V}) * pow(elev / 1.5707963, 0.92) : ${HORIZON_V} * (1.0 + elev / 0.1);
        vec3 col = texture2D(tSky, vec2(u, clamp(v, 0.004, 0.996))).rgb;
        float below = smoothstep(0.02, -0.05, elev);
        col = mix(col, uHaze, below);
        vec3 grad = mix(uHaze, vec3(0.30, 0.52, 0.86), smoothstep(0.0, 0.9, elev));
        gl_FragColor = vec4(mix(grad, col, uLoaded), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), mat)
  mesh.frustumCulled = false
  mesh.renderOrder = -10
  mesh.onBeforeRender = (_r, _s, camera) => mesh.position.copy(camera.position)
  return mesh
}

/** Pre-filtered environment from the sky dome plus a warm sand floor, for soft car reflections. */
export function buildEnvironment(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3): THREE.Texture {
  const scene = new THREE.Scene()
  const dome = skyDome(sunDir)
  dome.onBeforeRender = () => {}
  scene.add(dome)
  const floor = new THREE.Mesh(new THREE.CircleGeometry(3000, 32), new THREE.MeshBasicMaterial({ color: '#a8734c' }))
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -40
  scene.add(floor)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const rt = pmrem.fromScene(scene, 0.02, 1, 5000)
  pmrem.dispose()
  dome.geometry.dispose()
  ;(dome.material as THREE.Material).dispose()
  floor.geometry.dispose()
  ;(floor.material as THREE.Material).dispose()
  return rt.texture
}
