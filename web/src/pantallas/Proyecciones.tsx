import { useCallback, useMemo, type ReactNode } from 'react'
import { useDatos } from '../datos/contexto'
import type { FranjaProyeccion } from '../datos/tipos'
import { useConsulta } from '../lib/consulta'
import { useAhora } from '../lib/hooks'
import { diaCorto, entero, porcentaje } from '../lib/formato'
import { claveDia, diaDesdeClave, inicioDia, minutoDelDia, partes, sumarDias } from '../lib/tiempo'
import {
  ALFA, FRANJAS, acumuladoHasta, perfilTipico,
  proyectar7Dias, proyectarCierre, proyectarTemporada, type DiaTotal, type SinDatos,
} from '../proyecciones'
import { Grafico, base, ejeX, ejeY, type Colores } from '../graficos/Grafico'
import { Medidor } from '../componentes/Medidores'
import { Icono } from '../componentes/Icono'

const DIAS_HISTORIA = 56
const etiquetaFranja = (f: number) => `${String(Math.floor(f / 4) % 24).padStart(2, '0')}:${String((f % 4) * 15).padStart(2, '0')}`

export function Proyecciones() {
  const { fuente, equipo } = useDatos()
  const ahora = useAhora(60_000)
  const id = equipo?.id ?? null
  const consulta = useConsulta<FranjaProyeccion[]>(id && `proy.${id}`, () => fuente.datosProyeccion(id!, DIAS_HISTORIA), { cada: 60_000 })

  const datos = useMemo(() => preparar(consulta.datos ?? [], ahora), [consulta.datos, ahora])
  const fAhora = minutoDelDia(ahora) / 15

  const cierre = useMemo(() => proyectarCierre(datos.hoy, datos.historia28, fAhora), [datos, fAhora])
  const perfil = useMemo(() => perfilTipico(datos.historia28), [datos])
  const futuros7 = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const t = sumarDias(inicioDia(ahora) + 12 * 3_600_000, i + 1)
    return { dia: claveDia(t), dow: partes(t).dow }
  }), [ahora])
  const semana = useMemo(() => proyectar7Dias(datos.totales, futuros7), [datos, futuros7])
  const futuros14 = useMemo(() => Array.from({ length: 14 }, (_, i) => claveDia(sumarDias(inicioDia(ahora) + 12 * 3_600_000, i + 1))), [ahora])
  const temporada = useMemo(() => proyectarTemporada([...datos.totales, { dia: claveDia(ahora), dow: partes(ahora).dow, total: cierre.ok ? cierre.estimado : datos.hoyTotal }], futuros14), [datos, futuros14, cierre, ahora])

  if (!consulta.datos && consulta.cargando) return <p className="nota">Calculando proyecciones…</p>

  return (
    <div className="pantalla">
      <div className="cabeza-pantalla">
        <h1 className="titulo-pantalla">Proyecciones</h1>
        <span className="nota nota--tenue">Con {entero(datos.diasConTurno)} días con turno de los últimos {DIAS_HISTORIA}</span>
      </div>
      <div className="aviso">
        <Icono nombre="info" tam={18} />
        <span>Son estimaciones a partir de lo ocurrido en días anteriores, no metas. El rango probable indica dónde cae el resultado en 8 de cada 10 casos parecidos.</span>
      </div>

      {/* ---------- 1. Cierre de hoy ---------- */}
      <section className="panel" aria-labelledby="p-cierre">
        <header className="panel__cab"><h2 id="p-cierre" className="rotulo">Cierre de hoy</h2></header>
        {!cierre.ok ? <FaltanDatos d={cierre} /> : (
          <>
            <div className="panel__cuerpo">
              <div className="fila-rotulada fila-rotulada--panel">
                <Medidor rotulo="Estimado al final del día" nota={`Rango probable ${entero(cierre.bajo)} – ${entero(cierre.alto)}`}>
                  <span className="cifra cifra--xl">{entero(cierre.estimado)}</span><span className="unidad">cajas</span>
                </Medidor>
                <Medidor rotulo="Llevas">
                  <span className="cifra cifra--xl">{entero(cierre.actual)}</span><span className="unidad">cajas</span>
                </Medidor>
                <Medidor rotulo="Faltarían" nota={cierre.terminado ? 'A esta hora los días anteriores ya habían cerrado' : undefined}>
                  <span className="cifra cifra--xl">{entero(Math.max(0, cierre.estimado - cierre.actual))}</span><span className="unidad">cajas</span>
                </Medidor>
                <Medidor rotulo="Ritmo de hoy" nota="frente a los días anteriores a esta hora">
                  <span className="cifra cifra--xl">{porcentaje(cierre.factor - 1)}</span>
                </Medidor>
              </div>
            </div>
            <div className="panel__cuerpo panel__cuerpo--grafico">
              <Leyenda items={[['linea', 'Hoy (real)'], ['punteada', 'Proyección'], ['banda', 'Rango probable'], ['gris', 'Día típico']]} />
              <GraficoCierre hoy={datos.hoy} fAhora={fAhora} curva={cierre.curva} perfil={perfil} />
            </div>
            <ComoSeCalcula>
              <p>Se toman los <b>{cierre.diasUsados} días con turno</b> de las últimas 4 semanas. Para cada uno se mira cuántas cajas hizo <b>desde esta hora hasta su cierre</b>.</p>
              <p>Ese resto se ajusta según cómo vas hoy comparado con ese día a esta misma hora: mitad por lo acumulado en el día y mitad por el ritmo de la última hora. Si hoy vas un 10 % más rápido, se supone que el resto del día también.</p>
              <p>Cada día anterior da un escenario. El <b>estimado</b> es el escenario del medio (mediana) y el <b>rango probable</b> va del 10 % más bajo al 10 % más alto.</p>
            </ComoSeCalcula>
          </>
        )}
      </section>

      {/* ---------- 2. Próximos 7 días ---------- */}
      <section className="panel" aria-labelledby="p-7">
        <header className="panel__cab"><h2 id="p-7" className="rotulo">Próximos 7 días</h2>
          {semana.ok && <span className="nota nota--tenue">Total estimado {entero(semana.dias.reduce((a, d) => a + d.estimado, 0))} cajas</span>}
        </header>
        {!semana.ok ? <FaltanDatos d={semana} /> : (
          <>
            <div className="panel__cuerpo panel__cuerpo--grafico">
              <Leyenda items={[['cereza', 'Estimado'], ['banda', 'Rango probable']]} />
              <GraficoSemana dias={semana.dias} />
            </div>
            <ComoSeCalcula>
              <p>Para cada día de la semana se usa un <b>promedio exponencial</b> de ese mismo día en las semanas anteriores: el lunes se estima con los lunes, el sábado con los sábados.</p>
              <p>La semana más reciente pesa {Math.round(ALFA * 100)} % y el resto se reparte entre las anteriores, cada vez menos. Así, si la temporada viene subiendo, la estimación sube.</p>
              <p>El <b>rango probable</b> sale de cuánto se habría equivocado este mismo método en las semanas pasadas para ese día (±1,28 veces el error típico, ≈ 80 %). Los días que casi nunca tienen turno, como el domingo, quedan cerca de cero.</p>
            </ComoSeCalcula>
          </>
        )}
      </section>

      {/* ---------- 3. Temporada ---------- */}
      <section className="panel" aria-labelledby="p-temp">
        <header className="panel__cab"><h2 id="p-temp" className="rotulo">Acumulado de temporada</h2></header>
        {!temporada.ok ? <FaltanDatos d={temporada} /> : (
          <>
            <div className="panel__cuerpo">
              <div className="fila-rotulada fila-rotulada--panel">
                <Medidor rotulo="Acumulado al cierre de hoy" nota={`desde ${diaCorto(diaDesdeClave(temporada.real[0].dia))}`}>
                  <span className="cifra cifra--xl">{entero(temporada.real.at(-1)!.acumulado)}</span><span className="unidad">cajas</span>
                </Medidor>
                <Medidor rotulo={`Promedio diario · ${temporada.ventana} días`} nota="incluye días sin turno">
                  <span className="cifra cifra--xl">{entero(temporada.promedioDiario)}</span><span className="unidad">cajas/día</span>
                </Medidor>
                <Medidor rotulo="En 14 días más" nota={`Rango ${entero(temporada.proyeccion.at(-1)!.bajo)} – ${entero(temporada.proyeccion.at(-1)!.alto)}`}>
                  <span className="cifra cifra--xl">{entero(temporada.proyeccion.at(-1)!.acumulado)}</span><span className="unidad">cajas</span>
                </Medidor>
              </div>
            </div>
            <div className="panel__cuerpo panel__cuerpo--grafico">
              <Leyenda items={[['acero', 'Real'], ['punteada', 'Tendencia'], ['banda', 'Rango probable']]} />
              <GraficoTemporada real={temporada.real} proy={temporada.proyeccion} />
            </div>
            <ComoSeCalcula>
              <p>La tendencia suma, día a día, el <b>promedio diario de los últimos {temporada.ventana} días</b> (contando los días sin turno) a partir del acumulado de hoy. Hoy se cuenta con su estimado de cierre.</p>
              <p>El rango se abre con los días, porque cuanto más lejos, más incertidumbre se acumula: crece con la raíz del número de días.</p>
              <p>No considera el fin de la temporada. Cuando la fruta empiece a bajar, la tendencia lo reflejará con unos días de retraso.</p>
            </ComoSeCalcula>
          </>
        )}
      </section>
    </div>
  )
}

