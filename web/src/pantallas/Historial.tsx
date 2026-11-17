import { useCallback, useMemo, useState } from 'react'
import { useDatos } from '../datos/contexto'
import type { Punto } from '../datos/tipos'
import { useConsulta } from '../lib/consulta'
import { useAhora } from '../lib/hooks'
import { decimal1, diaCorto, entero, fecha, hora, porcentaje } from '../lib/formato'
import { DIA, claveDia, diaDesdeClave, inicioDia, partes, sumarDias, type Paso } from '../lib/tiempo'
import { NOMBRES_PASO, NOMBRES_RANGO, claveInput, construirRango, pasosPara, rangoAnterior, type TipoRango } from '../lib/rangos'
import { Grafico, TablaVista, base, compacto, ejeX, ejeY, type Colores } from '../graficos/Grafico'
import { Medidor } from '../componentes/Medidores'
import { Icono } from '../componentes/Icono'

const TIPOS: TipoRango[] = ['hoy', 'ayer', 'semana', 'mes', 'temporada', 'personalizado']

export function etiquetaPunto(t: number, paso: Paso, multiDia: boolean): string {
  switch (paso) {
    case 'minute': return hora(t)
    case 'hour': return multiDia ? `${diaCorto(t)} ${hora(t)}` : hora(t)
    case 'day': return diaCorto(t)
    case 'week': return `sem. ${diaCorto(t).replace(/^\S+\s/, '')}`
    case 'month': { const p = partes(t); return new Intl.DateTimeFormat('es-CL', { month: 'short', year: 'numeric', timeZone: 'America/Santiago' }).format(t).replace('.', '') || `${p.m}/${p.y}` }
  }
}

