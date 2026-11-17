-- =====================================================================
--  0001 · Esquema base (el mismo que ya existe en el proyecto de pruebas)
--  Idempotente: si las tablas ya existen, no cambia nada ni borra datos.
-- =====================================================================

create table if not exists public.equipos (
  id            text primary key,
  nombre        text not null default '',
  largo_caja_mm int  not null default 450,
  creado        timestamptz not null default now()
);

insert into public.equipos (id, nombre) values ('linea-1', 'Línea 1')
on conflict (id) do nothing;

--  Conteo de cajas = SUMA de la columna n
--    caja      n = +1   primera caja de un bloqueo del haz
--    caja_est  n = +1   caja pegada estimada por el avance de la cinta
--    ajuste    n = -k   se revierten cajas estimadas al detectar atasco
--    resto     n =  0
create table if not exists public.eventos (
  id        bigint generated always as identity primary key,
  equipo_id text        not null,
  seq       bigint      not null,
  tipo      text        not null check (tipo in ('caja','caja_est','ajuste','bloque',
                                                  'atasco_inicio','atasco_fin','cinta_detenida',
                                                  'cinta_marcha','bloqueo_inicial','inicio','heartbeat')),
  n         smallint    not null default 0,
  ts        timestamptz not null default now(),
  dur_ms    integer,
  avance_mm real,
  cajas     smallint,
  total     bigint,
  vel_mm_s  real,
  extra     jsonb,
  recibido  timestamptz not null default now(),
  constraint eventos_equipo_seq_unico unique (equipo_id, seq)
);

create index if not exists eventos_equipo_ts_idx on public.eventos (equipo_id, ts desc);
create index if not exists eventos_conteo_idx    on public.eventos (ts) where n <> 0;
create index if not exists eventos_tipo_ts_idx   on public.eventos (tipo, ts desc);

alter table public.eventos enable row level security;
alter table public.equipos enable row level security;

-- Realtime
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'eventos') then
    alter publication supabase_realtime add table public.eventos;
  end if;
end $$;

-- Funciones del dashboard anterior (se mantienen por compatibilidad; la app nueva usa las de 0005)
create or replace function public.resumen_conteo(p_equipo text default null)
returns table (ultima_hora bigint, hoy bigint, ayer bigint, semana bigint, mes bigint,
               atascos_hoy bigint, ajustes_hoy bigint)
language sql stable security invoker set search_path = public as $$
  with b as (
    select (now() at time zone 'America/Santiago') as ahora_local
  ), l as (
    select date_trunc('day',   ahora_local) as hoy0,
           date_trunc('week',  ahora_local) as sem0,
           date_trunc('month', ahora_local) as mes0
    from b
  ), e as (
    select ev.n, ev.tipo, (ev.ts at time zone 'America/Santiago') as tl, ev.ts
    from public.eventos ev, l
    where (p_equipo is null or ev.equipo_id = p_equipo)
      and ev.ts >= ((least(l.mes0, l.sem0, l.hoy0 - interval '1 day')) at time zone 'America/Santiago')
  )
  select
    coalesce(sum(n) filter (where ts >= now() - interval '1 hour'), 0),
    coalesce(sum(n) filter (where tl >= l.hoy0), 0),
    coalesce(sum(n) filter (where tl >= l.hoy0 - interval '1 day' and tl < l.hoy0), 0),
    coalesce(sum(n) filter (where tl >= l.sem0), 0),
    coalesce(sum(n) filter (where tl >= l.mes0), 0),
    count(*) filter (where tipo = 'atasco_inicio' and tl >= l.hoy0),
    count(*) filter (where tipo = 'ajuste' and tl >= l.hoy0)
  from l left join e on true
  group by l.hoy0, l.sem0, l.mes0;
$$;

create or replace function public.conteo_serie(
  p_desde timestamptz, p_hasta timestamptz, p_paso text default 'hour', p_equipo text default null)
returns table (inicio timestamp, cajas bigint)
language sql stable security invoker set search_path = public as $$
  with s as (
    select generate_series(
             date_trunc(p_paso, p_desde at time zone 'America/Santiago'),
             date_trunc(p_paso, p_hasta at time zone 'America/Santiago'),
             ('1 ' || p_paso)::interval) as inicio
  ), c as (
    select date_trunc(p_paso, ts at time zone 'America/Santiago') as inicio, sum(n) as cajas
    from public.eventos
    where n <> 0 and ts >= p_desde and ts < p_hasta
      and (p_equipo is null or equipo_id = p_equipo)
    group by 1
  )
  select s.inicio, coalesce(c.cajas, 0)::bigint
  from s left join c using (inicio)
  order by s.inicio;
$$;

create or replace function public.estado_equipos()
returns table (equipo_id text, nombre text, ultimo_contacto timestamptz, segundos_sin_contacto int,
               estado text, total bigint, vel_mm_s real, rssi int, pendientes int, seq_faltantes bigint)
language sql stable security invoker set search_path = public as $$
  select q.id, q.nombre, h.recibido,
         extract(epoch from now() - h.recibido)::int,
         coalesce(h.extra->>'estado', 'sin datos'),
         h.total, h.vel_mm_s,
         (h.extra->>'rssi')::int, (h.extra->>'pendientes')::int,
         (select greatest(max(seq) - min(seq) + 1 - count(*), 0)
            from public.eventos x where x.equipo_id = q.id and x.recibido > now() - interval '24 hours')
  from public.equipos q
  left join lateral (
    select * from public.eventos e
    where e.equipo_id = q.id and e.tipo in ('heartbeat', 'inicio')
    order by e.recibido desc limit 1
  ) h on true;
$$;