/** Organiza las franjas: hoy, días anteriores (perfil) y totales diarios con ceros. */
function preparar(franjas: FranjaProyeccion[], ahora: number) {
  const hoyClave = claveDia(ahora)
  const porDia = new Map<string, number[]>()
  for (const f of franjas) {
    let d = porDia.get(f.dia)
    if (!d) { d = Array(FRANJAS).fill(0); porDia.set(f.dia, d) }
    d[f.franja] += f.cajas
  }
  const hoy = porDia.get(hoyClave) ?? Array(FRANJAS).fill(0)
  const claves = [...porDia.keys()].filter(k => k < hoyClave).sort()
  const historia28 = claves.filter(k => diaDesdeClave(k) >= sumarDias(inicioDia(ahora), -28)).map(k => porDia.get(k)!)
  const totales: DiaTotal[] = []
  if (claves.length) {
    for (let t = diaDesdeClave(claves[0]); claveDia(t) < hoyClave; t = sumarDias(t + 12 * 3_600_000, 1), t = inicioDia(t)) {
      const k = claveDia(t)
      totales.push({ dia: k, dow: partes(t + 12 * 3_600_000).dow, total: (porDia.get(k) ?? []).reduce((a, b) => a + b, 0) })
    }
  }
  return { hoy, historia28, totales, hoyTotal: hoy.reduce((a, b) => a + b, 0), diasConTurno: claves.length }
}

