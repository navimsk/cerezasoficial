// Fechas y horas en zona America/Santiago, sin dependencias.
// Todos los instantes se manejan como milisegundos epoch (UTC).

export const TZ = 'America/Santiago'
export const MIN = 60_000
export const HORA = 3_600_000
export const DIA = 86_400_000

export interface Partes { y: number; m: number; d: number; h: number; min: number; s: number; dow: number }

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
})
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

const cacheOffset = new Map<number, number>()

/** Desfase de Santiago respecto a UTC en minutos (p. ej. -180 en verano). Cacheado por hora. */
export function desfaseMin(ms: number): number {
  const k = Math.floor(ms / HORA)
  const c = cacheOffset.get(k)
  if (c !== undefined) return c
  const p = partesSinCache(k * HORA)
  const comoUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s)
  const off = Math.round((comoUtc - k * HORA) / MIN)
  if (cacheOffset.size > 20_000) cacheOffset.clear()
  cacheOffset.set(k, off)
  return off
}

function partesSinCache(ms: number): Partes {
  const o: Record<string, string> = {}
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, s: +o.second, dow: DOW[o.weekday] }
}

/** Partes de la hora local de Santiago (rápido: usa el desfase cacheado). */
export function partes(ms: number): Partes {
  const local = new Date(ms + desfaseMin(ms) * MIN)
  return {
    y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate(),
    h: local.getUTCHours(), min: local.getUTCMinutes(), s: local.getUTCSeconds(), dow: local.getUTCDay(),
  }
}

/** Instante UTC de una hora local de Santiago. Acepta desbordes (d = 32, h = 25…). */
export function desdeLocal(y: number, m: number, d: number, h = 0, min = 0): number {
  const supuesto = Date.UTC(y, m - 1, d, h, min)
  let t = supuesto - desfaseMin(supuesto) * MIN
  const off2 = desfaseMin(t)
  t = supuesto - off2 * MIN
  return t
}

export function inicioDia(ms: number): number {
  const p = partes(ms)
  return desdeLocal(p.y, p.m, p.d)
}

/** Lunes 00:00 de la semana local. */
export function inicioSemana(ms: number): number {
  const p = partes(ms)
  const delta = (p.dow + 6) % 7
  return desdeLocal(p.y, p.m, p.d - delta)
}

export function inicioMes(ms: number): number {
  const p = partes(ms)
  return desdeLocal(p.y, p.m, 1)
}

export function inicioHora(ms: number): number {
  const p = partes(ms)
  return desdeLocal(p.y, p.m, p.d, p.h)
}

/** Suma días calendario conservando la hora local. */
export function sumarDias(ms: number, n: number): number {
  const p = partes(ms)
  return desdeLocal(p.y, p.m, p.d + n, p.h, p.min) + (ms % MIN)
}

/** Minutos transcurridos desde la medianoche local. */
export function minutoDelDia(ms: number): number {
  const p = partes(ms)
  return p.h * 60 + p.min
}

/** Clave de día local 'AAAA-MM-DD'. */
export function claveDia(ms: number): string {
  const p = partes(ms)
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

export function diaDesdeClave(clave: string): number {
  const [y, m, d] = clave.split('-').map(Number)
  return desdeLocal(y, m, d)
}

export type Paso = 'minute' | 'hour' | 'day' | 'week' | 'month'

/** Inicio del intervalo que contiene ms, para el paso dado. */
export function truncar(ms: number, paso: Paso): number {
  switch (paso) {
    case 'minute': return Math.floor(ms / MIN) * MIN
    case 'hour': return inicioHora(ms)
    case 'day': return inicioDia(ms)
    case 'week': return inicioSemana(ms)
    case 'month': return inicioMes(ms)
  }
}

/** Siguiente inicio de intervalo. */
export function siguiente(ms: number, paso: Paso): number {
  const p = partes(ms)
  switch (paso) {
    case 'minute': return ms + MIN
    case 'hour': return desdeLocal(p.y, p.m, p.d, p.h + 1)
    case 'day': return desdeLocal(p.y, p.m, p.d + 1)
    case 'week': return desdeLocal(p.y, p.m, p.d + 7)
    case 'month': return desdeLocal(p.y, p.m + 1, 1)
  }
}
