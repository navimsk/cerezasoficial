// Proyecciones del contador de cajas — lógica pura, sin React ni fechas del sistema.
// Cada método es simple y explicable (se muestra "cómo se calcula" en la pantalla).
//
//  1) Cierre de hoy ............ perfil de los días anteriores, escalado al ritmo de hoy.
//  2) Próximos 7 días .......... promedio exponencial por día de la semana.
//  3) Acumulado de temporada ... promedio diario reciente, extendido hacia adelante.

export const FRANJAS = 96                      // franjas de 15 min en un día

// ---------- utilidades ----------
export function percentil(valores: number[], p: number): number {
  if (!valores.length) return NaN
  const v = [...valores].sort((a, b) => a - b)
  const i = (v.length - 1) * p
  const a = Math.floor(i), b = Math.ceil(i)
  return v[a] + (v[b] - v[a]) * (i - a)
}
export const mediana = (v: number[]) => percentil(v, 0.5)
export const suma = (v: number[]) => v.reduce((a, b) => a + b, 0)
const limitar = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))

/** Cajas acumuladas hasta la franja fraccional f (p. ej. 57,4 = 14:21). */
export function acumuladoHasta(franjas: number[], f: number): number {
  const entera = Math.floor(f)
  let t = 0
  for (let i = 0; i < Math.min(entera, franjas.length); i++) t += franjas[i]
  if (entera < franjas.length) t += (franjas[entera] ?? 0) * (f - entera)
  return t
}

export type SinDatos = { ok: false; motivo: string; necesarios: number; disponibles: number }

// ---------- 1) Cierre de hoy ----------
export interface PuntoCurva { franja: number; mediana: number; bajo: number; alto: number }
export interface Cierre {
  ok: true
  actual: number
  estimado: number
  bajo: number                 // percentil 10
  alto: number                 // percentil 90
  factor: number               // ritmo de hoy frente a los días usados (mediana)
  diasUsados: number
  curva: PuntoCurva[]          // acumulado proyectado desde ahora hasta fin del día
  terminado: boolean           // el día típico ya habría terminado a esta hora
}

export const MIN_DIAS_CIERRE = 5

/**
 * Para cada día anterior con turno: lo que produjo desde esta hora hasta el cierre,
 * escalado por cuánto vas hoy comparado con ese día (mitad por el acumulado del día,
 * mitad por el ritmo de la última hora), más lo que llevas hoy.
 * Estimado = mediana de esos escenarios; rango probable = percentiles 10 a 90.
 */
export function proyectarCierre(hoy: number[], historia: number[][], fAhora: number): Cierre | SinDatos {
  const dias = historia.filter(d => suma(d) > 0)
  if (dias.length < MIN_DIAS_CIERRE) {
    return { ok: false, motivo: 'días con turno', necesarios: MIN_DIAS_CIERRE, disponibles: dias.length }
  }
  const actual = acumuladoHasta(hoy, fAhora)
  const hora = 4                                  // 4 franjas = 1 hora
  const hoyUltHora = actual - acumuladoHasta(hoy, Math.max(0, fAhora - hora))

  const escenarios: Array<{ k: number; d: number[] }> = dias.map(d => {
    const dAcum = acumuladoHasta(d, fAhora)
    const dUltHora = dAcum - acumuladoHasta(d, Math.max(0, fAhora - hora))
    const kAcum = dAcum > 50 ? actual / dAcum : 1
    const kRitmo = dUltHora > 10 ? hoyUltHora / dUltHora : kAcum
    // Si hoy todavía no empieza (o el día de referencia no había empezado), se asume un día típico
    const k = actual === 0 && dAcum === 0 ? 1 : limitar(0.5 * kAcum + 0.5 * kRitmo, 0.3, 1.7)
    return { k, d }
  })

  const fIni = Math.floor(fAhora)
  const curva: PuntoCurva[] = []
  for (let f = fIni; f <= FRANJAS; f++) {
    const vals = escenarios.map(({ k, d }) => actual + k * Math.max(0, acumuladoHasta(d, f) - acumuladoHasta(d, fAhora)))
    curva.push({ franja: f, mediana: mediana(vals), bajo: percentil(vals, 0.1), alto: percentil(vals, 0.9) })
  }
  const finales = escenarios.map(({ k, d }) => actual + k * Math.max(0, suma(d) - acumuladoHasta(d, fAhora)))
  const restanteTipico = mediana(dias.map(d => (suma(d) - acumuladoHasta(d, fAhora)) / suma(d)))
  return {
    ok: true, actual,
    estimado: Math.round(mediana(finales)),
    bajo: Math.round(percentil(finales, 0.1)),
    alto: Math.round(percentil(finales, 0.9)),
    factor: mediana(escenarios.map(e => e.k)),
    diasUsados: dias.length,
    curva,
    terminado: restanteTipico < 0.02,
  }
}

