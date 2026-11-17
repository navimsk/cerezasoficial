import type { EstadoEquipo } from '../datos/tipos'
import { hace } from '../lib/formato'
import { Icono, type NombreIcono } from './Icono'

const MAPA: Record<EstadoEquipo, { clase: string; icono: NombreIcono; texto: string }> = {
  operando: { clase: 'ok', icono: 'check', texto: 'Operando' },
  atasco: { clase: 'atasco', icono: 'alerta', texto: 'Atasco' },
  sin_conexion: { clase: 'sin-conexion', icono: 'sinSenal', texto: 'Sin conexión' },
  detenido: { clase: 'neutro', icono: 'vacio', texto: 'Detenido' },
  sin_datos: { clase: 'neutro', icono: 'vacio', texto: 'Sin datos' },
}

/** Estado del equipo: siempre ícono + texto + color. */
export function EstadoChip({ estado, texto }: { estado: EstadoEquipo; texto?: string }) {
  const m = MAPA[estado]
  return (
    <span className={`chip-estado chip-estado--${m.clase}`}>
      <Icono nombre={m.icono} tam={16} trazo={2} />
      {texto ?? m.texto}
    </span>
  )
}

/** "EN VIVO · hace 4 s" o "SIN SEÑAL · último dato hace 6 min". */
export function IndicadorVivo({ ultimo, ahora, conectado }: { ultimo: number | null; ahora: number; conectado: boolean }) {
  const viejo = ultimo === null || ahora - ultimo > 2 * 60_000
  const caido = !conectado || viejo
  let texto: string
  if (!conectado) texto = ultimo ? `Sin internet · dato ${hace(ultimo, ahora)}` : 'Sin internet'
  else if (ultimo === null) texto = 'Esperando datos'
  else if (viejo) texto = `Sin señal del equipo · ${hace(ultimo, ahora)}`
  else texto = `En vivo · ${hace(ultimo, ahora)}`
  return (
    <span className={`vivo${caido ? ' vivo--caido' : ''}`}>
      {caido ? <Icono nombre="sinSenal" tam={14} trazo={2} /> : <span className="vivo__punto" aria-hidden />}
      {texto}
    </span>
  )
}