export function Historial() {
  const { fuente, equipo } = useDatos()
  const ahora = useAhora(60_000)
  const id = equipo?.id ?? null
  const [tipo, setTipo] = useState<TipoRango>(() => (sessionStorage.getItem('hist.tipo') as TipoRango) || 'semana')
  const [desdeTxt, setDesdeTxt] = useState(() => claveInput(sumarDias(ahora, -6)))
  const [hastaTxt, setHastaTxt] = useState(() => claveInput(ahora))
  const primer = useConsulta<number | null>(id && `primer.${id}`, () => fuente.primerDato(id!))

  const rango = useMemo(() => construirRango(tipo, ahora, { primerDato: primer.datos, desde: desdeTxt, hasta: hastaTxt }), [tipo, ahora, primer.datos, desdeTxt, hastaTxt])
  const pasos = pasosPara(rango)
  const [pasoElegido, setPaso] = useState<Paso | null>(null)
  const paso = pasoElegido && pasos.includes(pasoElegido) ? pasoElegido : pasos[0]
  const anterior = rangoAnterior(rango)

  const claveA = id && `hist.${id}.${rango.desde}.${Math.floor(rango.hasta / 60_000)}.${paso}`
  const serieA = useConsulta<Punto[]>(claveA, () => fuente.serie(id!, rango.desde, rango.hasta, paso), { cache: tipo !== 'personalizado' })
  const pasoComp: Paso = (rango.hasta - rango.desde) <= 2 * DIA ? 'hour' : 'day'
  const serieAc = useConsulta<Punto[]>(id && anterior && `histc.${id}.${rango.desde}.${Math.floor(rango.hasta / 60_000)}.${pasoComp}`, () => fuente.serie(id!, rango.desde, rango.hasta, pasoComp), { cache: false })
  const serieB = useConsulta<Punto[]>(id && anterior && `histb.${id}.${anterior.desde}.${Math.floor(anterior.hasta / 60_000)}.${pasoComp}`, () => fuente.serie(id!, anterior!.desde, anterior!.hasta, pasoComp), { cache: false })
  // mapa de calor: hasta 42 días hacia atrás desde el fin del rango
  const calorDesde = Math.max(rango.desde, inicioDia(sumarDias(rango.hasta, -41)))
  const calor = useConsulta<Punto[]>(id && `calor.${id}.${calorDesde}.${Math.floor(rango.hasta / 60_000)}`, () => fuente.serie(id!, calorDesde, rango.hasta, 'hour'), { cache: false })

  const elegir = (t: TipoRango) => { setTipo(t); setPaso(null); try { sessionStorage.setItem('hist.tipo', t) } catch { /* nada */ } }
  const puntos = serieA.datos ?? []
  const total = puntos.reduce((a, p) => a + p.cajas, 0)
  const estimadas = puntos.reduce((a, p) => a + p.estimadas, 0)
  const ajustes = puntos.reduce((a, p) => a + p.ajustes, 0)
  const atascos = puntos.reduce((a, p) => a + p.atascos, 0)
  const totalB = serieB.datos?.reduce((a, p) => a + p.cajas, 0) ?? null
  const mejor = puntos.reduce<Punto | null>((m, p) => (!m || p.cajas > m.cajas ? p : m), null)
  const multiDia = rango.hasta - rango.desde > DIA + 3_600_000
  const diasActivos = new Set((calor.datos ?? []).filter(p => p.cajas > 0).map(p => claveDia(p.inicio))).size

  return (
    <div className="pantalla">
      <div className="cabeza-pantalla">
        <h1 className="titulo-pantalla">Historial</h1>
        <span className="nota nota--tenue">{fecha(rango.desde)} – {fecha(rango.hasta - 1)}</span>
      </div>

      <div className="filtros" role="group" aria-label="Rango y detalle">
        <div className="segmentado" role="group" aria-label="Rango">
          {TIPOS.map(t => <button key={t} type="button" aria-pressed={tipo === t} onClick={() => elegir(t)}>{NOMBRES_RANGO[t]}</button>)}
        </div>
        {tipo === 'personalizado' && (
          <div className="filtros__fechas">
            <label className="campo"><span className="rotulo">Desde</span><input type="date" value={desdeTxt} max={hastaTxt} onChange={e => e.target.value && setDesdeTxt(e.target.value)} /></label>
            <label className="campo"><span className="rotulo">Hasta</span><input type="date" value={hastaTxt} min={desdeTxt} max={claveInput(ahora)} onChange={e => e.target.value && setHastaTxt(e.target.value)} /></label>
          </div>
        )}
        {pasos.length > 1 && (
          <div className="segmentado" role="group" aria-label="Detalle">
            {pasos.map(p => <button key={p} type="button" aria-pressed={paso === p} onClick={() => setPaso(p)}>{NOMBRES_PASO[p]}</button>)}
          </div>
        )}
      </div>

      <div className="fila-rotulada">
        <Medidor rotulo={`Cajas · ${rango.etiqueta.toLowerCase()}`} nota={totalB !== null && anterior ? <>{porcentajeTexto(total, totalB)} vs {anterior.etiqueta.toLowerCase()}</> : undefined}>
          <span className="cifra cifra--xl">{serieA.datos ? entero(total) : '—'}</span>
        </Medidor>
        <Medidor rotulo={multiDia ? 'Promedio por día con turno' : 'Promedio por hora con turno'}
          nota={multiDia ? `${entero(diasActivos)} días con datos` : undefined}>
          <span className="cifra cifra--xl">{promedio(puntos, multiDia, calor.datos)}</span>
        </Medidor>
        <Medidor rotulo={`Máximo ${paso === 'hour' ? 'por hora' : paso === 'day' ? 'por día' : paso === 'week' ? 'por semana' : 'por mes'}`} nota={mejor && mejor.cajas > 0 ? etiquetaPunto(mejor.inicio, paso, multiDia) : undefined}>
          <span className="cifra cifra--xl">{mejor ? entero(mejor.cajas) : '—'}</span>
        </Medidor>
        <Medidor rotulo="Atascos" nota={`${entero(ajustes)} cajas corregidas · ${total ? decimal1((estimadas / total) * 100) : '0'} % pegadas`}>
          <span className="cifra cifra--xl">{entero(atascos)}</span>
        </Medidor>
      </div>

      <section className="panel" aria-labelledby="h-graf">
        <header className="panel__cab">
          <h2 id="h-graf" className="rotulo">Cajas {NOMBRES_PASO[paso]?.toLowerCase()}</h2>
          <span className="nota nota--tenue leyenda-mini"><i className="muestra muestra--acero" />cerrado <i className="muestra muestra--cereza" />en curso</span>
        </header>
        <div className="panel__cuerpo panel__cuerpo--grafico">
          {serieA.datos && total === 0
            ? <Vacio />
            : <GraficoPrincipal puntos={puntos} paso={paso} multiDia={multiDia} ahora={ahora} atenuado={serieA.cargando} />}
        </div>
      </section>

      <div className="rejilla-2">
        <section className="panel" aria-labelledby="h-calor">
          <header className="panel__cab">
            <h2 id="h-calor" className="rotulo">Mapa de calor · día × hora</h2>
            {calorDesde > rango.desde && <span className="nota nota--tenue">últimos 42 días del rango</span>}
          </header>
          <div className="panel__cuerpo panel__cuerpo--grafico">
            <MapaCalor puntos={calor.datos ?? []} atenuado={calor.cargando} />
          </div>
        </section>

        <section className="panel" aria-labelledby="h-comp">
          <header className="panel__cab">
            <h2 id="h-comp" className="rotulo">Comparación</h2>
            {anterior && totalB !== null && <span className="nota nota--tenue">{entero(total)} vs {entero(totalB)}</span>}
          </header>
          <div className="panel__cuerpo panel__cuerpo--grafico">
            {anterior
              ? <Comparacion a={serieAc.datos ?? []} b={serieB.datos ?? []} paso={pasoComp} etiquetaA={rango.etiqueta} etiquetaB={anterior.etiqueta} />
              : <div className="aviso"><Icono nombre="info" tam={18} /><span>La temporada completa no tiene un periodo anterior con qué comparar. Elige semana, mes o fechas.</span></div>}
          </div>
        </section>
      </div>

      <section className="panel" aria-labelledby="h-tabla">
        <header className="panel__cab">
          <h2 id="h-tabla" className="rotulo">Detalle {NOMBRES_PASO[paso]?.toLowerCase()}</h2>
          <span className="nota nota--tenue">{entero(puntos.length)} filas</span>
        </header>
        <TablaVista alto={420} tabla={{
          columnas: [paso === 'hour' ? 'Hora' : paso === 'day' ? 'Día' : paso === 'week' ? 'Semana' : 'Mes', 'Cajas', 'Pegadas (est.)', 'Corregidas', 'Atascos'],
          filas: puntos.slice().reverse().map(p => [etiquetaPunto(p.inicio, paso, multiDia), p.cajas, p.estimadas, p.ajustes, p.atascos]),
        }} />
      </section>
    </div>
  )
}

