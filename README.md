# Canyon Charge

[![Project checks](https://github.com/ravigayanga2004-droid/Car-Game-Prototype/actions/workflows/ci.yml/badge.svg)](https://github.com/ravigayanga2004-droid/Car-Game-Prototype/actions/workflows/ci.yml)

Playable prototype built with TypeScript, Three.js, and Vite. This repository imports the existing game
in scoped commits, then adds checkout, build, and collaboration improvements.

`main` holds the validated prototype; `develop` is the integration branch. Start new work from `develop`
on a focused `feature/`, `fix/`, or `chore/` branch. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow,
[TODO.md](TODO.md) for the roadmap, and [CHANGELOG.md](CHANGELOG.md) for the repository baseline.

## Quick start

Use Node.js 22.12+ and pnpm 10.18.0 (`npm install --global pnpm@10.18.0`).

```bash
git clone https://github.com/ravigayanga2004-droid/Car-Game-Prototype.git
cd Car-Game-Prototype
pnpm install --frozen-lockfile
pnpm install --dir server --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:3000. The runtime assets and sharing images are committed, so a normal checkout
does not require the original asset-generation environment. The optional raw asset sources remain local.
For PowerShell setup details, see [GITHUB_VSCODE_SETUP.md](GITHUB_VSCODE_SETUP.md).

## Game overview

A stylized low-poly 3D arcade racer (Three.js + TypeScript + Vite). Race equal-performance cars around the supplied
sunlit canyon loop: climbs, switchbacks, a bridge, ridges, canyon walls, ramps, precision boost pads and open
desert. Collect cyan Power Cells during the race, store up to three charges, and spend them on a gold Power Boost.
Chassis and liveries are cosmetic only — every car shares one handling block in `src/game/config.ts`.

### Car line-up
All seven chassis are original designs with invented names, and all are cosmetic only: identical handling
and collision size. No real manufacturer names, model names, logos or badges appear in the game or in its
3D textures.

| # | Chassis | Silhouette |
| --- | --- | --- |
| 0 | Sandvane GT | Long-tail coupe with a towering rear wing |
| 1 | Talusfin | Closed-cockpit prototype with a shark-fin spine |
| 2 | Gullyjack | Compact cup coupe with a short, punchy stance |
| 3 | Basaltback GT | Mid-engine GT with wide rear haunches |
| 4 | Nightmesa | Classic long-tail endurance prototype |
| 5 | Stingbolt | Five-door hot hatch with a honeycomb grille and a roof wing |
| 6 | Scorchquill | Open-wheel single-seater with a cockpit halo and two-plane rear wing |

### House schemes: Stingbolt Yellow and Quill Violet
The Stingbolt and Scorchquill each have a solid (non-metallic) house livery (`finish: 'solid'` in
`src/view/cars.ts`): Stingbolt Yellow (`#d0b200`, black trim, no spine stripe) and Quill Violet (`#4b2a8c`
with bone-white spine stripes). Both are original colour schemes, not copies of any manufacturer's or race
team's colours. The Scorchquill's dark aero panels are anthracite carbon in the texture, so every livery
tints only its white body panels. The Scorchquill is scaled to 2.0 × 0.97 × 5.6 m (W × H × L). Its longer nose
simply overhangs the shared footprint. Check a car in the garage with `CAR=<key> SWATCH=<n> node
scripts/car-check.mjs`.

### IP audit (all cars)
Every chassis was audited for logos and for close resemblance to real cars. All reference renders are
badge-free and the shipped textures contain no text, emblems or decals. Five bodies that echoed well-known
production or racing cars were regenerated from new, original design briefs (Sandvane GT, Gullyjack,
Basaltback GT, Nightmesa, Stingbolt). Each brief names the signature traits to avoid, such as round
"fried-egg" headlights, fastback rear-engine profiles, Y-shaped lights, twin tail fins, and spindle or
three-pointed-star grilles. Talusfin (generic modern prototype) and Scorchquill (generic single-seater
layout) passed as generic. The Scorchquill house livery was changed away from a team-identifying colour
combination.

Garage renders of every car are in `docs/cars/` (`audit-sheet.jpg` shows all seven), next to the
original reference renders (`ref-<key>.jpg`) that each model was generated from.

```bash
pnpm install
pnpm dev            # PORT/HOST from env (the Manus session uses 3000 / 0.0.0.0)
pnpm build          # typecheck + web build + server sim bundle + bundle budget + sharing metadata
pnpm test           # track geometry, deterministic simulation, AI full races, rules
pnpm test:server    # ghost service tests; run pnpm build:server or pnpm build first
pnpm smoke          # headless flow: full solo race to results, split-screen, Track Lab (needs dev server)
pnpm e2e:online     # two browsers race through a local service behind a latency proxy (--delay=75 --full)
```

## Race rules

3 laps × 16 ordered gates = 48 gates, 300-second limit, three-second countdown, three adjacent grid lanes.
Only the first valid forward crossing of the next gate counts. Results offer an instant rematch (R / A) or a
return to the garage.

### Crashes, damage and respawn holds
- Canyon faces, barriers and rails are solid for the whole car body (no clipping through the rock).
- Hitting walls, rivals or obstacles hard, taking item hits, or botching a big landing damages the car
  (hull gauge next to the speedometer). At 35 % it starts smoking, at 70 % it catches fire, and at 100 % it
  explodes, flips and burns for 1.6 s.
- A wrecked car respawns on the spot, repaired, then waits out a **3-second hold** before it can drive.
- Off track or stuck? Press **R** (P2: L, pad: Back / R3) to reset onto the road, which also costs the 3-second
  hold. The hold is the only penalty; no extra time is added to the clock.

### Roller-coaster canyon
The main circuit climbs from 3 m to 88 m above the desert floor and rides over crests and dips of up to 14 m that
throw cars into airtime. Two **mega ramps** (19 m tall, 42 m long kickers with hazard rails and steel back frames)
launch cars as high as ~55 m above the road for over 3 s of hang time. **S-bend twists** snake the road left and
right on the canyon floor, the ridge climb, and past the bridge.

### Corkscrews, Nitro and stored Power

Two boost-fed **corkscrews** roll the road a full 360° around a tube: the lap opener just after the grid
and the desert corkscrew before the finish. Boost pads on the run-in and inside the roll feed speed; the
car is anchored to the ribbon only by centripetal force, so arriving too slow means dropping off the
ceiling (with damage). Steel gantries, radial struts and a CORKSCREW · KEEP SPEED arch mark each entry,
and the chase camera rolls with the ribbon (reduced-motion keeps the horizon mostly level).

Every car has the same small **nitro**: tap Shift for a 1.4 s blue-flame burst from the exhausts, then an
8 s cooldown shown on the NITRO gauge (READY / FIRING / seconds). Drift boosts, completed tricks and
perfect pads shorten the recharge. During the race, six glowing **Power Cells** sit on the racing line. Drive
through one to bank a charge (up to three shown as POWER pips beside the speedometer), then tap Shift to fire a
short gold **Power Boost** before Nitro. A collected charge respawns after 5.5 s so the mechanic is useful every lap.

### Banked walls: magnetic roads
Banked corners and twists tilt the road up to near-vertical, but the tilt is visual: every banked or twisted
road is **magnetic**. The tyres hold at any speed, so a car that stalls, crashes or crawls on a steep slope
never slides down or peels off. It simply drives on as if the road were flat. Speed still presses the car
into the bank (the HUD gauge shows the extra g as **WALL RIDE**), and the bank still adds a little turn-in.
Roller-coaster hills, crests and ramps are unchanged, and corkscrew ribbons keep their own rail physics:
arrive too slow and you still drop off the ceiling. The switch is `car.bankMagnet` in `src/game/config.ts`.
Setting it to `false` restores the old speed-based anchoring (below the anchor speed the car slides down the
bank and peels off near-vertical walls). Six corners are banked 32°–64°, steepest where each corner is tightest.
The Track Lab generator adds banks on its tightest corners and twists away from ramp landings. Its Twist and Hills sliders scale both.


### Corner assist (Off / Light / Strong, Strong by default)

Settings → **Corner assist · P1** and **Corner assist · P2** each pick **Off**, **Light** or **Strong**
(saved per browser; defaults Strong/Strong). P1 applies to solo, Track Lab test drives and online
ghost races; P2 applies to the second split-screen driver, so a newcomer can keep assist on while a
practised player turns it off. Changes made from the pause menu apply immediately. Older saves
with the previous on/off switch migrate to Strong (on) or Off.

It lives in `src/sim/assist.ts` as a pure, deterministic input shaper applied to the player's own
steering/throttle/brake *before* online quantisation and recording, so it never changes any car
stat and online re-simulation stays exact. The mode maps to one blend value
(`ASSIST_STRENGTH`: Off 0, Light 0.5, Strong 1). Strong:

- blends too-weak steering in a bend toward the line that follows the road at your current lane
  (straights and deliberate lane changes against the bend are left alone);
- steers back inward when you drift toward the edge of the asphalt;
- lifts throttle (then brakes lightly) when you arrive at a corner far too fast — never below a
  banked wall's anchor speed, never ahead of a corkscrew, never during nitro.

Light applies half the steering and edge correction and only lifts off at a much larger
overspeed, never braking. Off is an exact no-op. Drifts, airtime, corkscrew rails, respawn holds
and recovery are untouched. The HUD shows an **ASSIST LIGHT/STRONG** chip per player view that
lights up while it is correcting (hidden for Off).

**Assist markers.** Any race or lap in which a player drove with assist on (Light or Strong) gets
a small **ASSIST** tag on the results table, per-lap splits, NEW BEST/BEST LAP badges, garage
personal bests and the Track Lab list. Saved bests record `totalAssist` / `lapAssist` for the
record that is currently held. The tag is informational only; assisted times still count as bests.

## Modes

| Mode | Racers | Notes |
| --- | --- | --- |
| Solo | You + 2 AI rivals | Items on/off, AI skill, main circuit or saved Track Lab layouts |
| Split-Screen | 2 local players + 1 AI | Shared keyboard (WASD / arrows) or one gamepad per player |
| Track Lab | Custom layouts | Size, twist, hills, width, walls, ramps, pads, item rows; share codes; test drive or race AI |
| Online Ghosts | Up to 3 players | Room codes / invite links, contact-free ghosts, service-verified results |

## Controls

| Action | Keyboard P1 | Keyboard P2 | Gamepad |
| --- | --- | --- | --- |
| Throttle / brake | W / S | ↑ / ↓ | RT or A / LT or X |
| Steer | A / D | ← / → | Left stick |
| Drift / air trick | Space | Right Shift or / | RB / LB |
| Boost / Power (tap; Power first, Nitro fallback) | Left Shift | . | B |
| Item | E | , | Y |
| Reset to road (3 s hold) | R | L | Back / R3 |
| Pause | Esc / P | Esc / P | Start |

Touch devices get a steering pad plus gas, brake, drift, boost, item and reset buttons.

## Architecture

| Path | Role |
| --- | --- |
| `src/sim/` | Deterministic gameplay only: track model and gates (`track.ts`, `tracks.ts`), vehicle (`car.ts`), race + items + drafting (`race.ts`), rules (`rules.ts`), AI (`ai.ts`), online codec (`netcodec.ts`). No DOM, no three.js. |
| `src/view/` | Presentation: canyon world with PBR triplanar materials and sky dome (`world.ts`, `materials.ts`), photoreal cars with livery shader (`cars.ts`), generated props (`props.ts`), chase camera, instanced billboard particles and item visuals (`fx.ts`). |
| `src/game/` | `session.ts` connects sim ↔ views/audio/online ghosts; `app.ts` owns tracks, worlds and flows; `config.ts`/`tuning.ts` hold shared tuning. |
| `src/engine/` | Loop, renderer (quality presets, split viewports), staged asset loader (`assets.ts`: boot → race → extra, busy-aware pausing), input (keyboard halves, gamepads, touch), sample + streamed-music audio with synth fallback, save. |
| `src/ui/` | Menus, garage, HUD, results, touch controls (HTML/CSS) and the screen-space UI particle layer (`uifx.ts`). |
| `src/net/ghostnet.ts` | Online client: discovery via `multiplayer/bootstrap.json`, rooms, clock sync, input upload, ghosts, resync, reconnect. |
| `server/` | Node + `ws` ghost service (see `server/README.md`). `server/lib/sim.mjs` is generated from `src/sim` by `pnpm build:server`. |

Rules for changes: gameplay state changes only inside `src/sim` fixed steps; views, UI, audio and networking
read state and events but never write it. Keep race rules pure and unit tested.

Online ghosts never touch the owner's simulation: each client runs its own one-car race and uploads quantized
inputs; the service re-simulates every seat with the same bundled rules, sends position checksums (the client
resyncs on mismatch) and publishes bounded ghost frames and final results.

## Online deployment

The imported project's deployment notes record the user unit `canyon-ghost-v1.service`
(`~/services/canyon-ghost-v1/current`, loopback port 8791) behind the existing nginx HTTPS proxy:
`https://34.21.249.159/ghost-v1/healthz` and `wss://34.21.249.159/ghost-v1/ws`. `ALLOWED_ORIGINS` in
`~/services/canyon-ghost-v1/ghost.env` lists the published game origin and the preview origin. Update by
unpacking a new release beside the old one, re-pointing `current`, restarting the unit and re-checking health
and WSS. Client and service must ship the same `src/sim` build.

These are historical deployment details, not a verified current service status. Local development and
CI do not require this remote service. Configure `public/multiplayer/bootstrap.json` for your own
deployment and follow [server/README.md](server/README.md) to run a local service.

## Preview Tweak

`src/game/tuning.ts` is this game's parameter manager; `config.ts` owns source defaults and the active
configuration. Handling and race parameters are `GAMEPLAY`; camera parameters are `COSMETIC`. `LIVE`
parameters are read on the next simulation step; `NEXT_RUN` parameters (AI pace, item respawn) activate in
`App.startRace`. Register through `scripts/manus-tuning/adapter.js` only under `import.meta.env.DEV`; keep the
Vite plugin and `scripts/__manus__/` helpers intact — production builds exclude the adapter and bridge.

Apply changes preview state only; Save with Manus edits `DEFAULT_CONFIG`. The manager latches
`tuning.unranked` when non-default gameplay values become active and resets it at the next race start;
unranked races never save personal bests. The online service always simulates the source defaults, so a tuned
preview racing online is continuously resynced to the service's authoritative result.

## Credits and asset pipeline
Fonts: Sora, Figtree — SIL Open Font License 1.1 (see `public/fonts/*-OFL.txt`). Libraries: three.js (MIT), ws (MIT).

| Asset | Source |
| --- | --- |
| Cars, boulders, spires, cacti, seeker, mine | AI-generated 3D (reference renders by GPT Image 2 → Higgsfield/Tripo image/text-to-3D), optimised with glTF-Transform |
| Stingbolt | Original badge-free reference render by GPT Image 2.5 (white body, honeycomb grille, no logos, transparent) → Higgsfield `tripo_h3_1_image_to_3d` (40k faces, detailed PBR textures) → glTF-Transform (0.89 MB). Scaled per axis to 2.02 × 1.41 × 4.45 m (W incl. mirrors × H × L) |
| Scorchquill | Reference render by GPT Image 2.5 (orange panels white, carbon anthracite, no logos, transparent) → Higgsfield `tripo_h3_1_image_to_3d` (40k faces, detailed PBR textures) → glTF-Transform (0.87 MB). Scaled per axis to 2.0 × 0.97 × 5.6 m |
| Rock, cliff, sand, asphalt PBR textures | Manus game asset catalog (Poly Haven, CC0) |
| Start gantry, light towers | Manus game asset catalog |
| Sky panorama, loading background, logo, particle sprites, item icons, OG cover, favicon | AI-generated (GPT Image 2) |
| Music (title, race, final lap, results) | AI-generated (Lyria) |
| SFX | AI-generated (ElevenLabs); synthesized fallback in `src/engine/audio.ts` |

`scripts/build-assets.py` turns the raw sources (not committed: `assets/catalog`, `assets/src-art`, raw `assets/src-3d`) into the committed runtime files in `public/assets`. The design brief lives in `docs/concept-proposal.md`.
