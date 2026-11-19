import { useEffect, useState } from 'react'
import { useDatos } from '../datos/contexto'
import type { Equipo, SaludEquipo } from '../datos/tipos'
import { useConsulta } from '../lib/consulta'
import { useAhora } from '../lib/hooks'
import { duracion, entero, hace, horaSeg } from '../lib/formato'
import { EstadoChip } from '../componentes/Estado'
import { Icono } from '../componentes/Icono'

const ESTADO_REPORTADO: Record<string, string> = {
  normal: 'Normal', caja_en_haz: 'Caja frente al sensor', atasco: 'Atasco',
  esperando_haz_libre: 'Esperando que se libere el haz', cinta_detenida: 'Cinta detenida',
}

export function Equipos() {
  const { fuente, equipos } = useDatos()
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
        {(salud.datos ?? []).map(s => <TarjetaEquipo key={s.equipo.id} s={s} ahora={ahora} equipo={equipos.find(e => e.id === s.equipo.id)} />)}
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

function TarjetaEquipo({ s, ahora, equipo }: { s: SaludEquipo; ahora: number; equipo?: Equipo }) {
  const w = wifi(s.rssi)
  const filas: Array<[string, string, string?]> = [
    ['Último contacto', s.ultimoContacto ? `${hace(s.ultimoContacto, ahora)}` : 'Nunca', s.ultimoContacto ? horaSeg(s.ultimoContacto) : undefined],
    ['Estado reportado', s.estadoReportado ? (ESTADO_REPORTADO[s.estadoReportado] ?? s.estadoReportado) : 'Sin dato'],
    ['Sensor', s.haz === null ? 'Sin dato' : s.haz ? 'Haz cortado' : 'Haz libre'],
    ['WiFi', w.texto, w.nivel],
    ['Velocidad que usa', s.velMmS ? `${mMin(s.velMmS)} m/min` : 'Sin dato', s.velMmS ? `${entero(s.velMmS)} mm/s · según el último heartbeat` : undefined],
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
      {equipo && <ConfigConteo equipo={equipo} velUsada={s.velMmS} />}
      {s.seqFaltantes24h > 0 && (
        <p className="aviso aviso--panel"><Icono nombre="info" tam={18} /><span>Faltan {entero(s.seqFaltantes24h)} eventos en las últimas 24 h. Si son cajas, el conteo podría estar algo bajo. Suele deberse a cortes largos de WiFi que llenaron la memoria del equipo.</span></p>
      )}
    </section>
  )
}

/** mm/s → m/min con 2 decimales, coma decimal. */
const mMin = (mmS: number) => (mmS * 60 / 1000).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const aNumero = (t: string) => Number(t.trim().replace(',', '.'))

/**
 * Largo de caja y velocidad de la cinta. Solo admin edita; el equipo recibe el cambio en su
 * próximo envío (heartbeat cada 30 s), sin reprogramarlo.
 */
function ConfigConteo({ equipo, velUsada }: { equipo: Equipo; velUsada: number | null }) {
  const { fuente, perfil, recargarEquipos } = useDatos()
  const puede = perfil?.rol === 'admin' || fuente.modo === 'demo'
  const inicial = () => ({
    largo: (equipo.largo_caja_mm / 10).toLocaleString('es-CL', { maximumFractionDigits: 1 }),
    vel: equipo.vel_cinta_mm_s ? mMin(equipo.vel_cinta_mm_s) : '',
    aprender: equipo.aprender_vel ?? true,
    baliza: String(equipo.baliza_max_min ?? 10),
    cierre: equipo.hora_cierre ?? '',
  })
  const [f, setF] = useState(inicial)
  const [estado, setEstado] = useState<{ error: boolean; texto: string } | null>(null)
  const [ocupado, setOcupado] = useState(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setF(inicial()), [equipo.largo_caja_mm, equipo.vel_cinta_mm_s, equipo.aprender_vel, equipo.baliza_max_min, equipo.hora_cierre])

  const balizaMin = aNumero(f.baliza)
  const errBaliza = !(Number.isInteger(balizaMin) && balizaMin >= 0 && balizaMin <= 1440) ? 'Minutos enteros entre 0 y 1440.' : null

  const largoCm = aNumero(f.largo)
  const velMin = f.vel.trim() === '' ? null : aNumero(f.vel)
  const errLargo = !(largoCm >= 5 && largoCm <= 200) ? 'Entre 5 y 200 cm.' : null
  const errVel = velMin !== null && !(velMin >= 0.6 && velMin <= 180) ? 'Entre 0,6 y 180 m/min, o vacío.' : null
  const velMmS = velMin !== null && !errVel ? velMin * 1000 / 60 : null
  const tapaS = !errLargo && (velMmS ?? velUsada) ? (largoCm * 10) / (velMmS ?? velUsada!) : null
  const cambio = JSON.stringify(f) !== JSON.stringify(inicial())

  async function guardar() {
    if (errLargo || errVel || errBaliza) return
    setOcupado(true); setEstado(null)
    try {
      await fuente.guardarConfigEquipo(equipo.id, {
        largo_caja_mm: Math.round(largoCm * 10),
        vel_cinta_mm_s: velMmS === null ? null : Math.round(velMmS * 10) / 10,
        aprender_vel: f.aprender,
        baliza_max_min: balizaMin,
        hora_cierre: f.cierre || null,
      })
      await recargarEquipos()
      setEstado({ error: false, texto: 'Guardado. El equipo lo aplica en su próximo envío (menos de 30 s si está conectado).' })
    } catch (e) {
      setEstado({ error: true, texto: e instanceof Error ? e.message : String(e) })
    }
    setOcupado(false)
  }

  return (
    <form className="config-conteo" onSubmit={e => { e.preventDefault(); guardar() }}>
      <h3 className="rotulo">Configuración del conteo</h3>
      <fieldset disabled={!puede || ocupado} className="config-conteo__campos">
        <label className="campo">
          <span className="rotulo">Largo de la caja (cm)</span>
          <input inputMode="decimal" value={f.largo} aria-invalid={!!errLargo} aria-describedby={`largo-ayuda-${equipo.id}`}
            onChange={e => setF({ ...f, largo: e.target.value })} />
          <span id={`largo-ayuda-${equipo.id}`} className={`nota${errLargo ? ' texto-error' : ' nota--tenue'}`}>{errLargo ?? 'Lado que avanza por la cinta.'}</span>
        </label>
        <label className="campo">
          <span className="rotulo">Velocidad de la cinta (m/min)</span>
          <input inputMode="decimal" value={f.vel} placeholder="la que aprende el equipo" aria-invalid={!!errVel} aria-describedby={`vel-ayuda-${equipo.id}`}
            onChange={e => setF({ ...f, vel: e.target.value })} />
          <span id={`vel-ayuda-${equipo.id}`} className={`nota${errVel ? ' texto-error' : ' nota--tenue'}`}>
            {errVel ?? (velUsada ? `El equipo está usando ${mMin(velUsada)} m/min.` : 'Vacío: el equipo usa la que aprende.')}
          </span>
        </label>
        <label className="interruptor">
          <input type="checkbox" role="switch" checked={f.aprender} onChange={e => setF({ ...f, aprender: e.target.checked })} />
          <span className="interruptor__pista" aria-hidden />
          <span className="interruptor__texto">
            <b>Ajustar la velocidad solo</b>
            <span className="nota nota--tenue">Con cada caja suelta corrige la velocidad (desde la 3.ª). Desactívalo si la velocidad que escribes es exacta.</span>
          </span>
        </label>
        <label className="campo">
          <span className="rotulo">Baliza de atasco: máximo (min)</span>
          <input inputMode="numeric" value={f.baliza} aria-invalid={!!errBaliza} aria-describedby={`baliza-ayuda-${equipo.id}`}
            onChange={e => setF({ ...f, baliza: e.target.value })} />
          <span id={`baliza-ayuda-${equipo.id}`} className={`nota${errBaliza ? ' texto-error' : ' nota--tenue'}`}>
            {errBaliza ?? (balizaMin === 0 ? 'Sin límite: queda encendida mientras dure el atasco.' : 'Después se apaga sola; el atasco sigue registrado en la app.')}
          </span>
        </label>
        <label className="campo">
          <span className="rotulo">Hora de cierre del turno</span>
          <input type="time" value={f.cierre} aria-describedby={`cierre-ayuda-${equipo.id}`}
            onChange={e => setF({ ...f, cierre: e.target.value })} />
          <span id={`cierre-ayuda-${equipo.id}`} className="nota nota--tenue">
            {f.cierre ? `Si después de las ${f.cierre} el sensor sigue tapado, llega un aviso (preferencia "Atasco").` : 'Vacío: sin aviso de sensor tapado al cierre.'}
          </span>
        </label>
      </fieldset>
      {tapaS !== null && <p className="nota nota--tenue">Con estos valores, cada caja tapa el sensor unos {tapaS.toLocaleString('es-CL', { maximumFractionDigits: 2 })} s.</p>}
      {puede ? (
        <div className="fila-botones">
          <button type="submit" className="boton boton--primario" disabled={!cambio || !!errLargo || !!errVel || !!errBaliza || ocupado}>
            <Icono nombre="check" tam={18} />{ocupado ? 'Guardando…' : 'Guardar'}
          </button>
          {velUsada && <button type="button" className="boton" disabled={ocupado} onClick={() => setF({ ...f, vel: mMin(velUsada) })}>Usar la que mide el equipo</button>}
        </div>
      ) : <p className="nota nota--tenue">Solo un administrador puede cambiar esta configuración.</p>}
      {estado && <p className={`nota${estado.error ? ' texto-error' : ''}`} role={estado.error ? 'alert' : 'status'}>{estado.texto}</p>}
    </form>
  )
}
