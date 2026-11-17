import { DIA, claveDia, diaDesdeClave, inicioDia, sumarDias, type Paso } from './tiempo'

export type TipoRango = 'hoy' | 'ayer' | 'semana' | 'mes' | 'temporada' | 'personalizado'

export interface Rango { tipo: TipoRango; desde: number; hasta: number; etiqueta: string }

export const NOMBRES_RANGO: Record<TipoRango, string> = {
  hoy: 'Hoy', ayer: 'Ayer', semana: '7 días', mes: '30 días', temporada: 'Temporada', personalizado: 'Fechas',
}

/** Construye el rango [desde, hasta) en hora de Santiago. */
export function construirRango(tipo: TipoRango, ahora: number, extra: { primerDato?: number | null; desde?: string; hasta?: string } = {}): Rango {
  const hoy0 = inicioDia(ahora)
  switch (tipo) {
    case 'hoy': return { tipo, desde: hoy0, hasta: ahora, etiqueta: 'Hoy' }
    case 'ayer': return { tipo, desde: sumarDias(hoy0, -1), hasta: hoy0, etiqueta: 'Ayer' }
    // Semana y mes son móviles (incluyen hoy): siempre muestran datos, también un lunes temprano o un día 1
    case 'semana': return { tipo, desde: sumarDias(hoy0, -6), hasta: ahora, etiqueta: 'Últimos 7 días' }
    case 'mes': return { tipo, desde: sumarDias(hoy0, -29), hasta: ahora, etiqueta: 'Últimos 30 días' }
    case 'temporada': {
      const d = extra.primerDato ? inicioDia(extra.primerDato) : sumarDias(hoy0, -30)
      return { tipo, desde: d, hasta: ahora, etiqueta: 'Temporada' }
    }
    case 'personalizado': {
      const d = extra.desde ? diaDesdeClave(extra.desde) : sumarDias(hoy0, -6)
      const h = extra.hasta ? sumarDias(diaDesdeClave(extra.hasta), 1) : sumarDias(hoy0, 1)
      return { tipo, desde: Math.min(d, h - DIA), hasta: Math.min(h, Math.max(ahora, d + DIA)), etiqueta: 'Fechas elegidas' }
    }
  }
}

/** Periodo anterior equivalente para comparar (null si no aplica). */
export function rangoAnterior(r: Rango): Rango | null {
  switch (r.tipo) {
    case 'hoy': return { tipo: r.tipo, desde: sumarDias(r.desde, -1), hasta: sumarDias(r.hasta, -1), etiqueta: 'Ayer a la misma hora' }
    case 'ayer': return { tipo: r.tipo, desde: sumarDias(r.desde, -1), hasta: sumarDias(r.hasta, -1), etiqueta: 'Anteayer' }
    case 'semana': return { tipo: r.tipo, desde: sumarDias(r.desde, -7), hasta: sumarDias(r.hasta, -7), etiqueta: '7 días anteriores' }
    case 'mes': return { tipo: r.tipo, desde: sumarDias(r.desde, -30), hasta: sumarDias(r.hasta, -30), etiqueta: '30 días anteriores' }
    case 'temporada': return null
    case 'personalizado': {
      const dias = Math.round((r.hasta - r.desde) / DIA)
      return { tipo: r.tipo, desde: sumarDias(r.desde, -dias), hasta: r.desde, etiqueta: `${dias} días anteriores` }
    }
  }
}

/** Pasos que tienen sentido para el largo del rango (el primero es el sugerido). */
export function pasosPara(r: Rango): Paso[] {
  const dias = (r.hasta - r.desde) / DIA
  if (dias <= 2) return ['hour']
  if (dias <= 14) return ['day', 'hour']
  if (dias <= 62) return ['day', 'week']
  return ['week', 'day', 'month']
}

export const NOMBRES_PASO: Partial<Record<Paso, string>> = { hour: 'Por hora', day: 'Por día', week: 'Por semana', month: 'Por mes' }

export const claveInput = (ms: number) => claveDia(ms)