function porcentajeTexto(a: number, b: number) {
  if (!b) return 'sin datos'
  return porcentaje((a - b) / b)
}

function promedio(puntos: Punto[], multiDia: boolean, calor: Punto[] | null): string {
  if (!puntos.length) return '—'
  if (multiDia) {
    const porDia = new Map<string, number>()
    for (const p of calor ?? []) if (p.cajas > 0) porDia.set(claveDia(p.inicio), (porDia.get(claveDia(p.inicio)) ?? 0) + p.cajas)
    const total = puntos.reduce((a, p) => a + p.cajas, 0)
    return porDia.size ? entero(total / porDia.size) : '—'
  }
  const activos = puntos.filter(p => p.cajas > 0)
  return activos.length ? entero(activos.reduce((a, p) => a + p.cajas, 0) / activos.length) : '—'
}

function Vacio() {
  return <div className="aviso"><Icono nombre="info" tam={18} /><span>Sin cajas en este rango. El equipo envía datos al encenderse; revisa en Equipos si está conectado.</span></div>
}

function GraficoPrincipal({ puntos, paso, multiDia, ahora, atenuado }: { puntos: Punto[]; paso: Paso; multiDia: boolean; ahora: number; atenuado: boolean }) {
  const muchos = puntos.length > 40
  const opcion = useCallback((c: Colores) => {
    const enCurso = (i: number) => i === puntos.length - 1 && ahora - puntos[i].inicio < (paso === 'hour' ? 3_600_000 : paso === 'day' ? DIA : 31 * DIA)
    return {
      ...base(c),
      grid: { left: 4, right: 8, top: 16, bottom: muchos ? 48 : 4, containLabel: true },
      xAxis: ejeX(c, { type: 'category', data: puntos.map(p => etiquetaPunto(p.inicio, paso, multiDia)) }),
      yAxis: ejeY(c),
      dataZoom: muchos ? [
        { type: 'inside', start: Math.max(0, 100 - (40 / puntos.length) * 100), end: 100 },
        { type: 'slider', height: 24, bottom: 8, borderColor: c.linea, fillerColor: c.aceroLavado, handleStyle: { color: c.superficie, borderColor: c.lineaFuerte },
          dataBackground: { lineStyle: { color: c.lineaFuerte }, areaStyle: { color: c.linea } }, textStyle: { color: c.tinta3 }, brushSelect: false },
      ] : undefined,
      tooltip: {
        ...(base(c).tooltip as object), axisPointer: { type: 'shadow', shadowStyle: { color: c.aceroLavado } },
        formatter: (ps: Array<{ dataIndex: number }>) => {
          const p = puntos[ps[0].dataIndex]
          return `<b>${etiquetaPunto(p.inicio, paso, true)}</b><br/>${entero(p.cajas)} cajas` +
            (p.estimadas ? `<br/><span style="color:${c.tinta2}">${entero(p.estimadas)} pegadas (estimadas)</span>` : '') +
            (p.atascos ? `<br/><span style="color:${c.tinta2}">${entero(p.atascos)} atascos · ${entero(p.ajustes)} corregidas</span>` : '')
        },
      },
      series: [{
        type: 'bar', barMaxWidth: 24, barMinWidth: 2, barCategoryGap: '20%',
        data: puntos.map((p, i) => ({ value: Math.max(0, p.cajas), itemStyle: { color: enCurso(i) ? c.cereza : c.acero, borderRadius: [4, 4, 0, 0] } })),
      }],
    }
  }, [puntos, paso, multiDia, ahora, muchos])
  return <Grafico opcion={opcion} alto={muchos ? 300 : 260} atenuado={atenuado} etiqueta={`Cajas ${NOMBRES_PASO[paso]?.toLowerCase()}`} />
}

