// Carga semanas de datos simulados en Supabase pasando por la función "ingesta"
// (la misma ruta que usa el equipo). Sirve para ver la app llena antes de tener datos reales.
//
//   node scripts/cargar-datos-prueba.mjs --url https://<ref>.supabase.co --token <TOKEN> --equipo prueba-1 --dias 28
//
// Recomendación: usar un equipo de PRUEBA (p. ej. "prueba-1") con su propio token, para no
// mezclar con los datos reales de "linea-1". Los seq empiezan en 1.000.000.000 para no
// chocar con los del equipo real.
import { simularDia } from '../web/src/demo/simulador.ts'
import { inicioDia, sumarDias } from '../web/src/lib/tiempo.ts'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const url = arg('url'), token = arg('token'), equipo = arg('equipo', 'prueba-1')
const dias = Number(arg('dias', 28)), semilla = Number(arg('semilla', 20261115))
const sinBloques = process.argv.includes('--sin-bloques')
if (!url || !token) {
  console.error('Faltan --url y --token. Ej: node scripts/cargar-datos-prueba.mjs --url https://xxxx.supabase.co --token ABC --equipo prueba-1 --dias 28')
  process.exit(1)
}

const ahora = Date.now()
const hoy = inicioDia(ahora)
let seq = 1_000_000_000
const eventos = []
for (let i = dias; i >= 0; i--) {
  const d = i === 0 ? hoy : inicioDia(sumarDias(hoy + 12 * 3600e3, -i))
  const r = simularDia({ equipoId: equipo, semilla, diaInicio: d, indiceTemporada: (dias - i) / dias, seqInicio: seq, forzarActivoEn: i === 0 ? ahora : undefined })
  seq = r.seqFin
  for (const e of r.eventos) if (e.ts <= ahora && !(sinBloques && e.tipo === 'bloque')) eventos.push(e)
}
console.log(`${eventos.length} eventos de ${dias + 1} días para "${equipo}". Enviando en lotes de 500…`)

let insertados = 0, t0 = Date.now()
for (let i = 0; i < eventos.length; i += 500) {
  const lote = eventos.slice(i, i + 500).map(e => ({ ...e, equipo_id: equipo, ts: new Date(e.ts).toISOString() }))
  for (let intento = 1; ; intento++) {
    const r = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/ingesta`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-equipo-token': token }, body: JSON.stringify(lote),
    })
    if (r.ok) { insertados += (await r.json()).insertados; break }
    const txt = await r.text()
    if (r.status === 401 || intento >= 4) { console.error(`Error ${r.status}: ${txt}`); process.exit(1) }
    await new Promise(res => setTimeout(res, 1000 * intento))
  }
  if ((i / 500) % 20 === 0) process.stdout.write(`\r${Math.min(i + 500, eventos.length)} / ${eventos.length}`)
}
console.log(`\nListo: ${insertados} insertados en ${((Date.now() - t0) / 1000).toFixed(0)} s.`)
