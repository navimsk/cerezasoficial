// Simulador de datos de prueba realistas para el contador de cajas.
// Determinista (misma semilla → mismos datos). Lo usan el modo demo de la app y
// scripts/generar-datos.ts (que produce un .sql para cargar en Supabase).
//
// Modelo de un día de packing:
//  - El equipo se enciende a mano al empezar (evento "inicio") y se apaga al terminar.
//  - Ritmo base de 14–22 cajas/min que varía con la temporada y el día; arranque lento,
//    colación (sin cajas), 0–3 paradas cortas, baja al final del día.
//  - ~14 % de las llegadas son trenes de 2–4 cajas pegadas (caja + caja_est).
//  - ~1,6 atascos por día de 1–8 min; a veces precedidos de un "ajuste" que revierte cajas estimadas.
//  - Heartbeat cada 30 s mientras está encendido. A veces se pierde algún evento (salto de seq).
import type { Evento, TipoEvento } from '../datos/tipos.ts'
import { DIA, MIN, desdeLocal, partes } from '../lib/tiempo.ts'

export function rng(semilla: number) {
  let a = semilla >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export interface PlanDia {
  activo: boolean
  encendido: number
  apagado: number
  pausas: Array<[number, number]>
  baseCpm: number
}

export interface OpcionesDia {
  equipoId: string
  semilla: number
  diaInicio: number        // epoch ms de la medianoche local
  indiceTemporada: number  // 0..1 (avance de la temporada, para la curva de volumen)
  seqInicio: number
  /** Si se indica, el día se extiende para que haya actividad alrededor de este instante (demo en vivo). */
  forzarActivoEn?: number
  /** Turno nocturno: el día queda activo y sigue hasta la medianoche (demo de madrugada). */
  hastaMedianoche?: boolean
}

export function planDia(o: OpcionesDia): PlanDia {
  const p = partes(o.diaInicio + 12 * 3_600_000)
  const r = rng(hash(`${o.semilla}:${p.y}-${p.m}-${p.d}:plan`))
  const at = (h: number, m: number) => desdeLocal(p.y, p.m, p.d, h, m)
  const prob = p.dow === 0 ? 0.3 : p.dow === 6 ? 0.85 : 0.96
  let activo = r() < prob

  let ini: number, fin: number
  if (p.dow === 0) { ini = at(8, 30) + (r() - 0.5) * 40 * MIN; fin = at(14, 0) + (r() - 0.5) * 120 * MIN }
  else if (p.dow === 6) { ini = at(8, 0) + (r() - 0.5) * 30 * MIN; fin = at(15, 30) + (r() - 0.5) * 120 * MIN }
  else { ini = at(7, 30) + (r() - 0.5) * 30 * MIN; fin = at(20, 30) + (r() * 270 - 120) * MIN }

  const pausas: Array<[number, number]> = []
  if (fin - ini > 6 * 3_600_000) {
    const c = at(13, 15) + (r() * 35 - 15) * MIN
    pausas.push([c, c + (40 + r() * 20) * MIN])
  }
  const nParadas = Math.floor(r() * 4)
  for (let i = 0; i < nParadas; i++) {
    const t = ini + 40 * MIN + r() * Math.max(0, fin - ini - 80 * MIN)
    pausas.push([t, t + (4 + r() * 11) * MIN])
  }

  if (o.hastaMedianoche) { activo = true; fin = o.diaInicio + DIA - 20_000 }
  if (o.forzarActivoEn !== undefined) {
    activo = true
    if (o.forzarActivoEn - o.diaInicio < 4 * 3_600_000) ini = o.diaInicio + 20_000   // madrugada: turno nocturno
    else if (o.forzarActivoEn < ini + 20 * MIN) ini = Math.max(o.diaInicio + 5 * MIN, o.forzarActivoEn - 150 * MIN)
    if (fin < o.forzarActivoEn + 3 * 3_600_000) fin = Math.min(o.diaInicio + DIA - 5 * MIN, o.forzarActivoEn + 4 * 3_600_000)
    // ninguna pausa activa justo ahora: que se vea en vivo
    for (const pz of pausas) if (pz[0] <= o.forzarActivoEn && o.forzarActivoEn < pz[1] + 5 * MIN) { pz[0] = o.forzarActivoEn - 60 * MIN; pz[1] = pz[0] + 30 * MIN }
  }

  const temporada = 0.72 + 0.4 * Math.sin(Math.PI * Math.min(1, Math.max(0, o.indiceTemporada)) * 0.85)
  const baseCpm = 17 * temporada * (0.9 + r() * 0.2) * (p.dow === 6 ? 0.9 : 1)
  return { activo, encendido: ini, apagado: fin, pausas: pausas.sort((a, b) => a[0] - b[0]), baseCpm }
}

/** Factor de ritmo según el momento del día (arranque, post-colación, final) y ruido suave. */
function perfil(t: number, plan: PlanDia, ruido: number[]): number {
  const desdeIni = (t - plan.encendido) / MIN
  const hastaFin = (plan.apagado - t) / MIN
  let f = 1
  if (desdeIni < 25) f *= 0.5 + 0.5 * (desdeIni / 25)
  if (hastaFin < 40) f *= 0.65 + 0.35 * (hastaFin / 40)
  for (const [, b] of plan.pausas) {
    const tras = (t - b) / MIN
    if (tras >= 0 && tras < 20) f *= 0.8 + 0.2 * (tras / 20)
  }
  const h = partes(t).h
  if (h === 16) f *= 0.92
  f *= ruido[Math.floor(desdeIni / 15) % ruido.length] ?? 1
  return f
}

export interface ResultadoDia { plan: PlanDia; eventos: Evento[]; seqFin: number }

export function simularDia(o: OpcionesDia): ResultadoDia {
  const plan = planDia(o)
  const eventos: Evento[] = []
  if (!plan.activo) return { plan, eventos, seqFin: o.seqInicio }

  const p = partes(o.diaInicio + 12 * 3_600_000)
  const r = rng(hash(`${o.semilla}:${p.y}-${p.m}-${p.d}:eventos`))
  const ruido = Array.from({ length: 96 }, () => 0.88 + r() * 0.24)
  let seq = o.seqInicio
  let total = 0
  let filtrados = 0
  const vel = Math.round(480 + r() * 40)
  const largo = 450
  const durCaja = (largo / vel) * 1000

  type Crudo = Omit<Evento, 'equipo_id' | 'seq'>
  const crudos: Crudo[] = []
  const push = (e: Crudo) => crudos.push(e)

  // Atascos programados
  const nAtascos = Math.floor(-Math.log(1 - r()) * 1.6 + r() * 0.5)
  const atascos: Array<[number, number, number]> = []  // [inicio, fin, cajasRevertidas]
  for (let i = 0; i < nAtascos; i++) {
    const t = plan.encendido + 30 * MIN + r() * Math.max(0, plan.apagado - plan.encendido - 60 * MIN)
    if (plan.pausas.some(([a, b]) => t >= a - MIN && t <= b)) continue
    const dur = (1 + r() * 7) * MIN
    atascos.push([t, t + dur, r() < 0.35 ? 1 + Math.floor(r() * 2) : 0])
  }
  atascos.sort((a, b) => a[0] - b[0])

  const enPausa = (t: number) => plan.pausas.some(([a, b]) => t >= a && t < b)

  push({ tipo: 'inicio', n: 0, ts: Math.round(plan.encendido), total: 0, vel_mm_s: 500, extra: { estado: 'normal', haz: false, rssi: -60, pendientes: 0, filtrados: 0, uptime_s: 2, perdidos_cola: 0 } })

  let t = plan.encendido + 20_000
  let iAtasco = 0
  while (t < plan.apagado) {
    // atasco que empieza antes de la siguiente llegada
    const at = atascos[iAtasco]
    if (at && t >= at[0] - 4000) {
      const [a, b, rev] = at
      if (rev > 0) {
        total += 1
        push({ tipo: 'caja', n: 1, ts: Math.round(a - 3000), dur_ms: 100, avance_mm: 50, cajas: 1, total, vel_mm_s: vel })
        for (let k = 0; k < rev; k++) { total += 1; push({ tipo: 'caja_est', n: 1, ts: Math.round(a - 2000 + k * 900), dur_ms: 1000 + k * 900, avance_mm: largo * (k + 1.6), cajas: k + 2, total, vel_mm_s: vel }) }
        total -= rev
        push({ tipo: 'ajuste', n: -rev, ts: Math.round(a), dur_ms: 4000, avance_mm: largo * 5, cajas: 1, total, vel_mm_s: vel })
      }
      push({ tipo: 'atasco_inicio', n: 0, ts: Math.round(a + 1), dur_ms: 4000, avance_mm: largo * 5, cajas: 1, total, vel_mm_s: vel })
      push({ tipo: 'atasco_fin', n: 0, ts: Math.round(b), dur_ms: Math.round(b - a + 4000), avance_mm: 0, cajas: 1, total, vel_mm_s: vel })
      t = b + 5000 + r() * 10_000
      iAtasco++
      continue
    }
    if (enPausa(t)) {
      const pz = plan.pausas.find(([a0, b0]) => t >= a0 && t < b0)!
      t = pz[1] + r() * 20_000
      continue
    }
    const cpm = plan.baseCpm * perfil(t, plan, ruido)
    // tren de cajas
    const u = r()
    const tren = u < 0.86 ? 1 : u < 0.96 ? 2 : u < 0.99 ? 3 : 4
    total += 1
    push({ tipo: 'caja', n: 1, ts: Math.round(t + 100), dur_ms: 100, avance_mm: Math.round(vel * 0.1), cajas: 1, total, vel_mm_s: vel })
    for (let k = 2; k <= tren; k++) {
      total += 1
      const tk = t + (k - 1 + 0.6) * durCaja
      push({ tipo: 'caja_est', n: 1, ts: Math.round(tk), dur_ms: Math.round((k - 1 + 0.6) * durCaja), avance_mm: largo * (k - 1 + 0.6), cajas: k, total, vel_mm_s: vel })
    }
    const durBloque = tren * durCaja * (0.97 + r() * 0.06)
    push({ tipo: 'bloque', n: 0, ts: Math.round(t + durBloque + 30), dur_ms: Math.round(durBloque), avance_mm: Math.round(vel * durBloque / 1000), cajas: tren, total, vel_mm_s: vel })
    if (r() < 0.03) filtrados++
    // siguiente llegada (proceso de Poisson con separación mínima física)
    const media = (60_000 / Math.max(cpm, 0.5)) * tren
    t += Math.max(durBloque + 300, -Math.log(1 - r()) * media)
  }

  // heartbeats
  for (let h = plan.encendido + 30_000; h < plan.apagado; h += 30_000) {
    const enAt = atascos.some(([a, b]) => h >= a && h < b)
    push({
      tipo: 'heartbeat', n: 0, ts: Math.round(h), total, vel_mm_s: vel,
      extra: {
        estado: enAt ? 'atasco' : 'normal', haz: enAt || r() < 0.25,
        rssi: Math.round(-58 - r() * 14), pendientes: 0, filtrados,
        uptime_s: Math.round((h - plan.encendido) / 1000), perdidos_cola: 0,
      },
    })
  }

  crudos.sort((a, b) => a.ts - b.ts)
  // pérdidas ocasionales: se "pierden" 1–3 eventos no-caja (salto de seq)
  const perder = new Set<number>()
  if (r() < 0.15) {
    const k = 1 + Math.floor(r() * 3)
    for (let i = 0; i < k; i++) {
      const idx = Math.floor(r() * crudos.length)
      if (crudos[idx].n === 0 && crudos[idx].tipo !== 'atasco_inicio' && crudos[idx].tipo !== 'atasco_fin') perder.add(idx)
    }
  }
  // "total" de sesión acorde al orden temporal
  let acum = 0
  crudos.forEach((c, i) => {
    acum += c.n
    if (c.tipo !== 'heartbeat') c.total = acum
    else c.total = acum
    const s = seq++
    if (!perder.has(i)) eventos.push({ equipo_id: o.equipoId, seq: s, ...c })
  })
  return { plan, eventos, seqFin: seq }
}

export const TIPOS_CON_CONTEO: TipoEvento[] = ['caja', 'caja_est', 'ajuste']
