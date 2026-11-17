import { useDatos } from '../datos/contexto'
import type { SaludEquipo } from '../datos/tipos'
import { useConsulta } from '../lib/consulta'
import { useAhora } from '../lib/hooks'
import { decimal1, duracion, entero, hace, horaSeg } from '../lib/formato'
import { EstadoChip } from '../componentes/Estado'
import { Icono } from '../componentes/Icono'

const ESTADO_REPORTADO: Record<string, string> = {
  normal: 'Normal', caja_en_haz: 'Caja frente al sensor', atasco: 'Atasco',
  esperando_haz_libre: 'Esperando que se libere el haz', cinta_detenida: 'Cinta detenida',
}

export function Equipos() {
  const { fuente } = useDatos()
  const ahora = useAhora(5000)
  const salud = useConsulta<SaludEquipo[]>('salud', () => fuente.salud(), { cada: 20_000 })

  return (
    <>
      <div className="cabeza-pantalla">
        <h1 className="titulo-pantalla">Equipos</h1>
        {salud.actualizado && <span className="nota nota--tenue">Actualizado {hace(salud.actualizado, ahora)}</span>}
      </div>
      {salud.error && !salud.datos && <div className="aviso aviso--error" role="alert"><Icono nombre="alerta" tam={18} /><span>{salud.error}</span></div>}
      {salud.datos?.length === 0 && <div className="aviso"><Icono nombre="info" tam={18} /><span>No hay equipos activos.</span></div>}
      <div className="equipos">
        {(salud.datos ?? []).map(s => <TarjetaEquipo key={s.equipo.id} s={s} ahora={ahora} />)}
      </div>
    </>
  )
}

function wifi(rssi: number | null) {
  if (rssi === null) return { texto: 'Sin dato', nivel: '' }
  if (rssi >= -60) return { texto: `${rssi} dBm`, nivel: 'buena' }
  if (rssi >= -70) return { texto: `${rssi} dBm`, nivel: 'regular' }
  return { texto: `${rssi} dBm`, nivel: 'débil: acercar antena o router' }
}

function TarjetaEquipo({ s, ahora }: { s: SaludEquipo; ahora: number }) {
  const w = wifi(s.rssi)
  const filas: Array<[string, string, string?]> = [
    ['Último contacto', s.ultimoContacto ? `${hace(s.ultimoContacto, ahora)}` : 'Nunca', s.ultimoContacto ? horaSeg(s.ultimoContacto) : undefined],
    ['Estado reportado', s.estadoReportado ? (ESTADO_REPORTADO[s.estadoReportado] ?? s.estadoReportado) : 'Sin dato'],
    ['Sensor', s.haz === null ? 'Sin dato' : s.haz ? 'Haz cortado' : 'Haz libre'],
    ['WiFi', w.texto, w.nivel],
    ['Velocidad aprendida', s.velMmS ? `${decimal1(s.velMmS / 1000)} m/s` : 'Sin dato', s.velMmS ? `${entero(s.velMmS)} mm/s` : undefined],
    ['Encendido hace', s.uptimeS !== null ? duracion(s.uptimeS * 1000) : 'Sin dato'],
    ['Atascos hoy', entero(s.atascosHoy), s.ajustesHoy ? `${entero(s.ajustesHoy)} cajas corregidas` : undefined],
    ['Eventos perdidos (24 h)', entero(s.seqFaltantes24h), s.seqFaltantes24h ? 'saltos en el correlativo del equipo' : 'ninguno'],
    ['Pendientes en el equipo', s.pendientes === null ? 'Sin dato' : entero(s.pendientes), s.pendientes ? 'esperando conexión para enviarse' : undefined],
    ['Interferencias filtradas', s.filtrados === null ? 'Sin dato' : entero(s.filtrados), 'bloqueos cortos ignorados desde que encendió'],
  ]
  return (
    <section className="panel" aria-labelledby={`eq-${s.equipo.id}`}>
      <header className="panel__cab">
        <h2 id={`eq-${s.equipo.id}`} className="titulo-seccion">{s.equipo.nombre} <span className="nota nota--tenue">{s.equipo.id}</span></h2>
        <EstadoChip estado={s.estado} />
      </header>
      <dl className="lista-estado lista-estado--ancha">
        {filas.map(([r, v, n]) => (
          <div key={r}>
            <dt>{r}</dt>
            <dd><span className="valor-tab">{v}</span>{n && <span className="nota nota--tenue"> · {n}</span>}</dd>
          </div>
        ))}
      </dl>
      {s.seqFaltantes24h > 0 && (
        <p className="aviso aviso--panel"><Icono nombre="info" tam={18} /><span>Faltan {entero(s.seqFaltantes24h)} eventos en las últimas 24 h. Si son cajas, el conteo podría estar algo bajo. Suele deberse a cortes largos de WiFi que llenaron la memoria del equipo.</span></p>
      )}
    </section>
  )
}
