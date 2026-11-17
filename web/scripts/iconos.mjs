// Genera los íconos PNG de la PWA sin dependencias (dibujo por campos de distancia).
//   node scripts/iconos.mjs
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const FONDO = [0x9e, 0x1b, 0x34]
const TRAZO = [0xfb, 0xfa, 0xf7]

// Geometría en un lienzo de 1 x 1 (centro 0,5). "zona" = 0,8 para ícono maskable (área segura).
function glifo(x, y, zona) {
  const s = zona, ox = 0.5 - s / 2, oy = 0.5 - s / 2
  const X = (x - ox) / s, Y = (y - oy) / s   // coordenadas dentro del glifo
  const circ = (cx, cy, r) => Math.hypot(X - cx, Y - cy) - r
  const seg = (ax, ay, bx, by, w) => {
    const px = X - ax, py = Y - ay, dx = bx - ax, dy = by - ay
    const h = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)))
    return Math.hypot(px - dx * h, py - dy * h) - w
  }
  const d = Math.min(
    circ(0.34, 0.68, 0.16),
    circ(0.68, 0.72, 0.16),
    seg(0.36, 0.53, 0.55, 0.22, 0.028),
    seg(0.66, 0.57, 0.55, 0.22, 0.028),
    seg(0.55, 0.22, 0.72, 0.17, 0.05),   // hoja
  )
  return d * s   // distancia en unidades del lienzo
}

function png(tam, zona, redondeo) {
  const filas = []
  for (let j = 0; j < tam; j++) {
    const fila = Buffer.alloc(1 + tam * 4)
    for (let i = 0; i < tam; i++) {
      const x = (i + 0.5) / tam, y = (j + 0.5) / tam
      // fondo (con esquinas redondeadas opcionales)
      let alfaFondo = 1
      if (redondeo > 0) {
        const r = redondeo, qx = Math.abs(x - 0.5) - (0.5 - r), qy = Math.abs(y - 0.5) - (0.5 - r)
        const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
        alfaFondo = Math.max(0, Math.min(1, 0.5 - dist * tam))
      }
      const a = Math.max(0, Math.min(1, 0.5 - glifo(x, y, zona) * tam))
      const c = FONDO.map((f, k) => Math.round(f * (1 - a) + TRAZO[k] * a))
      fila[1 + i * 4] = c[0]; fila[2 + i * 4] = c[1]; fila[3 + i * 4] = c[2]
      fila[4 + i * 4] = Math.round(alfaFondo * 255)
    }
    filas.push(fila)
  }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (tipo, data) => {
    const t = Buffer.from(tipo), len = Buffer.alloc(4), c = Buffer.alloc(4)
    len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(tam, 0); ihdr.writeUInt32BE(tam, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(filas))), chunk('IEND', Buffer.alloc(0)),
  ])
}

writeFileSync('public/icono-192.png', png(192, 0.78, 0.18))
writeFileSync('public/icono-512.png', png(512, 0.78, 0.18))
writeFileSync('public/icono-maskable-512.png', png(512, 0.62, 0))
writeFileSync('public/apple-touch-icon.png', png(180, 0.7, 0))
writeFileSync('public/favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="18" fill="#9e1b34"/>
<g transform="translate(11 11) scale(0.78)" fill="#fbfaf7" stroke="#fbfaf7" stroke-linecap="round">
<circle cx="34" cy="68" r="16" stroke="none"/><circle cx="68" cy="72" r="16" stroke="none"/>
<path d="M36 53 55 22M66 57 55 22" fill="none" stroke-width="5.6"/><path d="M55 22 72 17" stroke-width="10"/>
</g></svg>`)
console.log('íconos generados en public/')
