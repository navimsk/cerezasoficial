import { useCallback, useEffect, useRef, useState } from 'react'
import { useDatos } from '../datos/contexto'
import type { Evento, Punto, ResumenVivo, SaludEquipo } from '../datos/tipos'
import { useConsulta } from '../lib/consulta'
import { useAhora } from '../lib/hooks'
import { decimal1, diaCorto, diaLargo, entero, hace, hora, horaSeg } from '../lib/formato'
import { MIN, sumarDias } from '../lib/tiempo'
import { Cifra } from '../componentes/Cifra'
import { Delta, Medidor } from '../componentes/Medidores'
import { EstadoChip } from '../componentes/Estado'
import { Icono, type NombreIcono } from '../componentes/Icono'
import { Grafico, base, ejeX, ejeY, type Colores } from '../graficos/Grafico'

const TIPOS_FEED = new Set(['caja', 'caja_est', 'ajuste', 'atasco_inicio', 'atasco_fin', 'inicio', 'bloqueo_inicial', 'cinta_detenida', 'cinta_marcha'])

export function EnVivo() {
  const { fuente, equipo } = useDatos()
  const ahora = useAhora(1000)
  const id = equipo?.id ?? null

  const resumen = useConsulta<ResumenVivo>(id && `vivo.${id}`, () => fuente.resumenVivo(id!), { cada: 15_000 })
  const serie = useConsulta<Punto[]>(id && `vivo60.${id}`, () => {
    const fin = Math.floor(Date.now() / MIN) * MIN + MIN
    return fuente.serie(id!, fin - 60 * MIN, fin, 'minute')
  }, { cada: 30_000 })
  const salud = useConsulta<SaludEquipo[]>(id && 'salud', () => fuente.salud(), { cada: 30_000 })

  const [feed, setFeed] = useState<Array<Evento & { nuevo?: boolean }>>([])
  const setResumen = resumen.setDatos, setSerie = serie.setDatos

  useEffect(() => {
    if (!id) return
    let vivo = true
    fuente.eventos(id, Date.now() - 20 * MIN, Date.now() + MIN, 2000)
      .then(evs => { if (vivo) setFeed(evs.filter(e => TIPOS_FEED.has(e.tipo)).slice(-40).reverse()) })
      .catch(() => {})
    const quitar = fuente.suscribir(id, e => {
      if (TIPOS_FEED.has(e.tipo)) setFeed(f => [{ ...e, nuevo: true }, ...f].slice(0, 40))
      setResumen(r => r && aplicar(r, e))
      if (e.n !== 0) setSerie(s => s && sumarAMinuto(s, e))
    })
    return () => { vivo = false; quitar() }
  }, [fuente, id, setResumen, setSerie])

  const r = resumen.datos
  const s = salud.datos?.find(x => x.equipo.id === id) ?? null

  if (!equipo) return <p className="nota">Cargando equipos…</p>

  return (
    <div className="envivo">
      <h1 className="solo-lector">En vivo · {equipo.nombre}</h1>
      {r?.enAtasco && (
        <div className="alerta-atasco" role="alert">
          <Icono nombre="alerta" tam={24} trazo={2} />
          <div>
            <strong>Atasco en {equipo.nombre}</strong>
            <span>El haz está cortado. El conteo se detuvo hasta que se libere.</span>
          </div>
        </div>
      )}

      <section className="envivo__principal" aria-labelledby="hoy-rotulo">
        <p id="hoy-rotulo" className="rotulo">Hoy · {diaLargo(ahora)}</p>
        <div className="hero">
          <Cifra valor={r?.hoy ?? null} clase="cifra--hero" etiqueta="Cajas hoy" />
          <span className="hero__unidad">cajas</span>
        </div>
        <div className="deltas">
          <Delta actual={r?.hoy ?? 0} referencia={r ? r.ayerMismaHora : null} contra="vs ayer a esta hora" />
          <Delta actual={r?.hoy ?? 0} referencia={r ? r.semanaAnteriorMismaHora : null} contra={`vs ${diaCorto(sumarDias(ahora, -7))} a esta hora`} />
        </div>

        <div className="fila-rotulada">
          <Medidor rotulo="Ritmo · 10 min" nota={r?.ritmoHabitual ? `Habitual a esta hora: ${decimal1(r.ritmoHabitual)}` : 'Habitual: faltan días de datos'}>
            <Cifra valor={r?.ritmo10 ?? null} decimales={1} clase="cifra--xl" etiqueta="Ritmo en cajas por minuto" />
            <span className="unidad">cajas/min</span>
          </Medidor>
          <Medidor rotulo="Última hora">
            <Cifra valor={r?.ultimaHora ?? null} clase="cifra--xl" etiqueta="Cajas en la última hora" />
            <span className="unidad">cajas</span>
          </Medidor>
          <Medidor rotulo="Última caja" nota={r?.ultimaCaja ? hora(r.ultimaCaja) : undefined}>
            <span className="cifra cifra--l">{r?.ultimaCaja ? hace(r.ultimaCaja, ahora).replace('hace ', '') : '—'}</span>
            {r?.ultimaCaja && <span className="unidad">atrás</span>}
          </Medidor>
          <Medidor rotulo="Atascos hoy" nota={r?.ajustesHoy ? `${entero(r.ajustesHoy)} ${r.ajustesHoy === 1 ? 'caja corregida' : 'cajas corregidas'}` : 'Sin correcciones'}>
            <Cifra valor={r?.atascosHoy ?? null} clase="cifra--xl" etiqueta="Atascos hoy" />
          </Medidor>
        </div>

        <section className="panel" aria-labelledby="g60">
          <header className="panel__cab">
            <h2 id="g60" className="rotulo">Cajas por minuto · últimos 60 min</h2>
            {serie.datos && <span className="nota nota--tenue">{entero(serie.datos.reduce((a, p) => a + p.cajas, 0))} cajas</span>}
          </header>
          <div className="panel__cuerpo panel__cuerpo--grafico">
            <Ultimos60 puntos={serie.datos ?? []} habitual={r?.ritmoHabitual ?? null} atenuado={serie.cargando && !serie.datos} />
          </div>
        </section>
      </section>

      <aside className="envivo__lateral">
        <PanelEquipo salud={s} resumen={r} ahora={ahora} />
        <Feed eventos={feed} ahora={ahora} />
      </aside>

      {resumen.desdeCache && resumen.actualizado && (
        <p className="nota nota--tenue envivo__pie">Mostrando datos guardados de {hace(resumen.actualizado, ahora)}.</p>
      )}
      {resumen.error && !resumen.datos && (
        <div className="aviso aviso--error" role="alert"><Icono nombre="alerta" tam={18} /><span>No se pudo leer el resumen: {resumen.error}</span></div>
      )}
    </div>
  )
}

