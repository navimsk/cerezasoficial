// Exportación a SQL (PostgreSQL): esquema mínimo + INSERTs idempotentes.
// Pensado para cargar los datos en la base de datos local de la empresa (migración futura).
// Sin dependencias del navegador: también se prueba desde Node.
import type { Equipo, Evento } from '../datos/tipos'

const texto = (s: string) => `'${s.replace(/'/g, "''")}'`
const valor = (v: unknown): string => {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return texto(String(v))
}

export const ESQUEMA_PORTABLE = `-- Esquema mínimo compatible con PostgreSQL 12+ (sin funciones de Supabase).
create table if not exists equipos (
  id            text primary key,
  nombre        text not null default '',
  largo_caja_mm int  not null default 450,
  creado        timestamptz not null default now()
);

create table if not exists eventos (
  id        bigint generated always as identity primary key,
  equipo_id text        not null,
  seq       bigint      not null,
  tipo      text        not null,
  n         smallint    not null default 0,
  ts        timestamptz not null,
  dur_ms    integer,
  avance_mm real,
  cajas     smallint,
  total     bigint,
  vel_mm_s  real,
  extra     jsonb,
  recibido  timestamptz not null default now(),
  constraint eventos_equipo_seq_unico unique (equipo_id, seq)
);
create index if not exists eventos_equipo_ts_idx on eventos (equipo_id, ts desc);

-- Conteo de cajas = suma de n.  Ejemplo: cajas por día (hora de Chile)
--   select (ts at time zone 'America/Santiago')::date as dia, sum(n) as cajas
--   from eventos where equipo_id = 'linea-1' group by 1 order by 1;
`

export interface OpcionesSql { equipo: Equipo; desde: number; hasta: number; generado?: number; lote?: number }

/** Devuelve el script como trozos de texto (para armar un Blob sin un string gigante). */
export function* generarSql(eventos: Evento[], o: OpcionesSql): Generator<string> {
  const lote = o.lote ?? 500
  yield `-- Contador de cajas · exportación SQL\n`
  yield `-- Equipo: ${o.equipo.id} (${o.equipo.nombre})\n`
  yield `-- Rango: ${new Date(o.desde).toISOString()} a ${new Date(o.hasta).toISOString()}\n`
  yield `-- Eventos: ${eventos.length} · generado ${new Date(o.generado ?? Date.now()).toISOString()}\n`
  yield `-- Se puede ejecutar más de una vez: los eventos repetidos se ignoran (equipo_id, seq).\n\n`
  yield 'begin;\n\n'
  yield ESQUEMA_PORTABLE
  yield `\ninsert into equipos (id, nombre, largo_caja_mm) values (${texto(o.equipo.id)}, ${texto(o.equipo.nombre)}, ${o.equipo.largo_caja_mm})\non conflict (id) do nothing;\n\n`
  for (let i = 0; i < eventos.length; i += lote) {
    const filas = eventos.slice(i, i + lote).map(e =>
      `(${valor(e.equipo_id)}, ${e.seq}, ${valor(e.tipo)}, ${e.n}, ${texto(new Date(e.ts).toISOString())}, ${valor(e.dur_ms)}, ${valor(e.avance_mm)}, ${valor(e.cajas)}, ${valor(e.total)}, ${valor(e.vel_mm_s)}, ${e.extra ? `${texto(JSON.stringify(e.extra))}::jsonb` : 'null'})`)
    yield `insert into eventos (equipo_id, seq, tipo, n, ts, dur_ms, avance_mm, cajas, total, vel_mm_s, extra) values\n${filas.join(',\n')}\non conflict (equipo_id, seq) do nothing;\n\n`
  }
  yield 'commit;\n'
}
