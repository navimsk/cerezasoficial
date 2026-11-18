// Fuente de datos simulada: misma interfaz que Supabase, para ver la app llena sin backend.
import type { Atasco, ConfigEquipo, Equipo, Escuchar, Evento, FranjaProyeccion, FuenteDatos, Punto, ResumenVivo, SaludEquipo } from '../datos/tipos'
import { DIA, MIN, claveDia, inicioDia, minutoDelDia, sumarDias, truncar, siguiente, type Paso } from '../lib/tiempo'
import { simularDia } from './simulador'

const EQUIPO: Equipo = { id: 'linea-1', nombre: 'Línea 1', largo_caja_mm: 505, vel_cinta_mm_s: 292.3, aprender_vel: true }
const DIAS_HISTORIA = 45
const SEMILLA = 20261115

interface Dia { inicio: number; seqInicio: number; indice: number; nocturno?: boolean }
interface Agg { cajas: number; estimadas: number; ajustes: number; atascos: number }

export class FuenteDemo implements FuenteDatos {
  readonly modo = 'demo' as const
  private minutos = new Map<number, Agg>()      // epoch minuto → agregado
  private dias: Dia[] = []
  private atascosLista: Atasco[] = []
  private hoyEventos: Evento[] = []              // eventos del día de hoy (incluye futuros)
  private revelados = 0                          // cuántos de hoyEventos ya "ocurrieron"
  private recientes: Evento[] = []               // eventos ya ocurridos de ayer y hoy
  private oyentes = new Set<Escuchar>()
  private reloj: ReturnType<typeof setInterval> | null = null
  private primer: number | null = null

  constructor() {
    const ahora = Date.now()
    const hoy = inicioDia(ahora)
    let seq = 1
    for (let i = DIAS_HISTORIA; i >= 0; i--) {
      const inicio = i === 0 ? hoy : inicioDia(sumarDias(hoy + 12 * 3_600_000, -i))
      const indice = (DIAS_HISTORIA - i) / DIAS_HISTORIA
      const dia: Dia = { inicio, seqInicio: seq, indice, nocturno: i === 1 && ahora - hoy < 4 * 3_600_000 }
      this.dias.push(dia)
      const r = simularDia({
        equipoId: EQUIPO.id, semilla: SEMILLA, diaInicio: inicio, indiceTemporada: indice, seqInicio: seq,
        forzarActivoEn: i === 0 ? ahora : undefined,
        hastaMedianoche: i === 1 && ahora - hoy < 4 * 3_600_000,
      })
      seq = r.seqFin
      if (i === 0) { this.hoyEventos = r.eventos; continue }
      for (const e of r.eventos) this.acumular(e)
      if (i === 1) this.recientes.push(...r.eventos)
      if (this.primer === null && r.eventos.length) this.primer = r.eventos[0].ts
    }
    this.revelarHasta(ahora, false)
  }

  private acumular(e: Evento) {
    if (e.tipo === 'atasco_inicio') {
      const previo = this.recientesAjuste(e)
      this.atascosLista.push({ equipo_id: e.equipo_id, inicio: e.ts, fin: null, durMs: null, cajasRevertidas: previo })
    } else if (e.tipo === 'atasco_fin') {
      const a = [...this.atascosLista].reverse().find(x => x.fin === null)
      if (a) { a.fin = e.ts; a.durMs = e.ts - a.inicio }
    }
    if (e.n === 0 && e.tipo !== 'atasco_inicio') return
    const k = Math.floor(e.ts / MIN) * MIN
    let a = this.minutos.get(k)
    if (!a) { a = { cajas: 0, estimadas: 0, ajustes: 0, atascos: 0 }; this.minutos.set(k, a) }
    a.cajas += e.n
    if (e.tipo === 'caja_est') a.estimadas += e.n
    if (e.tipo === 'ajuste') a.ajustes += -e.n
    if (e.tipo === 'atasco_inicio') a.atascos += 1
    this.ultimoAjuste = e.tipo === 'ajuste' ? e : this.ultimoAjuste
  }
  private ultimoAjuste: Evento | null = null
  private recientesAjuste(e: Evento): number {
    const a = this.ultimoAjuste
    return a && e.ts - a.ts < 5000 ? -a.n : 0
  }

  private revelarHasta(t: number, emitir: boolean) {
    while (this.revelados < this.hoyEventos.length && this.hoyEventos[this.revelados].ts <= t) {
      const e = this.hoyEventos[this.revelados++]
      this.acumular(e)
      this.recientes.push(e)
      if (this.primer === null) this.primer = e.ts
      if (emitir) for (const o of this.oyentes) o(e)
    }
  }

  private iniciarReloj() {
    if (this.reloj) return
    this.reloj = setInterval(() => this.revelarHasta(Date.now(), true), 500)
  }

  private sumar(desde: number, hasta: number): Agg {
    const r: Agg = { cajas: 0, estimadas: 0, ajustes: 0, atascos: 0 }
    for (let m = Math.floor(desde / MIN) * MIN; m < hasta; m += MIN) {
      const a = this.minutos.get(m)
      if (a) { r.cajas += a.cajas; r.estimadas += a.estimadas; r.ajustes += a.ajustes; r.atascos += a.atascos }
    }
    return r
  }

  async equipos() { return [{ ...EQUIPO }] }
  async guardarConfigEquipo(_id: string, c: ConfigEquipo) { Object.assign(EQUIPO, c) }

