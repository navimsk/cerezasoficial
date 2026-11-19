// Fuente de datos real: RPC y tablas de Supabase (ver supabase/migrations).
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { Atasco, ConfigEquipo, Equipo, Escuchar, Evento, FranjaProyeccion, FuenteDatos, Punto, ResumenVivo, SaludEquipo } from './tipos'
import { supabase } from '../lib/supabase'
import { DIA, HORA, MIN, type Paso } from '../lib/tiempo'

const ms = (v: string | null | undefined) => (v ? Date.parse(v) : null)
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))
const numN = (v: unknown) => (v === null || v === undefined ? null : Number(v))

const COLS_EVENTO = 'equipo_id, seq, tipo, n, ts, dur_ms, avance_mm, cajas, total, vel_mm_s, extra'

function aEvento(r: Record<string, unknown>): Evento {
  return {
    equipo_id: r.equipo_id as string, seq: Number(r.seq), tipo: r.tipo as Evento['tipo'], n: Number(r.n),
    ts: Date.parse(r.ts as string), dur_ms: numN(r.dur_ms), avance_mm: numN(r.avance_mm), cajas: numN(r.cajas),
    total: numN(r.total), vel_mm_s: numN(r.vel_mm_s), extra: (r.extra as Evento['extra']) ?? null,
  }
}