function FaltanDatos({ d }: { d: SinDatos }) {
  return (
    <div className="panel__cuerpo">
      <div className="aviso">
        <Icono nombre="info" tam={18} />
        <span>Se necesitan al menos <b>{d.necesarios} {d.motivo}</b> para estimar con confianza; hay {d.disponibles}. Mientras tanto no se muestra un número poco confiable.</span>
      </div>
    </div>
  )
}

function ComoSeCalcula({ children }: { children: ReactNode }) {
  return (
    <details className="como">
      <summary><Icono nombre="info" tam={16} />Cómo se calcula</summary>
      <div className="como__texto">{children}</div>
    </details>
  )
}

function Leyenda({ items }: { items: Array<[string, string]> }) {
  return (
    <p className="leyenda">
      {items.map(([t, txt]) => <span key={txt}><i className={`muestra muestra--${t}`} />{txt}</span>)}
    </p>
  )
}

function GraficoCierre({ hoy, fAhora, curva, perfil }: { hoy: number[]; fAhora: number; curva: Array<{ franja: number; mediana: number; bajo: number; alto: number }>; perfil: number[] }) {
  const opcion = useCallback((c: Colores) => {
    // rango visible: desde 1 h antes del primer movimiento típico/real hasta medianoche
    const primeros = [perfil.findIndex(v => v > 0), hoy.findIndex(v => v > 0)].filter(i => i >= 0)
    const f0 = Math.max(0, (primeros.length ? Math.min(...primeros) : 28) - 4)
    const xs = Array.from({ length: FRANJAS + 1 - f0 }, (_, i) => f0 + i)
    const fIni = Math.floor(fAhora)
    const real = xs.map(f => (f <= fIni ? Math.round(acumuladoHasta(hoy, f)) : null))
    const real2 = real.slice(); const iAhora = xs.indexOf(fIni)
    if (iAhora >= 0) real2[iAhora] = Math.round(acumuladoHasta(hoy, fAhora))
    const m = new Map(curva.map(p => [p.franja, p]))
    const med = xs.map(f => (f >= fIni ? Math.round(m.get(f)?.mediana ?? 0) : null))
    const bajo = xs.map(f => (f >= fIni ? Math.round(m.get(f)?.bajo ?? 0) : null))
    const ancho = xs.map(f => (f >= fIni ? Math.round((m.get(f)?.alto ?? 0) - (m.get(f)?.bajo ?? 0)) : null))
    return {
      ...base(c),
      grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
      xAxis: ejeX(c, { type: 'category', boundaryGap: false, data: xs.map(etiquetaFranja), axisLabel: { color: c.tinta3, fontSize: 12, interval: (i: number) => xs[i] % (innerWidth < 700 ? 16 : 8) === 0 } }),
      yAxis: ejeY(c),
      tooltip: {
        ...(base(c).tooltip as object),
        formatter: (ps: Array<{ dataIndex: number }>) => {
          const i = ps[0].dataIndex, f = xs[i], p = m.get(f)
          const filas = [`<b>${etiquetaFranja(f)}</b>`]
          if (real[i] !== null) filas.push(`Hoy: <b>${entero(real[i]!)}</b>`)
          if (p && f >= fIni) filas.push(`Proyección: <b>${entero(p.mediana)}</b> (${entero(p.bajo)} – ${entero(p.alto)})`)
          filas.push(`<span style="color:${c.tinta2}">Día típico: ${entero(perfil[f] ?? 0)}</span>`)
          return filas.join('<br/>')
        },
      },
      series: [
        { name: 'banda-base', type: 'line', data: bajo, stack: 'banda', symbol: 'none', lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
        { name: 'Rango probable', type: 'line', data: ancho, stack: 'banda', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: c.cerezaLavado }, silent: true },
        { name: 'Día típico', type: 'line', data: xs.map(f => Math.round(perfil[f] ?? 0)), symbol: 'none', lineStyle: { width: 1.5, color: c.grisSerie } },
        { name: 'Proyección', type: 'line', data: med, symbol: 'none', lineStyle: { width: 2, color: c.cereza, type: 'dashed' } },
        { name: 'Hoy', type: 'line', data: real2, symbol: 'none', lineStyle: { width: 2, color: c.cereza },
        },
      ],
    }
  }, [hoy, fAhora, curva, perfil])
  return <Grafico opcion={opcion} alto={280} etiqueta="Cajas acumuladas hoy y proyección al cierre"
    tabla={{ columnas: ['Hora', 'Proyección', 'Bajo', 'Alto'], filas: curva.filter(p => p.franja % 4 === 0).map(p => [etiquetaFranja(p.franja), Math.round(p.mediana), Math.round(p.bajo), Math.round(p.alto)]) }} />
}