function MapaCalor({ puntos, atenuado }: { puntos: Punto[]; atenuado: boolean }) {
  const datos = useMemo(() => {
    const dias = [...new Set(puntos.map(p => claveDia(p.inicio)))].sort().reverse()   // más reciente arriba
    const horas = puntos.filter(p => p.cajas > 0).map(p => partes(p.inicio).h)
    const h0 = horas.length ? Math.min(...horas) : 6, h1 = horas.length ? Math.max(...horas) : 22
    const celdas: Array<[number, number, number]> = []
    let max = 0
    for (const p of puntos) {
      const h = partes(p.inicio).h
      if (h < h0 || h > h1) continue
      const y = dias.indexOf(claveDia(p.inicio))
      celdas.push([h - h0, y, p.cajas])
      max = Math.max(max, p.cajas)
    }
    const etiquetasDia = dias.map(d => diaCorto(diaDesdeClave(d)))
    return { dias, etiquetasDia, h0, h1, celdas, max }
  }, [puntos])

  const opcion = useCallback((c: Colores) => ({
    ...base(c),
    tooltip: {
      ...(base(c).tooltip as object), trigger: 'item',
      formatter: (p: { value: [number, number, number] }) => `${datos.etiquetasDia[p.value[1]]} · ${String(p.value[0] + datos.h0).padStart(2, '0')}:00<br/><b>${entero(p.value[2])}</b> cajas`,
    },
    grid: { left: 4, right: 8, top: 4, bottom: 44, containLabel: true },
    xAxis: { type: 'category', data: Array.from({ length: datos.h1 - datos.h0 + 1 }, (_, i) => `${datos.h0 + i}`), splitArea: { show: false },
      axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: c.tinta3, fontSize: 11, interval: 1 } },
    yAxis: { type: 'category', data: datos.etiquetasDia, axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: c.tinta3, fontSize: 11, interval: datos.dias.length > 16 ? Math.ceil(datos.dias.length / 16) - 1 : 0 } },
    visualMap: {
      min: 0, max: Math.max(1, datos.max), calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 12, itemHeight: 140,
      text: ['más', 'menos'], textStyle: { color: c.tinta3, fontSize: 11 },
      inRange: { color: c.seq.slice(1) }, outOfRange: { color: c.superficie },
      formatter: (v: number) => compacto(v),
    },
    series: [{
      type: 'heatmap', data: datos.celdas.map(([x, y, v]) => (v > 0 ? [x, y, v] : { value: [x, y, v], itemStyle: { color: c.superficie } })),
      itemStyle: { borderColor: c.superficie, borderWidth: 2, borderRadius: 2 },
      emphasis: { itemStyle: { borderColor: c.tinta, borderWidth: 1 } },
    }],
  }), [datos])

  const alto = Math.min(640, Math.max(200, datos.dias.length * 22 + 70))
  return (
    <Grafico opcion={opcion} alto={alto} atenuado={atenuado} etiqueta="Mapa de calor de cajas por día y hora"
      tabla={{
        columnas: ['Día', ...Array.from({ length: datos.h1 - datos.h0 + 1 }, (_, i) => `${datos.h0 + i} h`)],
        filas: datos.dias.map((_, y) => [datos.etiquetasDia[y], ...Array.from({ length: datos.h1 - datos.h0 + 1 }, (_, x) => datos.celdas.find(cc => cc[0] === x && cc[1] === y)?.[2] ?? 0)]),
      }} />
  )
}

