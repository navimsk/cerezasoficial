import type { ReactNode } from 'react'
import { conSigno, entero, porcentaje } from '../lib/formato'
import { Icono } from './Icono'

/** Rótulo + cifra + nota: la unidad de la "fila rotulada". */
export function Medidor({ rotulo, children, nota }: { rotulo: string; children: ReactNode; nota?: ReactNode }) {
  return (
    <div className="medidor">
      <span className="rotulo">{rotulo}</span>
      <div className="medidor__valor">{children}</div>
      {nota && <span className="nota nota--tenue">{nota}</span>}
    </div>
  )
}

/** Diferencia contra una referencia: flecha + número con signo + texto. Nunca solo color. */
export function Delta({ actual, referencia, contra }: { actual: number; referencia: number | null; contra: string }) {
  if (referencia === null || referencia === 0) {
    return <span className="delta delta--neutro"><Icono nombre="igual" tam={16} trazo={2} />{contra}: sin datos</span>
  }
  const d = actual - referencia
  const rel = d / referencia
  const icono = d > 0 ? 'arriba' : d < 0 ? 'abajo' : 'igual'
  return (
    <span className="delta" title={`${contra}: ${entero(referencia)} cajas`}>
      <Icono nombre={icono} tam={16} trazo={2.25} />
      <span className="delta__cifra">{conSigno(d)}</span>
      <span className="delta__rel">({porcentaje(rel)})</span>
      <span className="delta__contra">{contra}</span>
    </span>
  )
}
