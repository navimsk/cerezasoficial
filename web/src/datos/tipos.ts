import type { Paso } from '../lib/tiempo'

export type TipoEvento =
  | 'caja' | 'caja_est' | 'ajuste' | 'bloque'
  | 'atasco_inicio' | 'atasco_fin' | 'cinta_detenida' | 'cinta_marcha'
  | 'bloqueo_inicial' | 'inicio' | 'heartbeat'

/** Un evento tal como lo envía el equipo (columna ts como epoch ms). */
export interface Evento {
  equipo_id: string
  seq: number
  tipo: TipoEvento
  n: number
  ts: number
  dur_ms?: number | null
  avance_mm?: number | null
  cajas?: number | null
  total?: number | null
  vel_mm_s?: number | null
  extra?: ExtraHeartbeat | null
}

export interface ExtraHeartbeat {
  estado?: string
  haz?: boolean
  rssi?: number
  pendientes?: number
  filtrados?: number
  uptime_s?: number
  perdidos_cola?: number
}

export interface Equipo {
  id: string; nombre: string; largo_caja_mm: number
  /** Velocidad de la cinta fijada desde la app (null = el equipo usa la que aprende). */
  vel_cinta_mm_s?: number | null
  /** El equipo sigue ajustando la velocidad con las cajas sueltas. */
  aprender_vel?: boolean
  /** Minutos máximos con la baliza de atasco encendida (0 = sin límite). */
  baliza_max_min?: number
  /** Hora habitual de cierre del turno, "HH:MM" (null = sin aviso de sensor tapado). */
  hora_cierre?: string | null
}

export interface ConfigEquipo {
  largo_caja_mm: number; vel_cinta_mm_s: number | null; aprender_vel: boolean
  baliza_max_min: number; hora_cierre: string | null
}

/** Un intervalo agregado (minuto, hora, día…). */
export interface Punto {
  inicio: number          // epoch ms del inicio del intervalo
  cajas: number           // suma de n (lo que vale como conteo)
  estimadas: number       // cajas por avance (pegadas)
  ajustes: number         // suma de n negativos (como número positivo)
  atascos: number         // atascos iniciados
}

export interface ResumenVivo {
  ahora: number
  hoy: number
  ayerMismaHora: number
  semanaAnteriorMismaHora: number
  ultimaHora: number
  ritmo10: number               // cajas/min en los últimos 10 min
  ritmoHabitual: number | null  // cajas/min típicos a esta hora (días anteriores)
  ultimaCaja: number | null     // epoch ms
  ultimoContacto: number | null // último evento recibido de cualquier tipo
  atascosHoy: number
  ajustesHoy: number
  enAtasco: boolean
}

export type EstadoEquipo = 'operando' | 'atasco' | 'sin_conexion' | 'detenido' | 'sin_datos'

export interface SaludEquipo {
  equipo: Equipo
  estado: EstadoEquipo
  ultimoContacto: number | null
  estadoReportado: string | null  // estado del último heartbeat
  haz: boolean | null
  rssi: number | null
  pendientes: number | null
  velMmS: number | null
  uptimeS: number | null
  seqFaltantes24h: number
  atascosHoy: number
  ajustesHoy: number
  filtrados: number | null
}

export interface Atasco {
  equipo_id: string
  inicio: number
  fin: number | null
  durMs: number | null
  cajasRevertidas: number
}

/** Cajas de un día local (AAAA-MM-DD) en una franja de 15 min (0..95). */
export interface FranjaProyeccion { dia: string; franja: number; cajas: number }

export type Escuchar = (e: Evento) => void

/** Origen de datos: modo demo (simulado) o Supabase. Misma interfaz para las pantallas. */
export interface FuenteDatos {
  readonly modo: 'demo' | 'supabase'
  equipos(): Promise<Equipo[]>
  /** Solo admin: largo de caja y velocidad de la cinta. El equipo lo recibe en su próximo envío. */
  guardarConfigEquipo(equipoId: string, c: ConfigEquipo): Promise<void>
  resumenVivo(equipoId: string): Promise<ResumenVivo>
  serie(equipoId: string, desde: number, hasta: number, paso: Paso): Promise<Punto[]>
  eventos(equipoId: string, desde: number, hasta: number, limite?: number): Promise<Evento[]>
  atascos(equipoId: string, desde: number, hasta: number): Promise<Atasco[]>
  salud(): Promise<SaludEquipo[]>
  /** Primer instante con datos del equipo (inicio de temporada). */
  primerDato(equipoId: string): Promise<number | null>
  /** Cajas por día y franja de 15 min de los últimos `dias` días (incluye hoy). */
  datosProyeccion(equipoId: string, dias: number): Promise<FranjaProyeccion[]>
  suscribir(equipoId: string, cb: Escuchar): () => void
}