function aplicar(r: ResumenVivo, e: Evento): ResumenVivo {
  const x = { ...r }
  if (e.n !== 0) { x.hoy += e.n; x.ultimaHora += e.n }
  if (e.n > 0) x.ultimaCaja = Math.max(r.ultimaCaja ?? 0, e.ts)
  if (e.tipo === 'ajuste') x.ajustesHoy += -e.n
  if (e.tipo === 'atasco_inicio') { x.enAtasco = true; x.atascosHoy += 1 }
  if (e.tipo === 'atasco_fin') x.enAtasco = false
  x.ultimoContacto = Math.max(r.ultimoContacto ?? 0, e.ts)
  return x
}

function sumarAMinuto(s: Punto[], e: Evento): Punto[] {
  const m = Math.floor(e.ts / MIN) * MIN
  const i = s.findIndex(p => p.inicio === m)
  if (i >= 0) {
    const c = s.slice()
    c[i] = { ...c[i], cajas: c[i].cajas + e.n }
    return c
  }
  if (s.length && m > s[s.length - 1].inicio) {
    const c = s.slice()
    for (let t = s[s.length - 1].inicio + MIN; t <= m; t += MIN) c.push({ inicio: t, cajas: t === m ? e.n : 0, estimadas: 0, ajustes: 0, atascos: 0 })
    return c.slice(-60)
  }
  return s
}

function Ultimos60({ puntos, habitual, atenuado }: { puntos: Punto[]; habitual: number | null; atenuado: boolean }) {
  const opcion = useCallback((c: Colores) => ({
    ...base(c),
    grid: { left: 4, right: 8, top: 20, bottom: 4, containLabel: true },
    xAxis: ejeX(c, {
      type: 'category', data: puntos.map(p => hora(p.inicio)),
      axisLabel: { color: c.tinta3, fontSize: 12, interval: (i: number) => i % 15 === 0 },
    }),
    yAxis: ejeY(c),
    tooltip: { ...(base(c).tooltip as object), formatter: (ps: Array<{ name: string; value: number }>) => `${ps[0].name} · <b>${entero(ps[0].value)}</b> cajas` },
    series: [{
      type: 'bar', data: puntos.map(p => Math.max(0, p.cajas)), barMaxWidth: 24, barMinWidth: 2, barCategoryGap: '20%',
      itemStyle: { color: c.cereza, borderRadius: [2, 2, 0, 0] },
      emphasis: { itemStyle: { color: c.cereza } },
      markLine: habitual ? {
        symbol: 'none', silent: true, animation: false,
        lineStyle: { color: c.tinta3, width: 1, type: 'solid' },
        label: { position: 'insideEndTop', color: c.tinta2, fontSize: 12, formatter: `habitual ${decimal1(habitual)}/min` },
        data: [{ yAxis: habitual }],
      } : undefined,
    }],
  }), [puntos, habitual])

  return (
    <Grafico
      opcion={opcion} alto={200} atenuado={atenuado}
      etiqueta={`Cajas por minuto en los últimos 60 minutos: ${entero(puntos.reduce((a, p) => a + p.cajas, 0))} en total`}
      tabla={{ columnas: ['Minuto', 'Cajas'], filas: puntos.slice().reverse().map(p => [hora(p.inicio), p.cajas]) }}
    />
  )
}

