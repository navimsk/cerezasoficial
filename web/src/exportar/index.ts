// Exportación a Excel (exceljs, carga diferida), CSV y SQL.
import type { Atasco, Equipo, Evento, FuenteDatos, Punto } from '../datos/tipos'
import { DIA, MIN, claveDia, desfaseMin, partes } from '../lib/tiempo'
import { generarSql } from './sql'

export type Formato = 'xlsx' | 'csv' | 'sql'
export type AlcanceEventos = 'relevantes' | 'todos'

export interface Pedido {
  fuente: FuenteDatos
  equipo: Equipo
  desde: number
  hasta: number
  eventos: AlcanceEventos
  progreso?: (texto: string) => void
}

/** Excel muestra la fecha tal como viene (sin zona): se "corre" a la hora de Chile. */
const fechaLocal = (ms: number) => new Date(ms + desfaseMin(ms) * MIN)
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const RUTINARIOS = new Set(['heartbeat', 'bloque'])

export function nombreArchivo(equipo: Equipo, desde: number, hasta: number, ext: string) {
  return `cajas_${equipo.id}_${claveDia(desde)}_a_${claveDia(hasta - 1)}.${ext}`
}

async function leerEventos(p: Pedido): Promise<Evento[]> {
  p.progreso?.('Leyendo eventos…')
  const evs = await p.fuente.eventos(p.equipo.id, p.desde, p.hasta, 1_000_000)
  return p.eventos === 'todos' ? evs : evs.filter(e => !RUTINARIOS.has(e.tipo))
}

