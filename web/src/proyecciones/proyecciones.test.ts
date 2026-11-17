import { describe, expect, it } from 'vitest'
import {
  FRANJAS, MIN_DIAS_CIERRE, MIN_DIAS_7, acumuladoHasta, mediana, percentil, perfilTipico,
  proyectar7Dias, proyectarCierre, proyectarTemporada, suma, type DiaTotal,
} from './index'

/** Día con turno de 08:00 a 20:00 a `cpm` cajas/min (15 min por franja). */
function dia(cpm: number, ini = 32, fin = 80): number[] {
  return Array.from({ length: FRANJAS }, (_, f) => (f >= ini && f < fin ? cpm * 15 : 0))
}

describe('utilidades', () => {
  it('percentiles y mediana', () => {
    expect(mediana([3, 1, 2])).toBe(2)
    expect(percentil([0, 10], 0.1)).toBeCloseTo(1)
    expect(Number.isNaN(percentil([], 0.5))).toBe(true)
  })
  it('acumulado con franja fraccional', () => {
    const d = dia(10)                                  // 150 por franja desde la 32
    expect(acumuladoHasta(d, 32)).toBe(0)
    expect(acumuladoHasta(d, 33.5)).toBe(225)
    expect(acumuladoHasta(d, FRANJAS)).toBe(suma(d))
  })
})

describe('cierre de hoy', () => {
  it('pide al menos 5 días con turno', () => {
    const r = proyectarCierre(dia(10), [dia(10), dia(0), dia(10)], 50)
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.necesarios).toBe(MIN_DIAS_CIERRE); expect(r.disponibles).toBe(2) }
  })

  it('día igual a los anteriores → proyecta su total, sin banda', () => {
    const hist = Array.from({ length: 10 }, () => dia(10))
    const r = proyectarCierre(dia(10), hist, 56)       // 14:00
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.estimado).toBe(suma(dia(10)))            // 7.200
      expect(r.alto - r.bajo).toBe(0)
      expect(r.factor).toBeCloseTo(1)
      expect(r.curva.at(-1)!.mediana).toBeCloseTo(suma(dia(10)))
    }
  })

  it('hoy va 20 % más rápido → el resto del día también se escala', () => {
    const hist = Array.from({ length: 8 }, () => dia(10))
    const r = proyectarCierre(dia(12), hist, 56)
    expect(r.ok && r.estimado).toBe(suma(dia(12)))
  })

  it('la banda refleja que los días terminan a distintas horas', () => {
    // mismo ritmo, pero cierres entre 17:30 y 22:00
    const hist = [70, 74, 78, 80, 82, 84, 86, 88].map(fin => dia(10, 32, fin))
    const r = proyectarCierre(dia(10), hist, 40)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.bajo).toBeLessThan(r.estimado)
      expect(r.alto).toBeGreaterThanOrEqual(r.estimado)
      expect(r.actual).toBe(acumuladoHasta(dia(10), 40))
    }
  })

  it('después del cierre típico no proyecta cajas extra', () => {
    const hist = Array.from({ length: 6 }, () => dia(10))
    const r = proyectarCierre(dia(10), hist, 90)
    expect(r.ok && r.estimado).toBe(suma(dia(10)))
    expect(r.ok && r.terminado).toBe(true)
  })

  it('antes de empezar el turno asume un día típico', () => {
    const hist = Array.from({ length: 6 }, () => dia(10))
    const r = proyectarCierre(Array(FRANJAS).fill(0), hist, 20)
    expect(r.ok && r.estimado).toBe(suma(dia(10)))
  })

  it('perfil típico es creciente y termina en el total típico', () => {
    const p = perfilTipico([dia(10), dia(10), dia(0)])
    expect(p[0]).toBe(0)
    expect(p[FRANJAS]).toBe(suma(dia(10)))
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThanOrEqual(p[i - 1])
  })
})

function historia(dias: number, total: (dow: number, i: number) => number, inicioDow = 1): DiaTotal[] {
  return Array.from({ length: dias }, (_, i) => {
    const dow = (inicioDow + i) % 7
    return { dia: `d${i}`, dow, total: total(dow, i) }
  })
}
const futuros = Array.from({ length: 7 }, (_, i) => ({ dia: `f${i}`, dow: (1 + i) % 7 }))

describe('próximos 7 días', () => {
  it('pide al menos 14 días', () => {
    const r = proyectar7Dias(historia(10, () => 100), futuros)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.necesarios).toBe(MIN_DIAS_7)
  })

  it('respeta el patrón semanal (domingo sin turno)', () => {
    const h = historia(28, dow => (dow === 0 ? 0 : dow === 6 ? 5000 : 10000))
    const r = proyectar7Dias(h, futuros)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const dom = r.dias.find(d => d.dow === 0)!, sab = r.dias.find(d => d.dow === 6)!, lun = r.dias.find(d => d.dow === 1)!
      expect(dom.estimado).toBe(0)
      expect(sab.estimado).toBe(5000)
      expect(lun.estimado).toBe(10000)
      expect(dom.semanasConTurno).toBe(0)
    }
  })

  it('lo reciente pesa más (tendencia al alza)', () => {
    const h = historia(28, (dow, i) => (dow === 0 ? 0 : 8000 + i * 100))
    const r = proyectar7Dias(h, futuros)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const lun = r.dias.find(d => d.dow === 1)!
      const promedioSimple = (8000 + 0 * 100 + 8000 + 7 * 100 + 8000 + 14 * 100 + 8000 + 21 * 100) / 4
      expect(lun.estimado).toBeGreaterThan(promedioSimple)
      expect(lun.bajo).toBeLessThanOrEqual(lun.estimado)
      expect(lun.alto).toBeGreaterThanOrEqual(lun.estimado)
    }
  })
})

describe('acumulado de temporada', () => {
  it('pide al menos 7 días', () => {
    expect(proyectarTemporada(historia(5, () => 100), ['a']).ok).toBe(false)
  })
  it('extiende el promedio reciente y la banda crece con el horizonte', () => {
    const h = historia(20, (_, i) => (i % 2 ? 9000 : 11000))
    const r = proyectarTemporada(h, ['a', 'b', 'c'], 14)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.real.at(-1)!.acumulado).toBe(200000)
      expect(r.promedioDiario).toBe(10000)
      expect(r.proyeccion[0].acumulado).toBe(210000)
      expect(r.proyeccion[2].acumulado).toBe(230000)
      const ancho = (k: number) => r.proyeccion[k].alto - r.proyeccion[k].bajo
      expect(ancho(2)).toBeGreaterThan(ancho(0))
      expect(r.proyeccion[0].bajo).toBeGreaterThanOrEqual(200000)
    }
  })
})
