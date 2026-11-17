import { TZ } from './tiempo'

const nf0 = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export const entero = (n: number) => nf0.format(Math.round(n))
export const decimal1 = (n: number) => nf1.format(n)
export const conSigno = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±') + entero(Math.abs(n))
export const porcentaje = (r: number) => (r > 0 ? '+' : r < 0 ? '−' : '±') + nf0.format(Math.abs(r * 100)) + ' %'

const fHora = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const fHoraSeg = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const fDiaCorto = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
const fDiaLargo = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })
const fFecha = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })

const limpiar = (s: string) => s.replace(/\./g, '').replace(/,/g, '')

export const hora = (ms: number) => fHora.format(ms)
export const horaSeg = (ms: number) => fHoraSeg.format(ms)
/** "lun 17 nov" */
export const diaCorto = (ms: number) => limpiar(fDiaCorto.format(ms))
/** "lunes 17 de noviembre" */
export const diaLargo = (ms: number) => fDiaLargo.format(ms).replace(',', '')
export const fecha = (ms: number) => fFecha.format(ms)

/** "hace 4 s", "hace 3 min", "hace 2 h", "hace 3 días" */
export function hace(ms: number, ahora = Date.now()): string {
  const s = Math.max(0, Math.round((ahora - ms) / 1000))
  if (s < 60) return `hace ${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `hace ${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `hace ${h} h`
  return `hace ${Math.floor(h / 24)} días`
}

export function duracion(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60), rs = s % 60
  if (m < 60) return rs ? `${m} min ${rs} s` : `${m} min`
  const h = Math.floor(m / 60), rm = m % 60
  return rm ? `${h} h ${rm} min` : `${h} h`
}