export function descargar(blob: Blob, nombre: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = nombre
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// ---------------- CSV ----------------
const csvCampo = (v: unknown) => {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function fechaTexto(ms: number) {
  const p = partes(ms)
  const d = (n: number) => String(n).padStart(2, '0')
  return `${p.y}-${d(p.m)}-${d(p.d)} ${d(p.h)}:${d(p.min)}:${d(p.s)}`
}

/** CSV para Excel en español: separador ";", coma decimal, UTF-8 con BOM, hora de Chile. */
export function generarCsv(eventos: Evento[]): Blob {
  const cab = ['fecha_hora_chile', 'equipo_id', 'seq', 'tipo', 'n', 'dur_ms', 'avance_mm', 'cajas', 'total', 'vel_mm_s', 'extra']
  const lineas = [cab.join(';')]
  for (const e of eventos) {
    lineas.push([fechaTexto(e.ts), e.equipo_id, e.seq, e.tipo, e.n, e.dur_ms, e.avance_mm, e.cajas, e.total, e.vel_mm_s, e.extra ? JSON.stringify(e.extra) : ''].map(csvCampo).join(';'))
  }
  return new Blob(['﻿', lineas.join('\r\n'), '\r\n'], { type: 'text/csv;charset=utf-8' })
}

// ---------------- SQL ----------------
export function blobSql(eventos: Evento[], p: Pedido): Blob {
  return new Blob([...generarSql(eventos, { equipo: p.equipo, desde: p.desde, hasta: p.hasta })], { type: 'application/sql;charset=utf-8' })
}

// ---------------- Excel ----------------
export async function generarExcel(p: Pedido): Promise<Blob> {
  p.progreso?.('Preparando Excel…')
  const { default: ExcelJS } = await import('exceljs')
  p.progreso?.('Leyendo resumen diario y por hora…')
  const [dias, horas, atascos] = await Promise.all([
    p.fuente.serie(p.equipo.id, p.desde, p.hasta, 'day'),
    p.hasta - p.desde <= 120 * DIA ? p.fuente.serie(p.equipo.id, p.desde, p.hasta, 'hour') : Promise.resolve([] as Punto[]),
    p.fuente.atascos(p.equipo.id, p.desde, p.hasta),
  ])
  const eventos = await leerEventos(p)
  p.progreso?.(`Armando Excel (${eventos.length.toLocaleString('es-CL')} eventos)…`)

  const libro = new ExcelJS.Workbook()
  libro.creator = 'Contador de cajas'
  libro.created = new Date()

  const CAB = { font: { bold: true, color: { argb: 'FFFBFAF7' } }, fill: { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1A1714' } }, alignment: { vertical: 'middle' as const } }
  type Col = { header: string; key: string; width: number; style?: Record<string, unknown> }
  const hoja = (nombre: string, cols: Col[]) => {
    const h = libro.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] })
    h.columns = cols as never
    const fila = h.getRow(1)
    fila.height = 22
    fila.eachCell(c => { c.font = CAB.font; c.fill = CAB.fill; c.alignment = CAB.alignment })
    h.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } }
    return h
  }
  const ENTERO = { numFmt: '#,##0' }

  // Resumen diario
  const hd = hoja('Resumen diario', [
    { header: 'Fecha', key: 'fecha', width: 12, style: { numFmt: 'dd-mm-yyyy' } },
    { header: 'Día', key: 'dia', width: 11 },
    { header: 'Cajas', key: 'cajas', width: 10, style: ENTERO },
    { header: 'Pegadas (estimadas)', key: 'est', width: 19, style: ENTERO },
    { header: 'Corregidas por atasco', key: 'aj', width: 21, style: ENTERO },
    { header: 'Atascos', key: 'at', width: 9, style: ENTERO },
  ])
  for (const d of dias) hd.addRow({ fecha: fechaLocal(d.inicio), dia: DIAS[partes(d.inicio + 12 * 3_600_000).dow], cajas: d.cajas, est: d.estimadas, aj: d.ajustes, at: d.atascos })
  const total = hd.addRow({ fecha: null, dia: 'Total', cajas: { formula: `SUM(C2:C${dias.length + 1})` }, est: { formula: `SUM(D2:D${dias.length + 1})` }, aj: { formula: `SUM(E2:E${dias.length + 1})` }, at: { formula: `SUM(F2:F${dias.length + 1})` } })
  total.font = { bold: true }

  // Por hora
  const hh = hoja('Por hora', [
    { header: 'Fecha y hora', key: 'fh', width: 17, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
    { header: 'Cajas', key: 'cajas', width: 10, style: ENTERO },
    { header: 'Pegadas (estimadas)', key: 'est', width: 19, style: ENTERO },
    { header: 'Corregidas por atasco', key: 'aj', width: 21, style: ENTERO },
    { header: 'Atascos', key: 'at', width: 9, style: ENTERO },
  ])
  for (const h of horas) if (h.cajas || h.atascos) hh.addRow({ fh: fechaLocal(h.inicio), cajas: h.cajas, est: h.estimadas, aj: h.ajustes, at: h.atascos })
  if (!horas.length) hh.addRow({ fh: null, cajas: null }).getCell(1).value = 'Rango mayor a 120 días: use el resumen diario.'

  // Eventos
  const he = hoja('Eventos', [
    { header: 'Fecha y hora', key: 'ts', width: 20, style: { numFmt: 'dd-mm-yyyy hh:mm:ss' } },
    { header: 'Seq', key: 'seq', width: 10 },
    { header: 'Tipo', key: 'tipo', width: 15 },
    { header: 'n', key: 'n', width: 5 },
    { header: 'Duración (ms)', key: 'dur', width: 13, style: ENTERO },
    { header: 'Avance (mm)', key: 'av', width: 12, style: ENTERO },
    { header: 'Cajas en bloque', key: 'cb', width: 15 },
    { header: 'Total sesión', key: 'tot', width: 12, style: ENTERO },
    { header: 'Velocidad (mm/s)', key: 'vel', width: 16, style: ENTERO },
    { header: 'Datos del equipo', key: 'extra', width: 40 },
  ])
  for (const e of eventos) {
    he.addRow({ ts: fechaLocal(e.ts), seq: e.seq, tipo: e.tipo, n: e.n, dur: e.dur_ms, av: e.avance_mm, cb: e.cajas, tot: e.total, vel: e.vel_mm_s, extra: e.extra ? JSON.stringify(e.extra) : null })
  }

  // Atascos
  const ha = hoja('Atascos', [
    { header: 'Inicio', key: 'ini', width: 20, style: { numFmt: 'dd-mm-yyyy hh:mm:ss' } },
    { header: 'Fin', key: 'fin', width: 20, style: { numFmt: 'dd-mm-yyyy hh:mm:ss' } },
    { header: 'Duración (min)', key: 'dur', width: 14, style: { numFmt: '0.0' } },
    { header: 'Cajas corregidas', key: 'cc', width: 16, style: ENTERO },
  ])
  for (const a of atascos as Atasco[]) ha.addRow({ ini: fechaLocal(a.inicio), fin: a.fin ? fechaLocal(a.fin) : 'sin cerrar', dur: a.durMs !== null ? a.durMs / 60_000 : null, cc: a.cajasRevertidas })

  p.progreso?.('Guardando archivo…')
  const buf = await libro.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

export async function exportar(formato: Formato, p: Pedido): Promise<{ blob: Blob; nombre: string }> {
  if (formato === 'xlsx') return { blob: await generarExcel(p), nombre: nombreArchivo(p.equipo, p.desde, p.hasta, 'xlsx') }
  const eventos = await leerEventos(p)
  p.progreso?.(`Armando archivo (${eventos.length.toLocaleString('es-CL')} eventos)…`)
  if (formato === 'csv') return { blob: generarCsv(eventos), nombre: nombreArchivo(p.equipo, p.desde, p.hasta, 'csv') }
  return { blob: blobSql(eventos, p), nombre: nombreArchivo(p.equipo, p.desde, p.hasta, 'sql') }
}