/** Supabase devuelve como máximo 1.000 filas por llamada: se pide por páginas. */
async function paginar<T>(pedir: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, max = 50_000): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < max; i += 1000) {
    const { data, error } = await pedir(i, i + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}

export class FuenteSupabase implements FuenteDatos {
  readonly modo = 'supabase' as const
  private sb = supabase()

  async equipos(): Promise<Equipo[]> {
    const { data, error } = await this.sb.from('equipos').select('id, nombre, largo_caja_mm, vel_cinta_mm_s, aprender_vel, baliza_max_min, hora_cierre').eq('activo', true).order('id')
    if (error) throw new Error(error.message)
    return (data ?? []).map(e => ({ id: e.id, nombre: e.nombre || e.id, largo_caja_mm: e.largo_caja_mm, vel_cinta_mm_s: e.vel_cinta_mm_s, aprender_vel: e.aprender_vel, baliza_max_min: e.baliza_max_min, hora_cierre: e.hora_cierre ? String(e.hora_cierre).slice(0, 5) : null }))
  }

  async guardarConfigEquipo(equipoId: string, c: ConfigEquipo): Promise<void> {
    const { data, error } = await this.sb.from('equipos').update(c).eq('id', equipoId).select('id')
    if (error) throw new Error(error.message)
    if (!data?.length) throw new Error('Sin permiso: solo un administrador puede cambiar la configuración.')
  }

  async resumenVivo(equipoId: string): Promise<ResumenVivo> {
    const { data, error } = await this.sb.rpc('resumen_vivo', { p_equipo: equipoId }).single()
    if (error) throw new Error(error.message)
    const r = data as Record<string, unknown>
    return {
      ahora: Date.parse(r.ahora as string),
      hoy: num(r.hoy), ayerMismaHora: num(r.ayer_misma_hora), semanaAnteriorMismaHora: num(r.semana_anterior_misma_hora),
      ultimaHora: num(r.ultima_hora), ritmo10: num(r.ritmo10), ritmoHabitual: numN(r.ritmo_habitual),
      ultimaCaja: ms(r.ultima_caja as string), ultimoContacto: ms(r.ultimo_contacto as string),
      atascosHoy: num(r.atascos_hoy), ajustesHoy: num(r.ajustes_hoy), enAtasco: !!r.en_atasco,
    }
  }

  async serie(equipoId: string, desde: number, hasta: number, paso: Paso): Promise<Punto[]> {
    // trozos de ≤ 900 intervalos para no chocar con el límite de 1.000 filas
    const tramo = paso === 'minute' ? 900 * MIN : paso === 'hour' ? 900 * HORA : 900 * DIA
    const trozos: Array<[number, number]> = []
    for (let a = desde; a < hasta; a += tramo) trozos.push([a, Math.min(hasta, a + tramo)])
    const partes = await Promise.all(trozos.map(async ([a, b]) => {
      const { data, error } = await this.sb.rpc('serie', {
        p_equipo: equipoId, p_desde: new Date(a).toISOString(), p_hasta: new Date(b).toISOString(), p_paso: paso,
      })
      if (error) throw new Error(error.message)
      return (data ?? []) as Array<Record<string, unknown>>
    }))
    const vistos = new Map<number, Punto>()
    for (const filas of partes) for (const r of filas) {
      const p: Punto = { inicio: Date.parse(r.inicio as string), cajas: num(r.cajas), estimadas: num(r.estimadas), ajustes: num(r.ajustes), atascos: num(r.atascos) }
      const prev = vistos.get(p.inicio)
      if (prev) { prev.cajas += p.cajas; prev.estimadas += p.estimadas; prev.ajustes += p.ajustes; prev.atascos += p.atascos }
      else vistos.set(p.inicio, p)
    }
    return [...vistos.values()].sort((x, y) => x.inicio - y.inicio)
  }

  async eventos(equipoId: string, desde: number, hasta: number, limite = 200_000): Promise<Evento[]> {
    const filas = await paginar<Record<string, unknown>>((a, b) => this.sb.from('eventos').select(COLS_EVENTO)
      .eq('equipo_id', equipoId).gte('ts', new Date(desde).toISOString()).lt('ts', new Date(hasta).toISOString())
      .order('ts').order('seq').range(a, b), limite)
    return filas.map(aEvento)
  }

  async atascos(equipoId: string, desde: number, hasta: number): Promise<Atasco[]> {
    const filas = await paginar<Record<string, unknown>>((a, b) => this.sb.rpc('atascos_rango', {
      p_equipo: equipoId, p_desde: new Date(desde).toISOString(), p_hasta: new Date(hasta).toISOString(),
    }).range(a, b))
    return filas.map(r => ({
      equipo_id: equipoId, inicio: Date.parse(r.inicio as string), fin: ms(r.fin as string),
      durMs: numN(r.dur_ms), cajasRevertidas: num(r.cajas_revertidas),
    }))
  }

  async salud(): Promise<SaludEquipo[]> {
    const { data, error } = await this.sb.rpc('salud_equipos')
    if (error) throw new Error(error.message)
    return ((data ?? []) as Array<Record<string, unknown>>).map(r => {
      const contacto = ms(r.ultimo_contacto as string)
      const sinCon = !contacto || Date.now() - contacto > 2 * MIN
      return {
        equipo: { id: r.equipo_id as string, nombre: (r.nombre as string) || (r.equipo_id as string), largo_caja_mm: num(r.largo_caja_mm) },
        estado: !contacto ? 'sin_datos' : sinCon ? 'sin_conexion' : r.en_atasco ? 'atasco' : 'operando',
        ultimoContacto: contacto,
        estadoReportado: (r.estado_reportado as string) ?? null,
        haz: (r.haz as boolean | null) ?? null,
        rssi: numN(r.rssi), pendientes: numN(r.pendientes), velMmS: numN(r.vel_mm_s), uptimeS: numN(r.uptime_s),
        seqFaltantes24h: num(r.seq_faltantes_24h), atascosHoy: num(r.atascos_hoy), ajustesHoy: num(r.ajustes_hoy),
        filtrados: numN(r.filtrados),
      }
    })
  }

  async primerDato(equipoId: string): Promise<number | null> {
    const { data, error } = await this.sb.rpc('primer_dato', { p_equipo: equipoId })
    if (error) throw new Error(error.message)
    return ms(data as string | null)
  }

  async datosProyeccion(equipoId: string, dias: number): Promise<FranjaProyeccion[]> {
    const filas = await paginar<Record<string, unknown>>((a, b) => this.sb.rpc('datos_proyeccion', { p_equipo: equipoId, p_dias: dias }).range(a, b))
    return filas.map(r => ({ dia: r.dia as string, franja: Number(r.franja), cajas: Number(r.cajas) }))
  }

  suscribir(equipoId: string, cb: Escuchar): () => void {
    const canal: RealtimeChannel = this.sb.channel(`eventos-${equipoId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'eventos', filter: `equipo_id=eq.${equipoId}` },
        p => cb(aEvento(p.new as Record<string, unknown>)))
      .subscribe()
    return () => { this.sb.removeChannel(canal) }
  }
}
