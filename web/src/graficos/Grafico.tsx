// Envoltorio de Apache ECharts: tema desde los tokens CSS (DESIGN.md §6), redimensiona solo,
// se re-pinta al cambiar claro/oscuro, y siempre ofrece la vista de tabla equivalente.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, CustomChart, HeatmapChart, LineChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

echarts.use([BarChart, CustomChart, LineChart, HeatmapChart, GridComponent, TooltipComponent, DataZoomComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, VisualMapComponent, SVGRenderer])

export interface Colores {
  superficie: string; fondo: string; tinta: string; tinta2: string; tinta3: string; linea: string; lineaFuerte: string
  cereza: string; cerezaLavado: string; acero: string; aceroLavado: string; grisSerie: string
  atasco: string; seq: string[]
  fuente: string; fuenteCifra: string
}

function leerColores(): Colores {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  return {
    superficie: v('--superficie'), fondo: v('--fondo'), tinta: v('--tinta'), tinta2: v('--tinta-2'), tinta3: v('--tinta-3'),
    linea: v('--linea'), lineaFuerte: v('--linea-fuerte'), cereza: v('--cereza'), cerezaLavado: v('--cereza-lavado'),
    acero: v('--acero'), aceroLavado: v('--acero-lavado'), grisSerie: v('--gris-serie'), atasco: v('--atasco'),
    seq: [0, 1, 2, 3, 4, 5, 6].map(i => v(`--seq-${i}`)),
    fuente: v('--f-texto'), fuenteCifra: v('--f-cifra'),
  }
}

// Clave que cambia con el tema efectivo (sistema o data-theme)
function suscribirTema(cb: () => void) {
  const mq = matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', cb)
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => { mq.removeEventListener('change', cb); mo.disconnect() }
}
const claveTema = () => `${document.documentElement.dataset.theme ?? ''}|${matchMedia('(prefers-color-scheme: dark)').matches}`

export function useColores(): Colores {
  const clave = useSyncExternalStore(suscribirTema, claveTema, () => 'ssr')
  const [c, setC] = useState<Colores>(leerColores)
  useEffect(() => { setC(leerColores()) }, [clave])
  return c
}

/** Opciones base comunes: ejes recesivos, grilla de filete, tooltip sobrio. */
export function base(c: Colores): EChartsCoreOption {
  return {
    animationDuration: 250,
    animationDurationUpdate: 200,
    textStyle: { fontFamily: c.fuente, color: c.tinta2 },
    tooltip: {
      trigger: 'axis', confine: true, borderWidth: 1, borderColor: c.lineaFuerte, backgroundColor: c.superficie,
      padding: [8, 10], textStyle: { color: c.tinta, fontFamily: c.fuente, fontSize: 13 },
      extraCssText: 'box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06); border-radius: 4px;',
      axisPointer: { type: 'line', lineStyle: { color: c.lineaFuerte, width: 1, type: 'solid' } },
    },
    grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
  }
}

export function ejeX(c: Colores, extra: Record<string, unknown> = {}) {
  return {
    axisLine: { lineStyle: { color: c.lineaFuerte } }, axisTick: { show: false },
    axisLabel: { color: c.tinta3, fontSize: 12, fontFamily: c.fuente, hideOverlap: true },
    splitLine: { show: false }, ...extra,
  }
}
export function ejeY(c: Colores, extra: Record<string, unknown> = {}) {
  return {
    type: 'value', axisLine: { show: false }, axisTick: { show: false }, minInterval: 1,
    axisLabel: { color: c.tinta3, fontSize: 12, fontFamily: c.fuente, formatter: (v: number) => compacto(v) },
    splitLine: { lineStyle: { color: c.linea, width: 1, type: 'solid' } }, ...extra,
  }
}

export function compacto(v: number): string {
  if (Math.abs(v) >= 10_000) return `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(v / 1000)} mil`
  return new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(v)
}

export interface Tabla { columnas: string[]; filas: Array<Array<string | number>>; numericas?: number[] }

/** Un gráfico con su vista de tabla. `opcion` se recalcula con los colores del tema. */
export function Grafico({ opcion, alto = 240, etiqueta, tabla, atenuado = false, alClic }: {
  opcion: (c: Colores) => EChartsCoreOption
  alto?: number | string
  etiqueta: string
  tabla?: Tabla
  atenuado?: boolean
  alClic?: (p: { dataIndex: number; seriesIndex: number }) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const graf = useRef<echarts.ECharts | null>(null)
  const colores = useColores()
  const [verTabla, setVerTabla] = useState(false)

  useEffect(() => {
    if (!ref.current) return
    const g = echarts.init(ref.current, undefined, { renderer: 'svg' })
    graf.current = g
    const ro = new ResizeObserver(() => g.resize())
    ro.observe(ref.current)
    return () => { ro.disconnect(); g.dispose(); graf.current = null }
  }, [])

  useEffect(() => {
    graf.current?.setOption(opcion(colores), { notMerge: true, lazyUpdate: true })
  }, [opcion, colores])

  useEffect(() => {
    const g = graf.current
    if (!g || !alClic) return
    const h = (p: unknown) => alClic(p as { dataIndex: number; seriesIndex: number })
    g.on('click', h)
    return () => { g.off('click', h) }
  }, [alClic])

  return (
    <figure className="grafico">
      <div ref={ref} className="grafico__lienzo" style={{ height: alto, opacity: atenuado ? 0.55 : 1 }} role="img" aria-label={etiqueta} hidden={verTabla} />
      {verTabla && tabla && <TablaVista tabla={tabla} />}
      {tabla && (
        <figcaption>
          <button type="button" className="enlace enlace--chico" aria-pressed={verTabla} onClick={() => setVerTabla(v => !v)}>
            {verTabla ? 'Ver gráfico' : 'Ver como tabla'}
          </button>
        </figcaption>
      )}
    </figure>
  )
}

export function TablaVista({ tabla, alto = 360 }: { tabla: Tabla; alto?: number }): ReactNode {
  const num = new Set(tabla.numericas ?? tabla.columnas.map((_, i) => i).slice(1))
  return (
    <div className="tabla-envoltorio" style={{ maxHeight: alto }} tabIndex={0} role="region" aria-label="Tabla de datos (se puede desplazar)">
      <table className="tabla">
        <thead><tr>{tabla.columnas.map((c, i) => <th key={c} className={num.has(i) ? 'num' : undefined} scope="col">{c}</th>)}</tr></thead>
        <tbody>
          {tabla.filas.map((f, i) => (
            <tr key={i}>{f.map((v, j) => <td key={j} className={num.has(j) ? 'num' : undefined}>{typeof v === 'number' ? new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(v) : v}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
