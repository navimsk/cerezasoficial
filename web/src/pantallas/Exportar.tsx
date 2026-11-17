import { useState } from 'react'
import { useDatos } from '../datos/contexto'
import { useAhora } from '../lib/hooks'
import { entero } from '../lib/formato'
import { DIA, diaDesdeClave, inicioDia, sumarDias } from '../lib/tiempo'
import { claveInput } from '../lib/rangos'
import { descargar, exportar, type AlcanceEventos, type Formato } from '../exportar'
import { Icono } from '../componentes/Icono'

const FORMATOS: Array<{ f: Formato; titulo: string; detalle: string }> = [
  { f: 'xlsx', titulo: 'Excel (.xlsx)', detalle: 'Hojas Resumen diario, Por hora, Eventos y Atascos. Fechas reales en hora de Chile, con filtros y encabezado fijo.' },
  { f: 'csv', titulo: 'CSV (.csv)', detalle: 'Una tabla de eventos. Separador punto y coma y coma decimal: se abre directo en Excel en español.' },
  { f: 'sql', titulo: 'SQL (.sql)', detalle: 'Esquema + INSERTs para PostgreSQL. Para cargar en la base de datos local de la empresa; se puede ejecutar más de una vez sin duplicar.' },
]

export function Exportar() {
  const { fuente, equipos, equipo } = useDatos()
  const ahora = useAhora(60_000)
  const [desde, setDesde] = useState(() => claveInput(sumarDias(ahora, -6)))
  const [hasta, setHasta] = useState(() => claveInput(ahora))
  const [equipoId, setEquipoId] = useState(equipo?.id ?? '')
  const [alcance, setAlcance] = useState<AlcanceEventos>('relevantes')
  const [estado, setEstado] = useState<{ tipo: 'trabajando' | 'ok' | 'error'; texto: string } | null>(null)

  const eq = equipos.find(e => e.id === equipoId) ?? equipo
  const t0 = diaDesdeClave(desde)
  const t1 = Math.min(sumarDias(diaDesdeClave(hasta), 1), Math.max(ahora, inicioDia(ahora) + DIA))
  const dias = Math.max(1, Math.round((t1 - t0) / DIA))
  const valido = !!eq && t1 > t0
  const atajos: Array<[string, number]> = [['Hoy', 0], ['7 días', 6], ['30 días', 29]]

  async function generar(f: Formato) {
    if (!eq || !valido) return
    setEstado({ tipo: 'trabajando', texto: 'Iniciando…' })
    try {
      const { blob, nombre } = await exportar(f, {
        fuente, equipo: eq, desde: t0, hasta: Math.min(t1, Date.now() + 60_000), eventos: alcance,
        progreso: texto => setEstado({ tipo: 'trabajando', texto }),
      })
      descargar(blob, nombre)
      setEstado({ tipo: 'ok', texto: `Listo: ${nombre} (${tamano(blob.size)}).` })
    } catch (e) {
      setEstado({ tipo: 'error', texto: `No se pudo exportar: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  const ocupado = estado?.tipo === 'trabajando'
  return (
    <div className="pantalla exportar">
      <h1 className="titulo-pantalla">Exportar</h1>

      <section className="panel" aria-labelledby="ex-rango">
        <header className="panel__cab"><h2 id="ex-rango" className="rotulo">Qué exportar</h2><span className="nota nota--tenue">{entero(dias)} {dias === 1 ? 'día' : 'días'}</span></header>
        <div className="panel__cuerpo exportar__form">
          <div className="filtros__fechas">
            <label className="campo"><span className="rotulo">Desde</span><input type="date" value={desde} max={hasta} onChange={e => e.target.value && setDesde(e.target.value)} /></label>
            <label className="campo"><span className="rotulo">Hasta</span><input type="date" value={hasta} min={desde} max={claveInput(ahora)} onChange={e => e.target.value && setHasta(e.target.value)} /></label>
            {equipos.length > 0 && (
              <label className="campo"><span className="rotulo">Equipo</span>
                <select value={eq?.id} onChange={e => setEquipoId(e.target.value)}>
                  {equipos.map(q => <option key={q.id} value={q.id}>{q.nombre}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="exportar__atajos" role="group" aria-label="Rangos rápidos">
            {atajos.map(([t, n]) => (
              <button key={t} type="button" className="boton" onClick={() => { setDesde(claveInput(sumarDias(ahora, -n))); setHasta(claveInput(ahora)) }}>{t}</button>
            ))}
          </div>
          <fieldset className="exportar__alcance">
            <legend className="rotulo">Eventos a incluir (Excel, CSV y SQL)</legend>
            <label><input type="radio" name="alcance" checked={alcance === 'relevantes'} onChange={() => setAlcance('relevantes')} /> Cajas, correcciones y atascos <span className="nota nota--tenue">(recomendado)</span></label>
            <label><input type="radio" name="alcance" checked={alcance === 'todos'} onChange={() => setAlcance('todos')} /> Todo, incluidos heartbeats y bloques <span className="nota nota--tenue">(archivo ~2× más grande)</span></label>
          </fieldset>
        </div>
      </section>

      <section aria-labelledby="ex-formato" className="exportar__formatos">
        <h2 id="ex-formato" className="rotulo">Descargar</h2>
        {FORMATOS.map(f => (
          <div key={f.f} className="formato">
            <div>
              <p className="titulo-seccion">{f.titulo}</p>
              <p className="nota">{f.detalle}</p>
            </div>
            <button type="button" className="boton boton--primario" disabled={!valido || ocupado} onClick={() => generar(f.f)}>
              <Icono nombre="descarga" tam={18} />Descargar
            </button>
          </div>
        ))}
      </section>

      {estado && (
        <p className={`aviso${estado.tipo === 'error' ? ' aviso--error' : ''}`} role={estado.tipo === 'error' ? 'alert' : 'status'}>
          <Icono nombre={estado.tipo === 'error' ? 'alerta' : estado.tipo === 'ok' ? 'check' : 'reloj'} tam={18} />
          <span>{estado.texto}</span>
        </p>
      )}
      {dias > 31 && <p className="nota nota--tenue">Rangos largos generan archivos grandes (≈ 13.000 eventos por día de turno). Puede tardar un minuto.</p>}
    </div>
  )
}

function tamano(b: number) {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`
  return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}