function calidadWifi(rssi: number | null): string {
  if (rssi === null) return 'sin dato'
  if (rssi >= -60) return `buena (${rssi} dBm)`
  if (rssi >= -70) return `regular (${rssi} dBm)`
  return `débil (${rssi} dBm)`
}

function PanelEquipo({ salud, resumen, ahora }: { salud: SaludEquipo | null; resumen: ResumenVivo | null; ahora: number }) {
  const contacto = Math.max(salud?.ultimoContacto ?? 0, resumen?.ultimoContacto ?? 0) || null
  const sinCon = !contacto || ahora - contacto > 2 * MIN
  const estado = !contacto ? 'sin_datos' : sinCon ? 'sin_conexion' : resumen?.enAtasco ? 'atasco' : 'operando'
  const cajasRecientes = resumen?.ultimaCaja && ahora - resumen.ultimaCaja < 90_000
  const filas: Array<{ icono: NombreIcono; rotulo: string; valor: string }> = [
    { icono: 'reloj', rotulo: 'Último dato', valor: contacto ? `${hace(contacto, ahora)} · ${horaSeg(contacto)}` : 'nunca' },
    { icono: 'sensor', rotulo: 'Sensor', valor: salud?.haz === null || salud?.haz === undefined ? 'sin dato' : salud.haz ? 'haz cortado (caja frente al sensor)' : 'haz libre' },
    { icono: 'cinta', rotulo: 'Cinta', valor: sinCon ? 'sin información' : resumen?.enAtasco ? 'detenida o atascada' : cajasRecientes ? 'pasando cajas' : resumen?.ultimaCaja ? `sin cajas desde ${hora(resumen.ultimaCaja)}` : 'sin cajas hoy' },
    { icono: 'wifi', rotulo: 'WiFi', valor: calidadWifi(salud?.rssi ?? null) },
    { icono: 'alerta', rotulo: 'Atascos hoy', valor: resumen ? `${entero(resumen.atascosHoy)}${resumen.ajustesHoy ? ` · ${entero(resumen.ajustesHoy)} cajas corregidas` : ''}` : '—' },
  ]
  return (
    <section className="panel" aria-labelledby="estado-eq">
      <header className="panel__cab">
        <h2 id="estado-eq" className="rotulo">Estado del equipo</h2>
        <EstadoChip estado={estado} />
      </header>
      <dl className="lista-estado">
        {filas.map(f => (
          <div key={f.rotulo}>
            <dt><Icono nombre={f.icono} tam={18} />{f.rotulo}</dt>
            <dd>{f.valor}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

const TEXTO_EVENTO: Record<string, string> = {
  caja: 'Caja', caja_est: 'Caja pegada (estimada)', ajuste: 'Corrección por atasco',
  atasco_inicio: 'Atasco: haz cortado', atasco_fin: 'Atasco resuelto', inicio: 'Equipo encendido',
  bloqueo_inicial: 'Haz tapado al encender', cinta_detenida: 'Cinta detenida', cinta_marcha: 'Cinta en marcha',
}

function Feed({ eventos, ahora }: { eventos: Array<Evento & { nuevo?: boolean }>; ahora: number }) {
  const lista = useRef<HTMLOListElement>(null)
  return (
    <section className="panel" aria-labelledby="feed-t">
      <header className="panel__cab">
        <h2 id="feed-t" className="rotulo">Registro en vivo</h2>
        {eventos[0] && <span className="nota nota--tenue">{hace(eventos[0].ts, ahora)}</span>}
      </header>
      {eventos.length === 0
        ? <p className="panel__cuerpo nota">Sin eventos en los últimos 20 min. Aparecen aquí apenas el equipo envía datos.</p>
        : (
          <ol className="feed" ref={lista} aria-live="off" tabIndex={0} aria-label="Últimos eventos del equipo, el más reciente primero">
            {eventos.map(e => (
              <li key={`${e.equipo_id}-${e.seq}`} className={`feed__fila feed__fila--${e.tipo}${e.nuevo ? ' feed__fila--nueva' : ''}`}>
                <time className="feed__hora" dateTime={new Date(e.ts).toISOString()}>{horaSeg(e.ts)}</time>
                <span className="feed__texto">
                  {(e.tipo === 'atasco_inicio' || e.tipo === 'ajuste') && <Icono nombre="alerta" tam={16} trazo={2} />}
                  {e.tipo === 'atasco_fin' && <Icono nombre="check" tam={16} trazo={2} />}
                  {TEXTO_EVENTO[e.tipo] ?? e.tipo}
                </span>
                <span className="feed__n">{e.n > 0 ? `+${e.n}` : e.n < 0 ? `−${-e.n}` : ''}</span>
              </li>
            ))}
          </ol>
        )}
    </section>
  )
}