function Comparacion({ a, b, paso, etiquetaA, etiquetaB }: { a: Punto[]; b: Punto[]; paso: Paso; etiquetaA: string; etiquetaB: string }) {
  // Acumulado alineado por posición (hora 0.. o día 1..)
  const { ac, bc, etiquetas } = useMemo(() => {
    const n = Math.max(a.length, b.length)
    const acum = (s: Punto[]) => { let t = 0; return s.map(p => (t += p.cajas)) }
    return {
      ac: acum(a), bc: acum(b),
      etiquetas: Array.from({ length: n }, (_, i) => (paso === 'hour' ? `${String(partes((a[i] ?? b[i]).inicio).h).padStart(2, '0')}:00` : `día ${i + 1}`)),
    }
  }, [a, b, paso])
  const opcion = useCallback((c: Colores) => ({
    ...base(c),
    legend: { top: 0, left: 0, itemWidth: 16, itemHeight: 2, icon: 'rect', textStyle: { color: c.tinta2, fontSize: 12 } },
    grid: { left: 4, right: 56, top: 32, bottom: 4, containLabel: true },
    xAxis: ejeX(c, { type: 'category', data: etiquetas, boundaryGap: false }),
    yAxis: ejeY(c),
    tooltip: {
      ...(base(c).tooltip as object),
      formatter: (ps: Array<{ seriesName: string; value: number; dataIndex: number; color: string }>) =>
        `<b>${etiquetas[ps[0].dataIndex]}</b> (acumulado)<br/>` + ps.map(p => `<span style="display:inline-block;width:10px;height:2px;background:${p.color};vertical-align:middle;margin-right:6px"></span>${p.seriesName}: <b>${entero(p.value)}</b>`).join('<br/>'),
    },
    series: [
      { name: etiquetaA, type: 'line', data: ac, symbol: 'none', lineStyle: { width: 2, color: c.cereza }, itemStyle: { color: c.cereza },
        endLabel: { show: true, color: c.tinta, fontSize: 12, formatter: (p: { value: number }) => entero(p.value) } },
      { name: etiquetaB, type: 'line', data: bc, symbol: 'none', lineStyle: { width: 2, color: c.acero }, itemStyle: { color: c.acero },
        endLabel: { show: true, color: c.tinta2, fontSize: 12, formatter: (p: { value: number }) => entero(p.value) } },
    ],
  }), [ac, bc, etiquetas, etiquetaA, etiquetaB])
  return (
    <Grafico opcion={opcion} alto={260} etiqueta={`Cajas acumuladas: ${etiquetaA} contra ${etiquetaB}`}
      tabla={{ columnas: ['Punto', etiquetaA, etiquetaB], filas: etiquetas.map((e, i) => [e, ac[i] ?? '—', bc[i] ?? '—']) }} />
  )
}