/** Perfil típico acumulado (mediana de los días con turno), para dibujar como referencia. */
export function perfilTipico(historia: number[][]): number[] {
  const dias = historia.filter(d => suma(d) > 0)
  return Array.from({ length: FRANJAS + 1 }, (_, f) => mediana(dias.map(d => acumuladoHasta(d, f))) || 0)
}

// ---------- 2) Próximos 7 días ----------
export interface DiaTotal { dia: string; dow: number; total: number }   // dow: 0 = domingo
export interface PronosticoDia { dia: string; dow: number; estimado: number; bajo: number; alto: number; semanasConTurno: number; semanasVistas: number }
export interface Pronostico7 { ok: true; dias: PronosticoDia[]; alfa: number; semanas: number }

export const MIN_DIAS_7 = 14
export const ALFA = 0.4
const Z80 = 1.2816

/**
 * Para cada día de la semana: promedio exponencial (α = 0,4) de ese mismo día en las
 * semanas anteriores (lo reciente pesa más). Rango probable ≈ 80 %: ± 1,28 desviaciones
 * de los errores que habría tenido el método en esas semanas.
 * `historia` debe venir ordenada, un registro por día calendario (incluye días sin turno = 0).
 * `futuros` son los días a pronosticar (clave AAAA-MM-DD y día de la semana).
 */
export function proyectar7Dias(historia: DiaTotal[], futuros: Array<{ dia: string; dow: number }>): Pronostico7 | SinDatos {
  if (historia.length < MIN_DIAS_7 || historia.every(d => d.total === 0)) {
    return { ok: false, motivo: 'días de historia', necesarios: MIN_DIAS_7, disponibles: historia.length }
  }
  const porDow = new Map<number, number[]>()
  for (const d of historia) { const l = porDow.get(d.dow) ?? []; l.push(d.total); porDow.set(d.dow, l) }

  // Errores absolutos del método en las semanas pasadas, por día de la semana
  // (un domingo casi siempre sin turno tiene su propia incertidumbre, distinta a la de un martes)
  const errores = new Map<number, number[]>()
  const nivel = new Map<number, number>()
  for (const [dow, vals] of porDow) {
    let s = vals[0]
    const e: number[] = []
    for (let i = 1; i < vals.length; i++) {
      e.push(vals[i] - s)
      s = ALFA * vals[i] + (1 - ALFA) * s
    }
    nivel.set(dow, s)
    errores.set(dow, e)
  }
  const todos = [...errores.values()].flat()
  const rmse = (e: number[]) => Math.sqrt(suma(e.map(x => x * x)) / e.length)
  const comun = todos.length ? rmse(todos) : 0

  const dias = futuros.map(f => {
    const vals = porDow.get(f.dow) ?? []
    const est = nivel.get(f.dow) ?? 0
    const con = vals.filter(v => v > 0).length
    const e = errores.get(f.dow) ?? []
    // con pocas semanas se mezcla con el error común de todos los días
    const sigma = e.length >= 3 ? rmse(e) : e.length ? 0.5 * rmse(e) + 0.5 * comun : comun
    return {
      dia: f.dia, dow: f.dow, estimado: Math.round(est),
      bajo: Math.max(0, Math.round(est - Z80 * sigma)), alto: Math.round(est + Z80 * sigma),
      semanasConTurno: con, semanasVistas: vals.length,
    }
  })
  return { ok: true, dias, alfa: ALFA, semanas: Math.max(...[...porDow.values()].map(v => v.length)) }
}

// ---------- 3) Acumulado de temporada ----------
export interface Temporada {
  ok: true
  real: Array<{ dia: string; acumulado: number }>
  proyeccion: Array<{ dia: string; acumulado: number; bajo: number; alto: number }>
  promedioDiario: number
  ventana: number
}
export const MIN_DIAS_TEMPORADA = 7

/**
 * Tendencia = promedio diario de los últimos `ventana` días calendario (incluye días sin turno),
 * extendido día a día. La banda crece con la raíz del horizonte (la incertidumbre se acumula).
 */
export function proyectarTemporada(historia: DiaTotal[], futuros: string[], ventana = 14): Temporada | SinDatos {
  if (historia.length < MIN_DIAS_TEMPORADA) {
    return { ok: false, motivo: 'días de temporada', necesarios: MIN_DIAS_TEMPORADA, disponibles: historia.length }
  }
  let acum = 0
  const real = historia.map(d => ({ dia: d.dia, acumulado: (acum += d.total) }))
  const ult = historia.slice(-ventana).map(d => d.total)
  const prom = suma(ult) / ult.length
  const sd = Math.sqrt(suma(ult.map(v => (v - prom) ** 2)) / Math.max(1, ult.length - 1))
  let a = acum
  const proyeccion = futuros.map((dia, i) => {
    a += prom
    const m = Z80 * sd * Math.sqrt(i + 1)
    return { dia, acumulado: Math.round(a), bajo: Math.round(Math.max(acum, a - m)), alto: Math.round(a + m) }
  })
  return { ok: true, real, proyeccion, promedioDiario: prom, ventana: ult.length }
}