  async resumenVivo(_equipoId: string): Promise<ResumenVivo> {
    const ahora = Date.now()
    this.revelarHasta(ahora, true)
    const hoy0 = inicioDia(ahora)
    const ayer = sumarDias(ahora, -1), semAnt = sumarDias(ahora, -7)
    const hoy = this.sumar(hoy0, ahora)
    const ultimaCaja = [...this.recientes].reverse().find(e => e.n > 0)?.ts ?? null
    const ultimo = this.recientes.at(-1)?.ts ?? null
    // ritmo habitual: misma franja de ±15 min en los 14 días anteriores con actividad
    const muestras: number[] = []
    for (let d = 1; d <= 14; d++) {
      const c = sumarDias(ahora, -d)
      const s = this.sumar(c - 15 * MIN, c + 15 * MIN).cajas
      if (s > 0) muestras.push(s / 30)
    }
    const enAtasco = (() => {
      for (let i = this.recientes.length - 1; i >= 0; i--) {
        const t = this.recientes[i].tipo
        if (t === 'atasco_fin') return false
        if (t === 'atasco_inicio') return true
      }
      return false
    })()
    return {
      ahora,
      hoy: hoy.cajas,
      ayerMismaHora: this.sumar(inicioDia(ayer), ayer).cajas,
      semanaAnteriorMismaHora: this.sumar(inicioDia(semAnt), semAnt).cajas,
      ultimaHora: this.sumar(ahora - 60 * MIN, ahora).cajas,
      ritmo10: this.sumar(ahora - 10 * MIN, ahora).cajas / 10,
      ritmoHabitual: muestras.length >= 3 ? muestras.reduce((a, b) => a + b, 0) / muestras.length : null,
      ultimaCaja, ultimoContacto: ultimo,
      atascosHoy: hoy.atascos, ajustesHoy: hoy.ajustes,
      enAtasco,
    }
  }

  async serie(_equipoId: string, desde: number, hasta: number, paso: Paso): Promise<Punto[]> {
    this.revelarHasta(Date.now(), true)
    const puntos: Punto[] = []
    for (let t = truncar(desde, paso); t < hasta; t = siguiente(t, paso)) {
      const fin = Math.min(siguiente(t, paso), hasta)
      const a = this.sumar(Math.max(t, desde), fin)
      puntos.push({ inicio: t, ...a })
    }
    return puntos
  }

  async eventos(_equipoId: string, desde: number, hasta: number, limite = 5000): Promise<Evento[]> {
    const out: Evento[] = []
    const hoy0 = inicioDia(Date.now())
    for (const d of this.dias) {
      if (d.inicio + DIA <= desde || d.inicio >= hasta) continue
      let evs: Evento[]
      if (d.inicio === hoy0) evs = this.hoyEventos.slice(0, this.revelados)
      else evs = simularDia({ equipoId: EQUIPO.id, semilla: SEMILLA, diaInicio: d.inicio, indiceTemporada: d.indice, seqInicio: d.seqInicio, hastaMedianoche: d.nocturno }).eventos
      for (const e of evs) if (e.ts >= desde && e.ts < hasta) out.push(e)
    }
    return out.slice(-limite)
  }

  async atascos(_equipoId: string, desde: number, hasta: number): Promise<Atasco[]> {
    return this.atascosLista.filter(a => a.inicio >= desde && a.inicio < hasta)
  }

  async salud(): Promise<SaludEquipo[]> {
    const r = await this.resumenVivo(EQUIPO.id)
    const hb = [...this.recientes].reverse().find(e => e.tipo === 'heartbeat' || e.tipo === 'inicio')
    const desde = Date.now() - DIA
    const ult24 = this.recientes.filter(e => e.ts >= desde)
    let faltan = 0
    if (ult24.length) {
      const mn = Math.min(...ult24.map(e => e.seq)), mx = Math.max(...ult24.map(e => e.seq))
      faltan = Math.max(0, mx - mn + 1 - ult24.length)
    }
    const sinContacto = !r.ultimoContacto || Date.now() - r.ultimoContacto > 2 * MIN
    return [{
      equipo: EQUIPO,
      estado: !r.ultimoContacto ? 'sin_datos' : sinContacto ? 'sin_conexion' : r.enAtasco ? 'atasco' : 'operando',
      ultimoContacto: r.ultimoContacto,
      estadoReportado: hb?.extra?.estado ?? null,
      haz: hb?.extra?.haz ?? null,
      rssi: hb?.extra?.rssi ?? null,
      pendientes: hb?.extra?.pendientes ?? null,
      velMmS: hb?.vel_mm_s ?? null,
      uptimeS: hb?.extra?.uptime_s ?? null,
      seqFaltantes24h: faltan,
      atascosHoy: r.atascosHoy,
      ajustesHoy: r.ajustesHoy,
      filtrados: hb?.extra?.filtrados ?? null,
    }]
  }

  async primerDato() { return this.primer }

  async datosProyeccion(_equipoId: string, dias: number): Promise<FranjaProyeccion[]> {
    this.revelarHasta(Date.now(), true)
    const desde = inicioDia(sumarDias(Date.now(), -dias))
    const mapa = new Map<string, FranjaProyeccion>()
    for (const [m, a] of this.minutos) {
      if (m < desde || a.cajas === 0) continue
      const dia = claveDia(m), franja = Math.floor(minutoDelDia(m) / 15)
      const k = `${dia}|${franja}`
      const f = mapa.get(k)
      if (f) f.cajas += a.cajas
      else mapa.set(k, { dia, franja, cajas: a.cajas })
    }
    return [...mapa.values()].sort((x, y) => (x.dia === y.dia ? x.franja - y.franja : x.dia < y.dia ? -1 : 1))
  }

  suscribir(_equipoId: string, cb: Escuchar) {
    this.oyentes.add(cb)
    this.iniciarReloj()
    return () => { this.oyentes.delete(cb) }
  }
}
