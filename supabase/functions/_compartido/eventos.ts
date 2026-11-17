// Validación de eventos del contador (sin dependencias: se usa en Deno y se prueba en Node).

export const TIPOS = new Set([
  'caja', 'caja_est', 'ajuste', 'bloque', 'atasco_inicio', 'atasco_fin',
  'cinta_detenida', 'cinta_marcha', 'bloqueo_inicial', 'inicio', 'heartbeat',
])

export const MAX_LOTE = 500

export interface EventoEntrada {
  equipo_id?: string
  seq: number
  tipo: string
  n?: number
  ts?: string
  dur_ms?: number
  avance_mm?: number
  cajas?: number
  total?: number
  vel_mm_s?: number
  extra?: Record<string, unknown>
}

const esNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v)

/** Devuelve null si el evento es válido, o el motivo del rechazo. */
export function validarEvento(e: unknown): string | null {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return 'no_es_objeto'
  const o = e as Record<string, unknown>
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 1) return 'seq_invalido'
  if (typeof o.tipo !== 'string' || !TIPOS.has(o.tipo)) return 'tipo_invalido'
  if (o.n !== undefined && (!Number.isInteger(o.n) || Math.abs(o.n as number) > 100)) return 'n_invalido'
  if (o.ts !== undefined && (typeof o.ts !== 'string' || Number.isNaN(Date.parse(o.ts)))) return 'ts_invalido'
  for (const k of ['dur_ms', 'avance_mm', 'cajas', 'total', 'vel_mm_s'] as const) {
    if (o[k] !== undefined && o[k] !== null && !esNum(o[k])) return `${k}_invalido`
  }
  if (o.extra !== undefined && o.extra !== null && (typeof o.extra !== 'object' || Array.isArray(o.extra))) return 'extra_invalido'
  if (o.equipo_id !== undefined && typeof o.equipo_id !== 'string') return 'equipo_invalido'
  // n debe ser coherente con el tipo
  const n = (o.n as number | undefined) ?? 0
  if ((o.tipo === 'caja' || o.tipo === 'caja_est') && n !== 1) return 'n_incoherente'
  if (o.tipo === 'ajuste' && n > 0) return 'n_incoherente'
  if (!['caja', 'caja_est', 'ajuste'].includes(o.tipo as string) && n !== 0) return 'n_incoherente'
  return null
}

export interface ResultadoValidacion {
  validos: EventoEntrada[]
  rechazados: Array<{ indice: number; seq?: unknown; motivo: string }>
}

export function validarLote(cuerpo: unknown): ResultadoValidacion | { error: string } {
  const lista = Array.isArray(cuerpo) ? cuerpo : [cuerpo]
  if (lista.length > MAX_LOTE) return { error: `lote_muy_grande (máximo ${MAX_LOTE})` }
  const validos: EventoEntrada[] = []
  const rechazados: ResultadoValidacion['rechazados'] = []
  lista.forEach((e, indice) => {
    const motivo = validarEvento(e)
    if (motivo) rechazados.push({ indice, seq: (e as { seq?: unknown })?.seq, motivo })
    else validos.push(e as EventoEntrada)
  })
  return { validos, rechazados }
}

export async function sha256Hex(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Comparación de cadenas en tiempo constante (para secretos). */
export function igualSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}
