import * as THREE from 'three'
import { CONFIG } from '../game/config'
import type { CarState } from '../sim/car'
import { clamp, lerp, wrapAngle } from '../sim/math'
import { newCorkFrame, newLoc, type Track } from '../sim/track'

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const TO_UP = new THREE.Quaternion()
const PART = new THREE.Quaternion()

/** Chase camera: follows heading, leans toward the slide during drifts and widens with speed. */
export class ChaseCam {
  readonly camera = new THREE.PerspectiveCamera(68, 1, 0.3, 4200)
  private yaw = 0
  private readonly pos = new THREE.Vector3()
  private readonly look = new THREE.Vector3()
  private height = 0
  private fov = 68
  private shake = 0
  private readonly loc = newLoc()
  reducedMotion = false
  shakeEnabled = true

  reset(x: number, y: number, z: number, yaw: number): void {
    this.yaw = yaw
    this.height = y
    this.roll = 0
    this.corkW = 0
    this.camera.up.set(0, 1, 0)
    const d = CONFIG.camera.distance
    this.pos.set(x - Math.sin(yaw) * d, y + CONFIG.camera.height, z - Math.cos(yaw) * d)
    this.look.set(x, y + 1.2, z)
    this.camera.position.copy(this.pos)
    this.camera.lookAt(this.look)
  }

  kick(amount: number): void {
    if (this.shakeEnabled && !this.reducedMotion) this.shake = Math.min(1, this.shake + amount)
  }

