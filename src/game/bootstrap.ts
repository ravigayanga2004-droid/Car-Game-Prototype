import { assets } from '../engine/assets'
import { Audio } from '../engine/audio'
import { Input } from '../engine/input'
import { GameLoop } from '../engine/loop'
import { Renderer, suggestQuality } from '../engine/renderer'
import { SAVE_KEY, SaveStore, type Device, type SaveData } from '../engine/save'
import { GhostNet } from '../net/ghostnet'
import { sanitizeName } from '../sim/netcodec'
import { TouchControls } from '../ui/touch'
import { Ui } from '../ui/ui'
import { App, MAIN_TRACK, type RaceConfig } from './app'

function keyHints(device: Device, input: Input): { item: string; boost: string } {
  if (device === 'kbLeft') return { item: 'E', boost: 'L-SHIFT' }
  if (device === 'kbRight') return { item: ',', boost: '.' }
  if (device === 'pad0' || device === 'pad1') return { item: 'Y', boost: 'B' }
  if (input.method === 'gamepad') return { item: 'Y', boost: 'B' }
  if (input.method === 'touch') return { item: 'ITEM', boost: 'BOOST' }
  return { item: 'E', boost: 'SHIFT' }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export async function startGame(progress: (p: number) => void): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!
  const firstRun = safeGet(SAVE_KEY) === null
  const save = new SaveStore()
  if (firstRun) save.update({ quality: suggestQuality() })
  const input = new Input()
  const audio = new Audio()
  const net = new GhostNet()
  const renderer = new Renderer(canvas, save.data.quality)
  assets.maxAnisotropy = Math.min(8, renderer.gl.capabilities.getMaxAnisotropy())
  // Boot stage = title essentials only (logo + menu blips). Everything else streams afterwards.
  const bootOff = assets.onProgress((stage, done, total) => {
    if (stage === 'boot') progress(0.1 + (done / total) * 0.25)
  })
  await Promise.race([assets.load('boot'), new Promise(r => setTimeout(r, 6000))])
  bootOff()
  // Start the first race's assets right away; set dressing follows once they are in.
  assets.prefetch('race')
  assets.onProgress((stage, done, total) => {
    if (stage === 'race' && done >= total) {
      audio.warm()
      assets.prefetch('extra')
    }
  })
  progress(0.35)

  let ui!: Ui
  let loop!: GameLoop
  const app = new App(renderer, input, audio, save, net, {
    popup: (v, text, kind) => ui.hud.popup(v, text, kind),
    juice: (v, kind, value) => ui.hud.juice(v, kind, value),
    loading: text => ui.loading(text),
    localFinished: () => {},
    finished: (rows, cfg, bests) => {
      if (cfg.mode === 'online') {
        if (net.results) ui.showOnlineResults(net.results, net.race?.track ?? 'main', false)
        else ui.showOnlineResults([], net.race?.track ?? 'main', true)
        return
      }
      ui.showResults(rows, cfg, bests)
    },
  })

  const apply = (d: SaveData) => {
    audio.setVolumes(d.musicVolume, d.sfxVolume, d.muted)
    app.reducedMotion = d.reducedMotion
    app.assistModes = [d.assistP1, d.assistP2]
    if (app.session) {
      app.session.reducedMotion = d.reducedMotion
      app.session.assistModes[0] = d.assistP1
      app.session.assistModes[1] = d.assistP2
      for (const cam of app.session.cams) cam.shakeEnabled = d.cameraShake
    }
  }

  const enterRace = () => {
    const s = app.session
    if (!s) return
    const d = save.data
    for (const cam of s.cams) cam.shakeEnabled = d.cameraShake
    s.fx.setBudget(d.quality === 'low' ? 0.45 : d.quality === 'medium' ? 0.75 : 1)
    const names = s.humans.map(h => s.racers[h].name)
    const keys = s.humans.map(h => keyHints(s.racers[h].device ?? 'auto', input))
    ui.hud.setup(s, names, keys, !d.controlsSeen)
    if (!d.controlsSeen) save.update({ controlsSeen: true })
    ui.show('hud')
    loop.resetAccumulator()
  }

  const startRace = async (cfg: RaceConfig) => {
    audio.unlock()
    await app.startRace(cfg)
    enterRace()
  }

  const pause = () => {
    if (app.mode !== 'race' || ui.screen !== 'hud') return
    app.pause()
    ui.pauseNote(!!app.session?.online)
    ui.show('pause')
  }

  const resume = () => {
    if (app.mode !== 'paused') return
    app.resume()
    ui.show('hud')
    loop.resetAccumulator()
  }

  const toGarage = (keepOnline = false) => {
    app.toGarage()
    if (keepOnline && net.status === 'connected') {
      ui.refreshOnline()
      ui.show('online')
    } else {
      if (net.status !== 'idle') net.disconnect()
      ui.show('garage')
    }
  }

  ui = new Ui(app, save, audio, input, net, {
    settings: patch => {
      const qualityChanged = patch.quality !== undefined && patch.quality !== save.data.quality
      if (patch.playerName !== undefined) patch.playerName = sanitizeName(patch.playerName)
      save.update(patch)
      apply(save.data)
      if (qualityChanged) {
        renderer.applyQuality(save.data.quality)
        app.setQuality()
      }
      if (net.status === 'connected' && (patch.chassis !== undefined || patch.livery !== undefined || patch.playerName !== undefined)) {
        net.updateProfile({ name: save.data.playerName, chassis: save.data.chassis, livery: save.data.livery })
      }
    },
    startRace: cfg => void startRace(cfg),
    rematch: () => {
      if (app.config?.mode === 'online') return toGarage(true)
      if (app.config) void startRace(app.config)
    },
    garage: () => toGarage(false),
    resume,
    restart: () => {
      if (app.config && app.config.mode !== 'online') void startRace(app.config)
    },
    online: room => {
      audio.unlock()
      void net.connect(room, { name: save.data.playerName, chassis: save.data.chassis, livery: save.data.livery })
    },
    leaveOnline: () => net.disconnect(),
  })
  ui.show('boot')
  apply(save.data)

  net.onChange = () => ui.refreshOnline()
  net.onRaceStart = r => {
    const track = app.refFromOnline(r.track)
    void app.startRace({ mode: 'online', track, items: false, aiSkill: 'relaxed' }, r).then(enterRace)
  }
  net.onResults = rows => {
    if (app.config?.mode === 'online' && (app.mode === 'results' || ui.screen === 'results')) ui.showOnlineResults(rows, net.race?.track ?? 'main', false)
  }

  // Build the main canyon behind the boot bar so the title already shows the world.
  progress(0.5)
  await app.worldFor(MAIN_TRACK)
  progress(0.9)
  await app.enterGarage()
  progress(1)

  if (import.meta.env.DEV) {
    const [{ registerGameTuning }, { tuning }] = await Promise.all([import('../../scripts/manus-tuning/adapter.js'), import('./tuning')])
    await registerGameTuning(tuning)
  }

  let heat = 0
  loop = new GameLoop({
    step: () => app.step(),
    render: (alpha, dt) => {
      input.update()
      if (input.consume('pause')) {
        if (app.mode === 'race' && ui.screen === 'hud') pause()
        else if (app.mode === 'paused' && ui.screen === 'pause' && !ui.modalOpen) resume()
      }
      ui.frame(dt)
      loop.paused = app.mode === 'paused' && !app.session?.online
      app.render(alpha, dt)
      const s = app.session
      // Pause optional prefetch while the race heats up (many effects on screen or slow frames).
      heat = heat * 0.9 + (app.mode === 'race' && s ? Math.min(2, s.fx.activeCount / 260 + (dt > 1 / 45 ? 0.6 : 0)) : 0) * 0.1
      assets.setBusy(heat > 0.55)
      if (s && (ui.screen === 'hud' || ui.screen === 'pause')) {
        ui.hud.update(s, save.data.reducedMotion)
        if (s.online) {
          const others = [...net.ghostFrames().keys()].filter(k => k !== net.seat).length
          ui.hud.setOnline(net.status === 'connected' ? `ROOM ${net.room} · ${net.latency} ms · ${others} ghost${others === 1 ? '' : 's'}` : net.message)
        } else ui.hud.setOnline('')
      }
    },
  })
  loop.start()

  const unlockAudio = () => {
    audio.unlock()
    audio.setMusic(app.mode === 'race' || app.mode === 'paused' ? 'race' : app.mode === 'results' ? 'results' : 'menu')
    window.removeEventListener('pointerdown', unlockAudio)
    window.removeEventListener('keydown', unlockAudio)
  }
  window.addEventListener('pointerdown', unlockAudio)
  window.addEventListener('keydown', unlockAudio)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause()
  })
  window.addEventListener('game:pause', pause)
  new TouchControls(document.getElementById('ui')!, input, () => app.mode === 'race' && ui.screen === 'hud' && (app.session?.humans.length ?? 0) === 1)
  window.setTimeout(() => ui.show('title'), 200)
  // Read-only debug hook for smoke tests.
  ;(window as unknown as { __game: unknown }).__game = { app, ui, input, save, net }
}