function GraficoSemana({ dias }: { dias: Array<{ dia: string; dow: number; estimado: number; bajo: number; alto: number; semanasConTurno: number; semanasVistas: number }> }) {
  const opcion = useCallback((c: Colores) => ({
    ...base(c),
    grid: { left: 4, right: 12, top: 16, bottom: 4, containLabel: true },
    xAxis: ejeX(c, { type: 'category', data: dias.map(d => diaCorto(diaDesdeClave(d.dia))) }),
    yAxis: ejeY(c, { min: 0 }),
    tooltip: {
      ...(base(c).tooltip as object), trigger: 'item',
      formatter: (p: { dataIndex: number }) => {
        const d = dias[p.dataIndex]
        return `<b>${diaCorto(diaDesdeClave(d.dia))}</b><br/>Estimado: <b>${entero(d.estimado)}</b><br/>Rango: ${entero(d.bajo)} – ${entero(d.alto)}<br/><span style="color:${c.tinta2}">Hubo turno ${d.semanasConTurno} de ${d.semanasVistas} semanas</span>`
      },
    },
    series: [{
      type: 'custom',
      data: dias.map((d, i) => [i, d.estimado, d.bajo, d.alto]),
      encode: { x: 0, y: [1, 2, 3] },
      renderItem: (_p: unknown, api: { value: (i: number) => number; coord: (v: number[]) => number[]; size: (v: number[]) => number[] }) => {
        const x = api.value(0)
        const [cx, cy] = api.coord([x, api.value(1)])
        const [, yb] = api.coord([x, api.value(2)])
        const [, ya] = api.coord([x, api.value(3)])
        const w = Math.min(24, api.size([1, 0])[0] * 0.5)
        return {
          type: 'group',
          children: [
            { type: 'rect', shape: { x: cx - w / 2, y: ya, width: w, height: Math.max(2, yb - ya), r: 4 }, style: { fill: c.cerezaLavado, stroke: c.cereza, lineWidth: 1, lineDash: [4, 3] } },
            { type: 'circle', shape: { cx, cy, r: 5 }, style: { fill: c.cereza, stroke: c.superficie, lineWidth: 2 } },
          ],
        }
      },
    }],
  }), [dias])
  return <Grafico opcion={opcion} alto={240} etiqueta="Cajas estimadas para los próximos 7 días con su rango probable"
    tabla={{ columnas: ['Día', 'Estimado', 'Bajo', 'Alto', 'Semanas con turno'], numericas: [1, 2, 3], filas: dias.map(d => [diaCorto(diaDesdeClave(d.dia)), d.estimado, d.bajo, d.alto, `${d.semanasConTurno} de ${d.semanasVistas}`]) }} />
}

