import { simularDia } from '../src/demo/simulador.ts'
import { desdeLocal, partes, sumarDias, inicioDia } from '../src/lib/tiempo.ts'
const hoy = inicioDia(Date.now())
let seq = 1
for (let i = 14; i >= 1; i--) {
  const d = inicioDia(sumarDias(hoy + 12*3600e3, -i))
  const r = simularDia({ equipoId: 'linea-1', semilla: 20261115, diaInicio: d, indiceTemporada: (45 - i) / 45, seqInicio: seq })
  seq = r.seqFin
  const p = partes(d)
  const cajas = r.eventos.reduce((a, e) => a + e.n, 0)
  const cuenta = (t: string) => r.eventos.filter(e => e.tipo === t).length
  const h = (ms: number) => { const q = partes(ms); return `${String(q.h).padStart(2,'0')}:${String(q.min).padStart(2,'0')}` }
  console.log(`${p.y}-${p.m}-${p.d} dow${p.dow} ${r.plan.activo ? h(r.plan.encendido)+'-'+h(r.plan.apagado) : 'inactivo   '} cajas=${cajas} est=${cuenta('caja_est')} ajustes=${cuenta('ajuste')} atascos=${cuenta('atasco_inicio')} eventos=${r.eventos.length} perdidos=${r.seqFin - (r.eventos.length ? r.eventos[0].seq : r.seqFin) - r.eventos.length}`)
}
