/**
 * All gameplay tuning in one place. Every car reads the same `car` block: chassis and livery
 * choices are cosmetic only and never reach the simulation.
 */
export const DEFAULT_CONFIG = {
  car: {
    /** Top speed on asphalt (m/s). */
    maxSpeed: 58,
    accel: 30,
    brake: 50,
    reverseSpeed: 14,
    coastDrag: 5,
    /** Yaw rate (rad/s) at low and at top speed. */
    turnLow: 2.3,
    turnHigh: 0.9,
    /** Lateral grip (1/s). Higher = less slide. */
    grip: 9,
    driftGrip: 2.6,
    driftBase: 1.15,
    driftSteer: 0.7,
    driftMinSpeed: 17,
    boostSpeed: 74,
    boostAccel: 38,
    /** Nitro burst length (s) fired by one tap of Shift. */
    nitroTime: 1.4,
    /** Seconds for an empty nitro to recharge (skill — drift boosts, tricks, perfect pads — shortens it). */
    nitroCooldown: 8,
    /** Extra acceleration (m/s²) while the nitro burns: a short, sharp kick. */
    nitroAccel: 26,
    /** Stored Power charge burst length (s) fired by Shift after collecting a Power Cell. */
    powerTime: 1.6,
    /** Extra acceleration (m/s²) while a stored Power charge burns. */
    powerAccel: 20,
    /** Lateral speed (m/s) when steering across a corkscrew ribbon. */
    corkSteer: 7,
    draftBonus: 6,
    gravity: 30,
    airTurn: 1.3,
    /** Speed cap multiplier on the sand shoulder. */
    shoulderFactor: 0.7,
    /** Upward kick from a ramp lip, as a fraction of forward speed. */
    rampKick: 0.27,
    /** Vertical launch per m/s of speed off a mega ramp. */
    megaKick: 0.52,
    /** Extra top speed (m/s) per unit of downhill grade — roller-coaster descents. */
    downhillBonus: 26,
    /** Tyre grip on banked roads as a fraction of the normal force (speed presses the car in). */
    bankGrip: 0.9,
    /**
     * Magnetic banked roads: every banked or twisted road holds the car at any speed, so it never
     * slides down or peels off the slope and drives as if the road were flat (the tilt is visual).
     * Corkscrew ribbons keep their own rail physics. Set false to restore speed-based anchoring.
     */
    bankMagnet: true,
    /** Extra yaw rate (rad/s) at top speed on a fully tilted bank (the road carries the turn). */
    bankTurn: 0.8,
  },
  race: {
    /** AI cornering pace multiplier (same car, different driving line). */
    aiPace: 1,
    /** Seconds before a broken item crystal reappears. */
    itemRespawn: 3,
  },
  camera: {
    fov: 68,
    distance: 7.4,
    height: 2.7,
    follow: 9,
  },
} as const
// Gameplay always reads active values here. Source defaults remain immutable for
// Tweak Reset and Save with Manus; Apply never writes source or local storage.
type MutableConfig<T> = { -readonly [K in keyof T]: T[K] extends number ? number : T[K] extends object ? MutableConfig<T[K]> : T[K] }
export const CONFIG: MutableConfig<typeof DEFAULT_CONFIG> = structuredClone(DEFAULT_CONFIG)
