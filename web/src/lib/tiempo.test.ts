import { describe, expect, it } from 'vitest'
import { claveDia, desdeLocal, inicioDia, inicioSemana, partes, siguiente, sumarDias } from './tiempo'

describe('hora de Santiago', () => {
  it('convierte medianoche local en verano (UTC-3) e invierno (UTC-4)', () => {
    expect(new Date(desdeLocal(2026, 11, 15)).toISOString()).toBe('2026-11-15T03:00:00.000Z')
    expect(new Date(desdeLocal(2026, 6, 15)).toISOString()).toBe('2026-06-15T04:00:00.000Z')
  })
  it('obtiene partes locales', () => {
    const p = partes(Date.parse('2026-11-15T17:30:00Z'))
    expect([p.y, p.m, p.d, p.h, p.min, p.dow]).toEqual([2026, 11, 15, 14, 30, 0])
  })
  it('inicio de día y semana (lunes)', () => {
    const t = Date.parse('2026-11-19T15:00:00Z')      // jueves
    expect(claveDia(inicioDia(t))).toBe('2026-11-19')
    expect(claveDia(inicioSemana(t))).toBe('2026-11-16')
  })
  it('día con cambio de hora dura 23 h y sumarDias conserva la hora local', () => {
    // Chile adelanta la hora la noche del sábado 5 al domingo 6 de septiembre de 2026
    const d = desdeLocal(2026, 9, 6)
    expect((siguiente(d, 'day') - inicioDia(d)) / 3_600_000).toBe(23)
    const t = desdeLocal(2026, 9, 5, 14, 0)
    expect(partes(sumarDias(t, 1)).h).toBe(14)
  })
})
