import type { Device, SaveData } from '../engine/save'
import type { RaceConfig } from '../game/app'
import type { LabParams } from '../sim/tracks'
import { LIVERIES } from '../view/cars'
import { LAPS, MAX_RACE_TIME, RECOVERY_PENALTY, TOTAL_GATES } from './format'

export type Screen = 'boot' | 'title' | 'garage' | 'solo' | 'split' | 'lab' | 'online' | 'hud' | 'pause' | 'results'

export interface UiActions {
  settings(patch: Partial<SaveData>): void
  startRace(cfg: RaceConfig): void
  rematch(): void
  garage(): void
  resume(): void
  restart(): void
  online(room: string): void
  leaveOnline(): void
}

const DEVICE_LABEL: Record<Device, string> = { auto: 'Any device', kbLeft: 'Keyboard — WASD', kbRight: 'Keyboard — Arrows', pad0: 'Gamepad 1', pad1: 'Gamepad 2' }
const MODE_INFO = [
  { id: 'solo', title: 'Solo Race', text: 'You vs two AI rivals. 3 laps, 48 gates, fair items.', icon: '1P' },
  { id: 'split', title: 'Split-Screen', text: 'Two players on one screen plus one AI rival.', icon: '2P' },
  { id: 'lab', title: 'Track Lab', text: 'Shape a custom canyon loop and test-drive it.', icon: 'LAB' },
  { id: 'online', title: 'Online Ghosts', text: 'Race up to three players as ghosts — no contact, pure driving.', icon: 'NET' },
] as const

function swatch(i: number, sel: number, attr: string): string {
  const l = LIVERIES[i]
  return `<button type="button" class="swatch${i === sel ? ' sel' : ''}" data-${attr}="${i}" style="--a:${l.primary};--b:${l.secondary}" aria-label="${l.name} livery" title="${l.name}"></button>`
}

function slider(key: keyof LabParams, label: string, min: number, max: number, step: number): string {
  return `<label class="slider">${label}<input type="range" min="${min}" max="${max}" step="${step}" data-lab="${key}" /><output data-lab-out="${key}"></output></label>`
}

function range(key: 'musicVolume' | 'sfxVolume', label: string): string {
  return `<label class="slider">${label}<input type="range" min="0" max="1" step="0.05" data-set="${key}" /><output data-set-out="${key}"></output></label>`
}

