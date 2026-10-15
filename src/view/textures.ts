import * as THREE from 'three'

/** Procedural canvas textures (no image assets). */
function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

function finish(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  return t
}

let seed = 99
const rand = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}

/**
 * Road paint overlay (transparent where asphalt shows through): curbs, edge lines, lane dashes and
 * darker tyre-worn racing lines. v repeats every 12 m; the asphalt itself is a PBR material.
 */
export function roadTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 1024)
  g.clearRect(0, 0, 512, 1024)
  for (const x of [128, 256, 384]) {
    const grad = g.createLinearGradient(x - 70, 0, x + 70, 0)
    grad.addColorStop(0, 'rgba(22,18,18,0)')
    grad.addColorStop(0.5, 'rgba(22,18,18,0.22)')
    grad.addColorStop(1, 'rgba(22,18,18,0)')
    g.fillStyle = grad
    g.fillRect(x - 70, 0, 140, 1024)
  }
  // Rumble curbs with a slight shadowed bevel.
  for (let k = 0; k < 8; k += 1) {
    g.fillStyle = k % 2 ? '#e9e4da' : '#b8352b'
    g.fillRect(0, k * 128, 22, 128)
    g.fillRect(490, k * 128, 22, 128)
  }
  g.fillStyle = 'rgba(0,0,0,0.25)'
  g.fillRect(20, 0, 3, 1024)
  g.fillRect(489, 0, 3, 1024)
  // Slightly worn edge lines and lane dashes.
  g.fillStyle = 'rgba(236,230,216,0.92)'
  g.fillRect(28, 0, 7, 1024)
  g.fillRect(477, 0, 7, 1024)
  g.fillStyle = 'rgba(236,230,216,0.78)'
  for (const x of [171, 341]) for (let y = 0; y < 1024; y += 512) g.fillRect(x - 3, y, 6, 260)
  // Wear speckle so the paint does not look vector-perfect.
  g.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 2600; i += 1) {
    g.fillStyle = `rgba(0,0,0,${0.25 + rand() * 0.5})`
    g.fillRect(rand() * 512, rand() * 1024, 1 + rand() * 2.5, 1 + rand() * 2.5)
  }
  g.globalCompositeOperation = 'source-over'
  const t = finish(c)
  t.repeat.set(1, 0.5)
  return t
}
export function sandTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128)
  g.fillStyle = '#d7a46c'
  g.fillRect(0, 0, 128, 128)
  for (let i = 0; i < 900; i += 1) {
    const v = rand()
    g.fillStyle = v > 0.5 ? 'rgba(255,220,170,0.35)' : 'rgba(150,90,50,0.3)'
    g.fillRect(rand() * 128, rand() * 128, 2, 2)
  }
  return finish(c)
}

/** Boost pad: bright chevrons with a highlighted perfect-centre strip. */
export function padTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 256)
  g.fillStyle = '#1b1030'
  g.fillRect(0, 0, 128, 256)
  for (let k = 0; k < 4; k += 1) {
    const y = k * 64
    g.fillStyle = k % 2 ? '#ff8a1f' : '#ffd23f'
    g.beginPath()
    g.moveTo(8, y + 56)
    g.lineTo(64, y + 12)
    g.lineTo(120, y + 56)
    g.lineTo(120, y + 36)
    g.lineTo(64, y - 8)
    g.lineTo(8, y + 36)
    g.closePath()
    g.fill()
  }
  g.fillStyle = 'rgba(126,249,255,0.95)'
  g.fillRect(56, 0, 16, 256)
  return finish(c)
}

export function chevronTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 128)
  g.fillStyle = '#1b1030'
  g.fillRect(0, 0, 256, 128)
  g.fillStyle = '#ffcf33'
  for (let k = 0; k < 3; k += 1) {
    const x = 30 + k * 72
    g.beginPath()
    g.moveTo(x, 14)
    g.lineTo(x + 44, 64)
    g.lineTo(x, 114)
    g.lineTo(x + 22, 114)
    g.lineTo(x + 66, 64)
    g.lineTo(x + 22, 14)
    g.closePath()
    g.fill()
  }
  const t = finish(c, false)
  return t
}

export function rampTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 64)
  for (let k = 0; k < 8; k += 1) {
    g.fillStyle = k % 2 ? '#1b1030' : '#ffc233'
    g.beginPath()
    g.moveTo(k * 32, 0)
    g.lineTo(k * 32 + 32, 0)
    g.lineTo(k * 32 + 16, 64)
    g.lineTo(k * 32 - 16, 64)
    g.closePath()
    g.fill()
  }
  return finish(c)
}

export function checkerTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 64)
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 16; x += 1) {
    g.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5'
    g.fillRect(x * 16, y * 16, 16, 16)
  }
  return finish(c)
}

export function bannerTexture(text: string, bg = '#1b1030', fg = '#ffd23f'): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 128)
  g.fillStyle = bg
  g.fillRect(0, 0, 1024, 128)
  g.fillStyle = '#ff6b35'
  g.fillRect(0, 0, 1024, 10)
  g.fillRect(0, 118, 1024, 10)
  g.font = '800 78px Sora, system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = 10
  g.strokeStyle = '#1b1030'
  g.strokeText(text, 512, 68)
  g.fillStyle = fg
  g.fillText(text, 512, 68)
  return finish(c, false)
}

export function gateNumberTexture(n: number): THREE.CanvasTexture {
  const [c, g] = canvas(512, 96)
  g.fillStyle = '#1b1030'
  g.fillRect(0, 0, 512, 96)
  g.font = '800 64px Sora, system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#fff7e8'
  g.fillText(`GATE ${n}`, 256, 52)
  g.fillStyle = '#ff6b35'
  g.fillRect(0, 0, 512, 6)
  g.fillRect(0, 90, 512, 6)
  return finish(c, false)
}

/** Round name tag for cars (player names are drawn as plain canvas text, never HTML). */
export function tagTexture(text: string, color: string): THREE.CanvasTexture {
  const [c, g] = canvas(256, 64)
  g.fillStyle = 'rgba(27,16,48,0.78)'
  const r = 28
  g.beginPath()
  g.roundRect(4, 4, 248, 56, r)
  g.fill()
  g.fillStyle = color
  g.beginPath()
  g.arc(34, 32, 12, 0, Math.PI * 2)
  g.fill()
  g.font = '700 30px Figtree, system-ui, sans-serif'
  g.textBaseline = 'middle'
  g.fillStyle = '#fff7e8'
  g.fillText(text.slice(0, 12), 56, 34)
  return finish(c, false)
}

export function gridTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128)
  g.clearRect(0, 0, 128, 128)
  g.strokeStyle = '#f7f1e4'
  g.lineWidth = 8
  g.strokeRect(10, 10, 108, 108)
  return finish(c, false)
}