  private air = 0
  private roll = 0
  /** 0..1 blend into the corkscrew rail camera (up follows the ribbon normal). */
  private corkW = 0
  private readonly cf = newCorkFrame()
  private readonly cn = new THREE.Vector3(0, 1, 0)
  private readonly cfw = new THREE.Vector3(0, 0, 1)
  update(dt: number, x: number, y: number, z: number, yaw: number, car: CarState | null, track: Track): void {
    const speed = car ? Math.hypot(car.vx, car.vz) : 0
    // Aim between the nose and the velocity direction so drifts read as slides.
    let target = yaw
    if (car && speed > 6) {
      const velYaw = Math.atan2(car.vx, car.vz)
      target = yaw + wrapAngle(velYaw - yaw) * (car.drift ? 0.55 : 0.35)
    }
    if (car && car.spin > 0) target = this.yaw
    const follow = 1 - Math.exp(-dt * CONFIG.camera.follow * (car && !car.grounded ? 0.5 : 1))
    this.yaw += wrapAngle(target - this.yaw) * follow
    this.height += (y - this.height) * (1 - Math.exp(-dt * (car && !car.grounded ? 3 : 10)))
    // Soft vertical lag in the air, but never let the car leave the frame on mega jumps.
    this.height = clamp(this.height, y - 2.2, y + 1.6)
    const airH = car && !car.grounded ? clamp((y - car.loc.roadY) / 12, 0, 1) : 0
    const boosting = !!car && (car.boostTime > 0 || car.meterBoosting || car.powerBoosting)
    this.air += (airH - this.air) * (1 - Math.exp(-dt * 3))
    const dist = CONFIG.camera.distance + clamp(speed / 70, 0, 1) * 1.6 + (boosting ? 0.8 : 0) + this.air * 3.5
    const want = new THREE.Vector3(x - Math.sin(this.yaw) * dist, this.height + CONFIG.camera.height + clamp(speed / 80, 0, 1) * 0.5 + this.air * 1.8, z - Math.cos(this.yaw) * dist)
    // Keep the camera inside the canyon walls / rails.
    track.locate(want.x, want.y, want.z, car ? car.loc.i : 0, this.loc)
    // On steep banks the rock face rises right behind the rim: stay over the paved apron.
    const tilt = Math.abs(track.bank[this.loc.i] ?? 0)
    const lim = tilt > 0.45 ? Math.min(this.loc.barrier - 0.8, track.pavedW(this.loc.i) - 1.8) : this.loc.barrier - 0.8
    if (Math.abs(this.loc.d) > lim) {
      const push = Math.abs(this.loc.d) - lim
      const sgn = Math.sign(this.loc.d)
      want.x -= this.loc.rx * sgn * push
      want.z -= this.loc.rz * sgn * push
      this.loc.roadY -= track.bank[this.loc.i] * sgn * push
    }
    const minY = this.loc.roadY + 1.2 + Math.min(tilt, 2) * 0.9
    if (want.y < minY) want.y = minY
    this.look.set(x + Math.sin(this.yaw) * 4, (this.height + y) / 2 + 1.3 - this.air * 1.2, z + Math.cos(this.yaw) * 4)
    // Corkscrew: ride inside the tube behind the car, rolling with the ribbon.
    const onCork = !!car && car.cork >= 0 && car.wreck <= 0
    if (onCork && car) {
      const cf = track.corkFrame(track.corks[car.cork], car.loc.s, car.loc.d, this.cf)
      this.cn.set(cf.nx, cf.ny, cf.nz)
      this.cfw.set(cf.fx, cf.fy, cf.fz)
    }
    this.corkW += ((onCork ? 1 : 0) - this.corkW) * (1 - Math.exp(-dt * (onCork ? 5 : 2.5)))
    if (this.corkW < 0.002) this.corkW = 0
    const cw = this.corkW * this.corkW * (3 - 2 * this.corkW)
    if (cw > 0) {
      const back = CONFIG.camera.distance + clamp(speed / 70, 0, 1) * 1.2
      const lift = CONFIG.camera.height + 0.2
      const cx = x - this.cfw.x * back + this.cn.x * lift
      const cy = y - this.cfw.y * back + this.cn.y * lift
      const cz = z - this.cfw.z * back + this.cn.z * lift
      want.set(lerp(want.x, cx, cw), lerp(want.y, cy, cw), lerp(want.z, cz, cw))
      this.look.set(
        lerp(this.look.x, x + this.cfw.x * 6 + this.cn.x * 1.1, cw),
        lerp(this.look.y, y + this.cfw.y * 6 + this.cn.y * 1.1, cw),
        lerp(this.look.z, z + this.cfw.z * 6 + this.cn.z * 1.1, cw),
      )
    }
    this.pos.lerp(want, 1 - Math.exp(-dt * (cw > 0.2 ? 20 : 14)))
    this.camera.position.copy(this.pos)
    if (this.shake > 0.001) {
      const s = this.shake * 0.35
      this.camera.position.x += (Math.random() - 0.5) * s
      this.camera.position.y += (Math.random() - 0.5) * s
      this.shake *= Math.exp(-dt * 7)
    }
    // Reduced motion keeps the horizon mostly level even upside down.
    const upW = cw * (this.reducedMotion ? 0.35 : 1)
    if (upW > 0) {
      // Slerp from the ribbon normal toward world up (safe even when exactly upside down).
      TO_UP.setFromUnitVectors(this.cn.normalize(), WORLD_UP)
      PART.identity().slerp(TO_UP, 1 - upW)
      this.camera.up.copy(this.cn).applyQuaternion(PART).normalize()
    } else this.camera.up.set(0, 1, 0)
    this.camera.lookAt(this.look)
    // Lean into banked walls (about half the road tilt) so wall rides read as sideways driving.
    let rollTarget = 0
    if (car && !this.reducedMotion && car.wreck <= 0) {
      const i = car.loc.i
      const forward = Math.cos(wrapAngle(car.yaw - track.heading[i])) > 0 ? -1 : 1
      rollTarget = Math.atan(track.bank[i] ?? 0) * forward * (car.grounded ? 0.5 : 0.3)
    }
    rollTarget *= 1 - cw
    this.roll += (rollTarget - this.roll) * (1 - Math.exp(-dt * 3.5))
    if (Math.abs(this.roll) > 1e-4) this.camera.rotateZ(-this.roll)
    const extra = this.reducedMotion ? 0 : clamp(speed / 70, 0, 1) * 10 + (boosting ? 7 : 0) + cw * 6
    this.fov += (CONFIG.camera.fov + extra - this.fov) * (1 - Math.exp(-dt * 4))
    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = this.fov
      this.camera.updateProjectionMatrix()
    }
  }
}