export function uiTemplate(): string {
  const modes = MODE_INFO.map(m => `<button type="button" class="mode-card" data-mode="${m.id}"${m.id === 'solo' ? ' data-autofocus' : ''}><span class="mode-icon">${m.icon}</span><span class="mode-title">${m.title}</span><span class="mode-text">${m.text}</span></button>`).join('')
  return `
  <section class="screen" data-screen="boot"><div class="boot"><img class="boot-icon" src="${import.meta.env.BASE_URL}share/favicon.png" alt="" width="112" height="112" /><div class="logo small boot-logo" role="img" aria-label="Canyon Charge"><span>Canyon</span><b>Charge</b></div><div class="boot-bar"><i data-boot></i></div><p>Charging the canyon…</p></div></section>

  <section class="screen" data-screen="title">
    <div class="title-wrap">
      <div class="logo" role="img" aria-label="Canyon Charge"><span>Canyon</span><b>Charge</b></div>
      <p class="tagline">Collect power. Charge your boost. Own the canyon.</p>
      <button type="button" class="btn primary big" data-act="enter">Start Engine</button>
      <p class="press">Press <kbd>Enter</kbd> or <kbd>A</kbd></p>
    </div>
  </section>

  <section class="screen" data-screen="garage">
    <header class="topbar"><div class="logo tiny" role="img" aria-label="Canyon Charge"><span>Canyon</span><b>Charge</b></div><div class="grow"></div>
      <button type="button" class="btn ghost" data-act="controls">Controls</button><button type="button" class="btn ghost" data-act="settings">Settings</button></header>
    <div class="garage">
      <div class="panel ride">
        <h2>Your Ride</h2>
        <div class="carousel"><button type="button" class="btn icon" data-act="prevCar" aria-label="Previous chassis">◀</button><div class="car-name"><b data-g="chassis"></b><small data-g="blurb"></small></div><button type="button" class="btn icon" data-act="nextCar" aria-label="Next chassis">▶</button></div>
        <div class="swatches" data-g="swatches"></div>
        <div class="livery-name" data-g="livery"></div>
        <label class="field">Driver name<input type="text" maxlength="14" data-g="name" autocomplete="off" spellcheck="false" /></label>
        <p class="fair">Every chassis has identical grip, acceleration, top speed, boost and handling. Looks only.</p>
      </div>
      <div class="modes">${modes}</div>
      <div class="panel bests" data-g="bests"></div>
    </div>
  </section>

  <section class="screen" data-screen="solo">
    <div class="setup panel">
      <h2>Solo Race</h2><p class="sub">You vs two AI rivals · ${LAPS} laps · ${TOTAL_GATES} gates · ${MAX_RACE_TIME} s limit</p>
      <div class="row"><span class="label">Track</span><div class="choices" data-s="tracks"></div></div>
      <div class="row"><span class="label">Rivals</span><div class="seg" data-s="skill"><button type="button" data-v="relaxed">Relaxed</button><button type="button" data-v="pro">Pro</button></div></div>
      <div class="row"><span class="label">Items</span><div class="seg" data-s="items"><button type="button" data-v="on">On</button><button type="button" data-v="off">Off</button></div></div>
      <div class="actions"><button type="button" class="btn" data-act="back">Back</button><button type="button" class="btn primary" data-act="goSolo" data-autofocus>Race!</button></div>
    </div>
  </section>

  <section class="screen" data-screen="split">
    <div class="setup panel wide">
      <h2>Split-Screen</h2><p class="sub">Two local players plus one AI rival. Pick a device for each player.</p>
      <div class="players">
        <div class="pcard"><h3>Player 1</h3><div class="carousel"><button type="button" class="btn icon" data-act="p1Prev" aria-label="Previous chassis">◀</button><div class="car-name"><b data-sp="c1"></b></div><button type="button" class="btn icon" data-act="p1Next" aria-label="Next chassis">▶</button></div><div class="swatches" data-sp="s1"></div><label class="field">Controls<select data-sp="d1"></select></label></div>
        <div class="pcard"><h3>Player 2</h3><div class="carousel"><button type="button" class="btn icon" data-act="p2Prev" aria-label="Previous chassis">◀</button><div class="car-name"><b data-sp="c2"></b></div><button type="button" class="btn icon" data-act="p2Next" aria-label="Next chassis">▶</button></div><div class="swatches" data-sp="s2"></div><label class="field">Controls<select data-sp="d2"></select></label></div>
      </div>
      <div class="row"><span class="label">Track</span><div class="choices" data-sp="tracks"></div></div>
      <div class="row"><span class="label">Items</span><div class="seg" data-sp="items"><button type="button" data-v="on">On</button><button type="button" data-v="off">Off</button></div></div>
      <p class="note" data-sp="note"></p>
      <div class="actions"><button type="button" class="btn" data-act="back">Back</button><button type="button" class="btn primary" data-act="goSplit" data-autofocus>Race!</button></div>
    </div>
  </section>

  <section class="screen" data-screen="lab">
    <div class="setup panel wide lab">
      <h2>Track Lab</h2><p class="sub">Every layout keeps 16 ordered gates per lap. Shape it, check it, then test-drive or race it.</p>
      <div class="lab-grid">
        <div class="lab-controls">
          <label class="field">Track name<input type="text" maxlength="24" data-l="name" autocomplete="off" spellcheck="false" /></label>
          ${slider('size', 'Size', 0.7, 1.3, 0.05)}
          ${slider('twist', 'Twist', 0, 1, 0.05)}
          ${slider('hills', 'Hills', 0, 1, 0.05)}
          ${slider('width', 'Road width', 16, 24, 1)}
          ${slider('canyon', 'Canyon walls', 0, 1, 0.05)}
          ${slider('ramps', 'Ramps', 0, 4, 1)}
          ${slider('pads', 'Boost pads', 0, 10, 1)}
          ${slider('items', 'Item rows', 0, 4, 1)}
          <div class="lab-seed"><span>Seed <b data-l="seed"></b></span><button type="button" class="btn small" data-act="labRandom">New layout</button></div>
        </div>
        <div class="lab-preview">
          <canvas width="360" height="360" data-l="map"></canvas>
          <div class="lab-check" data-l="check"></div>
          <div class="lab-code"><span>Share code</span><code data-l="code"></code><button type="button" class="btn small" data-act="labCopy">Copy</button></div>
          <div class="lab-import"><input type="text" placeholder="Paste a share code" data-l="import" autocomplete="off" spellcheck="false" /><button type="button" class="btn small" data-act="labImport">Load</button></div>
        </div>
        <div class="lab-saved"><h3>Saved tracks</h3><div data-l="saved"></div></div>
      </div>
      <div class="actions"><button type="button" class="btn" data-act="back">Back</button><button type="button" class="btn" data-act="labSave">Save</button><button type="button" class="btn" data-act="labRace">Race vs AI</button><button type="button" class="btn primary" data-act="labTest" data-autofocus>Test Drive</button></div>
    </div>
  </section>

  <section class="screen" data-screen="online">
    <div class="setup panel wide">
      <h2>Online Ghosts</h2><p class="sub">Up to three racers share a room. Everyone drives their own race; rivals appear as ghosts with no contact and no items. The service re-simulates every run to confirm results.</p>
      <div class="online-join" data-o="join">
        <div class="row"><button type="button" class="btn primary" data-act="onCreate" data-autofocus>Create room</button><span class="or">or</span><input type="text" maxlength="6" placeholder="ROOM CODE" data-o="code" autocomplete="off" spellcheck="false" /><button type="button" class="btn" data-act="onJoin">Join</button></div>
      </div>
      <div class="online-lobby" data-o="lobby"></div>
      <p class="net-status" data-o="status"></p>
      <div class="actions"><button type="button" class="btn" data-act="onBack">Back</button></div>
    </div>
  </section>

  <section class="screen" data-screen="hud"></section>

  <section class="screen" data-screen="pause">
    <div class="modal panel">
      <h2>Paused</h2><p class="sub" data-p="note"></p>
      <div class="stack"><button type="button" class="btn primary" data-act="resume" data-autofocus>Resume</button><button type="button" class="btn" data-act="restart">Restart race</button><button type="button" class="btn" data-act="controls">Controls</button><button type="button" class="btn" data-act="settings">Settings</button><button type="button" class="btn" data-act="quit">Quit to garage</button></div>
    </div>
  </section>

  <section class="screen" data-screen="results">
    <div class="modal panel results"><div data-r="body"></div>
      <div class="actions"><button type="button" class="btn" data-act="toGarage">Garage</button><button type="button" class="btn" data-act="editLab" data-r="edit">Edit track</button><button type="button" class="btn primary" data-act="rematch" data-autofocus data-r="rematch">Rematch</button></div>
    </div>
  </section>

  <div class="overlay" data-modal="settings"><div class="modal panel">
    <h2>Settings</h2>
    ${range('musicVolume', 'Music')}${range('sfxVolume', 'Sound effects')}
    <label class="check"><input type="checkbox" data-set="muted" /> Mute all audio</label>
    <div class="row"><span class="label">Graphics</span><div class="seg" data-set="quality"><button type="button" data-v="low">Low</button><button type="button" data-v="medium">Medium</button><button type="button" data-v="high">High</button></div></div>
    <label class="check"><input type="checkbox" data-set="reducedMotion" /> Reduced motion (no speed lines or FOV kick)</label>
    <label class="check"><input type="checkbox" data-set="cameraShake" /> Camera shake</label>
    <div class="row"><span class="label">Corner assist · P1</span><div class="seg" data-set="assistP1"><button type="button" data-v="off">Off</button><button type="button" data-v="light">Light</button><button type="button" data-v="strong">Strong</button></div></div>
    <div class="row"><span class="label">Corner assist · P2</span><div class="seg" data-set="assistP2"><button type="button" data-v="off">Off</button><button type="button" data-v="light">Light</button><button type="button" data-v="strong">Strong</button></div></div>
    <p class="hint small">Steering and entry-speed help in bends. P1 covers solo and online; P2 is the second split-screen driver. Assisted times are tagged <em class="assist-tag">ASSIST</em>.</p>
    <div class="actions"><button type="button" class="btn primary" data-act="closeModal">Done</button></div>
  </div></div>

  <div class="overlay" data-modal="controls"><div class="modal panel controls">
    <h2>Controls</h2>
    <table>
      <tr><th></th><th>Player 1 / Solo</th><th>Player 2</th><th>Gamepad</th></tr>
      <tr><td>Throttle</td><td><kbd>W</kbd> (<kbd>↑</kbd> solo)</td><td><kbd>↑</kbd></td><td>RT or A</td></tr>
      <tr><td>Brake / reverse</td><td><kbd>S</kbd></td><td><kbd>↓</kbd></td><td>LT or X</td></tr>
      <tr><td>Steer</td><td><kbd>A</kbd> <kbd>D</kbd></td><td><kbd>←</kbd> <kbd>→</kbd></td><td>Left stick / D-pad</td></tr>
      <tr><td>Drift (hold) · air trick (tap)</td><td><kbd>Space</kbd></td><td><kbd>R-Shift</kbd> <kbd>/</kbd> <kbd>Num0</kbd></td><td>RB or LB</td></tr>
      <tr><td>Boost / Power (tap)</td><td><kbd>L-Shift</kbd></td><td><kbd>.</kbd> <kbd>Num1</kbd></td><td>B</td></tr>
      <tr><td>Use item</td><td><kbd>E</kbd></td><td><kbd>,</kbd> <kbd>Num2</kbd></td><td>Y</td></tr>
      <tr><td>Reset to road (${RECOVERY_PENALTY} s hold)</td><td><kbd>R</kbd></td><td><kbd>L</kbd> <kbd>Num3</kbd></td><td>Back / R3</td></tr>
      <tr><td>Pause</td><td colspan="2"><kbd>Esc</kbd> or <kbd>P</kbd></td><td>Start</td></tr>
    </table>
    <ul class="tips">
      <li><b>Launch:</b> press throttle in the last half-second of the countdown for a perfect start. Too early spins the wheels.</li>
      <li><b>Drift:</b> hold drift while steering at speed. Sparks change colour as the charge builds — release for a mini, super or ultra turbo.</li>
      <li><b>Pads:</b> hit the glowing centre stripe of a boost pad for a longer perfect boost.</li>
      <li><b>Air:</b> steer in the air, tap drift to flip. Land a completed trick for boost; land mid-trick and you spin.</li>
      <li><b>Slipstream:</b> tuck in behind a rival to charge a draft boost.</li>
      <li><b>Power Cells:</b> drive through the glowing cyan crystals during the race to bank up to three charges. Your POWER pips sit beside the speedometer.</li>
      <li><b>Power Boost:</b> tap the boost key with a stored charge for a gold speed burst. If no Power is stored, the same key fires the regular Nitro meter.</li>
      <li><b>Corkscrews:</b> the boost pads on the run-in and inside the roll keep you pinned. Too slow at the top and you fall off — save a Power Boost or Nitro for the entry.</li>
      <li><b>Items:</b> every threat is announced. Change lanes when a Seeker locks on, or raise a Shield. Armed mines blink red.</li>
    </ul>
    <div class="actions"><button type="button" class="btn primary" data-act="closeModal">Got it</button></div>
  </div></div>

  <div class="overlay loading" data-loading><div class="spinner"></div><p data-loading-text>Loading…</p></div>
  <div class="toast" data-toast role="status" aria-live="polite"></div>`
}

export { DEVICE_LABEL, MODE_INFO, swatch }