function GraficoTemporada({ real, proy }: { real: Array<{ dia: string; acumulado: number }>; proy: Array<{ dia: string; acumulado: number; bajo: number; alto: number }> }) {
  const opcion = useCallback((c: Colores) => {
    const xs = [...real.map(r => r.dia), ...proy.map(p => p.dia)]
    const n = real.length
    const ultimo = real[n - 1].acumulado
    const realS = xs.map((_, i) => (i < n ? real[i].acumulado : null))
    const proyS = xs.map((_, i) => (i === n - 1 ? ultimo : i >= n ? proy[i - n].acumulado : null))
    const bajo = xs.map((_, i) => (i === n - 1 ? ultimo : i >= n ? proy[i - n].bajo : null))
    const ancho = xs.map((_, i) => (i === n - 1 ? 0 : i >= n ? proy[i - n].alto - proy[i - n].bajo : null))
    return {
      ...base(c),
      grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
      xAxis: ejeX(c, { type: 'category', boundaryGap: false, data: xs.map(d => diaCorto(diaDesdeClave(d))) }),
      yAxis: ejeY(c),
      tooltip: {
        ...(base(c).tooltip as object),
        formatter: (ps: Array<{ dataIndex: number }>) => {
          const i = ps[0].dataIndex
          if (i < n) return `<b>${diaCorto(diaDesdeClave(xs[i]))}</b><br/>Acumulado real: <b>${entero(real[i].acumulado)}</b>`
          const p = proy[i - n]
          return `<b>${diaCorto(diaDesdeClave(xs[i]))}</b><br/>Tendencia: <b>${entero(p.acumulado)}</b><br/>Rango: ${entero(p.bajo)} – ${entero(p.alto)}`
        },
      },
      series: [
        { type: 'line', data: bajo, stack: 'b', symbol: 'none', lineStyle: { opacity: 0 }, silent: true },
        { type: 'line', data: ancho, stack: 'b', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: c.cerezaLavado }, silent: true },
        { name: 'Real', type: 'line', data: realS, symbol: 'none', lineStyle: { width: 2, color: c.acero }, areaStyle: { color: c.aceroLavado } },
        { name: 'Tendencia', type: 'line', data: proyS, symbol: 'none', lineStyle: { width: 2, color: c.cereza, type: 'dashed' } },
      ],
    }
  }, [real, proy])
  return <Grafico opcion={opcion} alto={260} etiqueta="Cajas acumuladas en la temporada y tendencia de 14 días"
    tabla={{ columnas: ['Día', 'Acumulado', 'Bajo', 'Alto'], filas: [...real.map(r => [diaCorto(diaDesdeClave(r.dia)), r.acumulado, '', '']), ...proy.map(p => [`${diaCorto(diaDesdeClave(p.dia))} (proy.)`, p.acumulado, p.bajo, p.alto])] as Array<Array<string | number>> }} />
}
