-- Todas las migraciones juntas, para pegar en Supabase -> SQL Editor. Se puede ejecutar más de una vez.

-- ===== 20261116000001_esquema_base.sql =====
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

-- ===== 20261116000002_seguridad.sql =====
-- =====================================================================
--  0002 · Seguridad: lista blanca de usuarios y RLS
--  - Solo usuarios autenticados que estén en usuarios_autorizados (activos) leen datos.
--  - La clave anónima ya NO puede leer nada.
--  - Compatibilidad: la clave anónima puede seguir INSERTANDO eventos mientras
--    ajustes_sistema.permitir_insert_anon = true (hasta actualizar el firmware).
-- =====================================================================

-- ---------- Lista blanca ----------
create table if not exists public.usuarios_autorizados (
  email   text primary key check (email = lower(email) and position('@' in email) > 1),
  rol     text not null default 'jefatura' check (rol in ('jefatura', 'admin')),
  nombre  text not null default '',
  activo  boolean not null default true,
  creado  timestamptz not null default now()
);
alter table public.usuarios_autorizados enable row level security;

-- Rol del usuario actual según su correo (verificado por Supabase Auth). null = no autorizado.
create or replace function public.rol_actual()
returns text
language sql stable security definer set search_path = public as $$
  select u.rol from public.usuarios_autorizados u
  where u.activo and u.email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.es_autorizado()
returns boolean language sql stable security definer set search_path = public as $$
  select public.rol_actual() is not null
$$;

create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.rol_actual() = 'admin', false)
$$;

-- Para la app: quién soy y qué rol tengo
create or replace function public.mi_perfil()
returns table (email text, rol text, nombre text)
language sql stable security definer set search_path = public as $$
  select lower(auth.jwt() ->> 'email'), u.rol, u.nombre
  from (select 1) x
  left join public.usuarios_autorizados u
    on u.activo and u.email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

revoke all on function public.rol_actual(), public.es_autorizado(), public.es_admin(), public.mi_perfil() from public, anon;
-- (ajuste_bool y equipo_existe sí quedan para anon: las usa la política de inserción de compatibilidad)
grant execute on function public.rol_actual(), public.es_autorizado(), public.es_admin(), public.mi_perfil() to authenticated;

drop policy if exists "ver mi fila o admin" on public.usuarios_autorizados;
create policy "ver mi fila o admin" on public.usuarios_autorizados
  for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')) or public.es_admin());

drop policy if exists "admin gestiona usuarios" on public.usuarios_autorizados;
create policy "admin gestiona usuarios" on public.usuarios_autorizados
  for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

-- ---------- Ajustes del sistema ----------
create table if not exists public.ajustes_sistema (
  clave       text primary key,
  valor       jsonb not null,
  descripcion text not null default '',
  actualizado timestamptz not null default now()
);
alter table public.ajustes_sistema enable row level security;

insert into public.ajustes_sistema (clave, valor, descripcion) values
  ('permitir_insert_anon', 'true',
   'Compatibilidad con el firmware v2: la clave anónima puede insertar eventos. Pasar a false cuando todos los equipos usen la función ingesta.')
on conflict (clave) do nothing;

create or replace function public.ajuste_bool(p_clave text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (valor #>> '{}')::boolean from public.ajustes_sistema where clave = p_clave), false)
$$;
grant execute on function public.ajuste_bool(text) to anon, authenticated;

drop policy if exists "autorizados leen ajustes" on public.ajustes_sistema;
create policy "autorizados leen ajustes" on public.ajustes_sistema
  for select to authenticated using (public.es_autorizado());

drop policy if exists "admin cambia ajustes" on public.ajustes_sistema;
create policy "admin cambia ajustes" on public.ajustes_sistema
  for update to authenticated using (public.es_admin()) with check (public.es_admin());

-- ---------- Eventos ----------
drop policy if exists "dashboard lee eventos" on public.eventos;
drop policy if exists "equipo inserta eventos" on public.eventos;
drop policy if exists "autorizados leen eventos" on public.eventos;
drop policy if exists "compat: equipo inserta con clave anon" on public.eventos;

create policy "autorizados leen eventos" on public.eventos
  for select to authenticated using (public.es_autorizado());
-- (la política de inserción anónima va más abajo, tras definir equipo_existe)

-- ---------- Equipos ----------
drop policy if exists "dashboard lee equipos" on public.equipos;
drop policy if exists "autorizados leen equipos" on public.equipos;
drop policy if exists "admin edita equipos" on public.equipos;

create policy "autorizados leen equipos" on public.equipos
  for select to authenticated using (public.es_autorizado());
create policy "admin edita equipos" on public.equipos
  for update to authenticated using (public.es_admin()) with check (public.es_admin());

-- La política de insert anon necesita saber si el equipo existe, pero anon no puede leer
-- equipos: se usa una función security definer que solo responde sí/no.
create or replace function public.equipo_existe(p_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.equipos where id = p_id and coalesce((to_jsonb(equipos) ->> 'activo')::boolean, true))
$$;
grant execute on function public.equipo_existe(text) to anon, authenticated;

drop policy if exists "compat: equipo inserta con clave anon" on public.eventos;
create policy "compat: equipo inserta con clave anon" on public.eventos
  for insert to anon
  with check (public.ajuste_bool('permitir_insert_anon') and public.equipo_existe(equipo_id));

-- Las funciones antiguas ya no se exponen a anon
revoke execute on function public.resumen_conteo(text) from public, anon;
revoke execute on function public.conteo_serie(timestamptz, timestamptz, text, text) from public, anon;
revoke execute on function public.estado_equipos() from public, anon;
grant execute on function public.resumen_conteo(text) to authenticated;
grant execute on function public.conteo_serie(timestamptz, timestamptz, text, text) to authenticated;
grant execute on function public.estado_equipos() to authenticated;

-- ===== 20261116000003_ingesta.sql =====
-- =====================================================================
--  0003 · Ingesta por equipo con token propio
--  - equipos.token_hash = sha256 (hex) del token del equipo. El token en claro
--    nunca se guarda en la base: solo lo tiene el firmware.
--  - La Edge Function "ingesta" calcula el hash y llama a ingestar_eventos()
--    con la clave de servicio (que vive solo en Supabase, no en este repo).
-- =====================================================================

alter table public.equipos add column if not exists token_hash text;
alter table public.equipos add column if not exists activo boolean not null default true;
create unique index if not exists equipos_token_hash_uq on public.equipos (token_hash) where token_hash is not null;

-- token_hash nunca se expone a la app
revoke select on public.equipos from anon, authenticated;
grant select (id, nombre, largo_caja_mm, creado, activo) on public.equipos to authenticated;
grant update (nombre, largo_caja_mm, activo) on public.equipos to authenticated;

create or replace function public.ingestar_eventos(p_token_hash text, p_eventos jsonb)
returns table (equipo text, recibidos int, insertados int)
language plpgsql security definer set search_path = public as $$
declare
  v_equipo text;
  v_ins    int;
begin
  select q.id into v_equipo from public.equipos q
  where q.token_hash = p_token_hash and q.activo;
  if v_equipo is null then
    raise exception 'token_invalido' using errcode = '28000';
  end if;
  if jsonb_typeof(p_eventos) <> 'array' then
    raise exception 'se_esperaba_arreglo' using errcode = '22023';
  end if;

  with filas as (
    select *
    from jsonb_to_recordset(p_eventos) as x(
      equipo_id text, seq numeric, tipo text, n numeric, ts timestamptz, dur_ms numeric,
      avance_mm real, cajas numeric, total numeric, vel_mm_s real, extra jsonb)
  ), ins as (
    insert into public.eventos as ev (equipo_id, seq, tipo, n, ts, dur_ms, avance_mm, cajas, total, vel_mm_s, extra)
    select v_equipo, f.seq::bigint, f.tipo, round(coalesce(f.n, 0))::smallint,
           -- sin hora del equipo, o una hora absurda (> 1 día en el futuro): hora de llegada
           case when f.ts is null or f.ts > now() + interval '1 day' then now() else f.ts end,
           least(round(f.dur_ms), 2147483647)::int, f.avance_mm, least(round(f.cajas), 32767)::smallint,
           round(f.total)::bigint, f.vel_mm_s, f.extra
    from filas f
    where f.seq is not null and f.seq > 0 and f.seq = trunc(f.seq) and f.seq < 9e18
      and f.tipo in ('caja','caja_est','ajuste','bloque','atasco_inicio','atasco_fin','cinta_detenida',
                     'cinta_marcha','bloqueo_inicial','inicio','heartbeat')
      and (f.equipo_id is null or f.equipo_id = v_equipo)
      and coalesce(f.n, 0) between -100 and 100
    on conflict on constraint eventos_equipo_seq_unico do nothing
    returning 1
  )
  select count(*)::int into v_ins from ins;

  return query select v_equipo, jsonb_array_length(p_eventos), v_ins;
end $$;

revoke all on function public.ingestar_eventos(text, jsonb) from public, anon, authenticated;
grant execute on function public.ingestar_eventos(text, jsonb) to service_role;

-- Admin: registrar el hash del token de un equipo (el token se genera con scripts/token-equipo.mjs)
create or replace function public.registrar_token_equipo(p_equipo text, p_token_hash text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.es_admin() and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'solo_admin' using errcode = '42501';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'hash_invalido: se espera sha256 en hexadecimal' using errcode = '22023';
  end if;
  update public.equipos set token_hash = p_token_hash where id = p_equipo;
  if not found then raise exception 'equipo_no_existe' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.registrar_token_equipo(text, text) from public, anon;
grant execute on function public.registrar_token_equipo(text, text) to authenticated;

-- ===== 20261116000004_agregados.sql =====
-- =====================================================================
--  0004 · Agregados para que la app sea rápida
--  agg_minuto / agg_hora / agg_dia por equipo:
--    cajas     = suma de n (incluye correcciones: es el conteo real)
--    estimadas = cajas pegadas estimadas por avance (caja_est)
--    ajustes   = cajas revertidas por atasco (positivo)
--    atascos   = atascos iniciados
--  Se actualizan con un trigger por sentencia (procesa el lote completo de una vez).
--  Como la ingesta ignora duplicados (on conflict do nothing), un reenvío NO suma dos veces:
--  el trigger solo ve las filas realmente insertadas.
--  Las horas en Chile tienen desfase entero, así que la hora UTC truncada = hora local truncada.
-- =====================================================================

create table if not exists public.agg_minuto (
  equipo_id text        not null,
  minuto    timestamptz not null,
  cajas     int not null default 0,
  estimadas int not null default 0,
  ajustes   int not null default 0,
  atascos   int not null default 0,
  primary key (equipo_id, minuto)
);

create table if not exists public.agg_hora (
  equipo_id text        not null,
  hora      timestamptz not null,
  cajas     int not null default 0,
  estimadas int not null default 0,
  ajustes   int not null default 0,
  atascos   int not null default 0,
  primary key (equipo_id, hora)
);

create table if not exists public.agg_dia (
  equipo_id text not null,
  dia       date not null,              -- día local (America/Santiago)
  cajas     int not null default 0,
  estimadas int not null default 0,
  ajustes   int not null default 0,
  atascos   int not null default 0,
  primary key (equipo_id, dia)
);

-- Índices adicionales para consultas de estado
create index if not exists eventos_equipo_recibido_idx on public.eventos (equipo_id, recibido desc);
create index if not exists eventos_estado_idx on public.eventos (equipo_id, ts desc)
  where tipo in ('atasco_inicio', 'atasco_fin', 'heartbeat', 'inicio');
create index if not exists eventos_cajas_idx on public.eventos (equipo_id, ts desc) where n > 0;

-- ---------- Trigger ----------
create or replace function public.tg_eventos_agregar()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.agg_minuto as a (equipo_id, minuto, cajas, estimadas, ajustes, atascos)
  select equipo_id, date_trunc('minute', ts),
         coalesce(sum(n), 0),
         coalesce(sum(n) filter (where tipo = 'caja_est'), 0),
         coalesce(-sum(n) filter (where tipo = 'ajuste'), 0),
         count(*) filter (where tipo = 'atasco_inicio')
  from nuevas where n <> 0 or tipo = 'atasco_inicio'
  group by 1, 2
  on conflict (equipo_id, minuto) do update set
    cajas = a.cajas + excluded.cajas, estimadas = a.estimadas + excluded.estimadas,
    ajustes = a.ajustes + excluded.ajustes, atascos = a.atascos + excluded.atascos;

  insert into public.agg_hora as a (equipo_id, hora, cajas, estimadas, ajustes, atascos)
  select equipo_id, date_trunc('hour', ts),
         coalesce(sum(n), 0),
         coalesce(sum(n) filter (where tipo = 'caja_est'), 0),
         coalesce(-sum(n) filter (where tipo = 'ajuste'), 0),
         count(*) filter (where tipo = 'atasco_inicio')
  from nuevas where n <> 0 or tipo = 'atasco_inicio'
  group by 1, 2
  on conflict (equipo_id, hora) do update set
    cajas = a.cajas + excluded.cajas, estimadas = a.estimadas + excluded.estimadas,
    ajustes = a.ajustes + excluded.ajustes, atascos = a.atascos + excluded.atascos;

  insert into public.agg_dia as a (equipo_id, dia, cajas, estimadas, ajustes, atascos)
  select equipo_id, (ts at time zone 'America/Santiago')::date,
         coalesce(sum(n), 0),
         coalesce(sum(n) filter (where tipo = 'caja_est'), 0),
         coalesce(-sum(n) filter (where tipo = 'ajuste'), 0),
         count(*) filter (where tipo = 'atasco_inicio')
  from nuevas where n <> 0 or tipo = 'atasco_inicio'
  group by 1, 2
  on conflict (equipo_id, dia) do update set
    cajas = a.cajas + excluded.cajas, estimadas = a.estimadas + excluded.estimadas,
    ajustes = a.ajustes + excluded.ajustes, atascos = a.atascos + excluded.atascos;

  return null;
end $$;

drop trigger if exists eventos_agregar on public.eventos;
create trigger eventos_agregar
  after insert on public.eventos
  referencing new table as nuevas
  for each statement execute function public.tg_eventos_agregar();

-- ---------- Carga inicial (solo si los agregados están vacíos) ----------
do $$
begin
  if not exists (select 1 from public.agg_minuto limit 1) then
    insert into public.agg_minuto (equipo_id, minuto, cajas, estimadas, ajustes, atascos)
    select equipo_id, date_trunc('minute', ts), coalesce(sum(n), 0),
           coalesce(sum(n) filter (where tipo = 'caja_est'), 0),
           coalesce(-sum(n) filter (where tipo = 'ajuste'), 0),
           count(*) filter (where tipo = 'atasco_inicio')
    from public.eventos where n <> 0 or tipo = 'atasco_inicio' group by 1, 2;

    insert into public.agg_hora (equipo_id, hora, cajas, estimadas, ajustes, atascos)
    select equipo_id, date_trunc('hour', minuto), sum(cajas), sum(estimadas), sum(ajustes), sum(atascos)
    from public.agg_minuto group by 1, 2
    on conflict do nothing;

    insert into public.agg_dia (equipo_id, dia, cajas, estimadas, ajustes, atascos)
    select equipo_id, (minuto at time zone 'America/Santiago')::date, sum(cajas), sum(estimadas), sum(ajustes), sum(atascos)
    from public.agg_minuto group by 1, 2
    on conflict do nothing;
  end if;
end $$;

-- Recalcular todo desde cero (por si se borran eventos a mano). Solo admin / servicio.
create or replace function public.recalcular_agregados()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.es_admin() and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'solo_admin' using errcode = '42501';
  end if;
  delete from public.agg_minuto; delete from public.agg_hora; delete from public.agg_dia;
  insert into public.agg_minuto (equipo_id, minuto, cajas, estimadas, ajustes, atascos)
  select equipo_id, date_trunc('minute', ts), coalesce(sum(n), 0),
         coalesce(sum(n) filter (where tipo = 'caja_est'), 0),
         coalesce(-sum(n) filter (where tipo = 'ajuste'), 0),
         count(*) filter (where tipo = 'atasco_inicio')
  from public.eventos where n <> 0 or tipo = 'atasco_inicio' group by 1, 2;
  insert into public.agg_hora (equipo_id, hora, cajas, estimadas, ajustes, atascos)
  select equipo_id, date_trunc('hour', minuto), sum(cajas), sum(estimadas), sum(ajustes), sum(atascos)
  from public.agg_minuto group by 1, 2;
  insert into public.agg_dia (equipo_id, dia, cajas, estimadas, ajustes, atascos)
  select equipo_id, (minuto at time zone 'America/Santiago')::date, sum(cajas), sum(estimadas), sum(ajustes), sum(atascos)
  from public.agg_minuto group by 1, 2;
end $$;
revoke all on function public.recalcular_agregados() from public, anon;
grant execute on function public.recalcular_agregados() to authenticated;

-- ---------- RLS ----------
alter table public.agg_minuto enable row level security;
alter table public.agg_hora   enable row level security;
alter table public.agg_dia    enable row level security;

drop policy if exists "autorizados leen" on public.agg_minuto;
drop policy if exists "autorizados leen" on public.agg_hora;
drop policy if exists "autorizados leen" on public.agg_dia;
create policy "autorizados leen" on public.agg_minuto for select to authenticated using (public.es_autorizado());
create policy "autorizados leen" on public.agg_hora   for select to authenticated using (public.es_autorizado());
create policy "autorizados leen" on public.agg_dia    for select to authenticated using (public.es_autorizado());

revoke insert, update, delete on public.agg_minuto, public.agg_hora, public.agg_dia from anon, authenticated;

-- ===== 20261116000005_rpc_app.sql =====
-- =====================================================================
--  0005 · Funciones (RPC) para la app. Zona horaria: America/Santiago.
--  Todas son security invoker: respetan RLS (solo usuarios autorizados ven datos).
-- =====================================================================

-- ---------- Resumen en vivo ----------
create or replace function public.resumen_vivo(p_equipo text)
returns table (
  ahora timestamptz, hoy bigint, ayer_misma_hora bigint, semana_anterior_misma_hora bigint,
  ultima_hora bigint, ritmo10 numeric, ritmo_habitual numeric,
  ultima_caja timestamptz, ultimo_contacto timestamptz,
  atascos_hoy bigint, ajustes_hoy bigint, en_atasco boolean)
language plpgsql stable security invoker set search_path = public as $$
declare
  tz  constant text := 'America/Santiago';
  t   timestamptz := now();
  loc timestamp   := now() at time zone 'America/Santiago';
  hoy0 timestamptz := date_trunc('day', loc) at time zone tz;
begin
  return query
  select
    t,
    (select coalesce(sum(m.cajas), 0) from agg_minuto m where m.equipo_id = p_equipo and m.minuto >= hoy0 and m.minuto <= t)::bigint,
    (select coalesce(sum(m.cajas), 0) from agg_minuto m where m.equipo_id = p_equipo
       and m.minuto >= ((date_trunc('day', loc) - interval '1 day') at time zone tz)
       and m.minuto <= ((loc - interval '1 day') at time zone tz))::bigint,
    (select coalesce(sum(m.cajas), 0) from agg_minuto m where m.equipo_id = p_equipo
       and m.minuto >= ((date_trunc('day', loc) - interval '7 day') at time zone tz)
       and m.minuto <= ((loc - interval '7 day') at time zone tz))::bigint,
    (select coalesce(sum(m.cajas), 0) from agg_minuto m where m.equipo_id = p_equipo and m.minuto > t - interval '60 min' and m.minuto <= t)::bigint,
    (select round(coalesce(sum(m.cajas), 0) / 10.0, 2) from agg_minuto m where m.equipo_id = p_equipo and m.minuto > t - interval '10 min' and m.minuto <= t),
    (select round(avg(q.s) / 30.0, 2) from (
        select d, sum(m.cajas) as s
        from generate_series(1, 14) d
        join agg_minuto m on m.equipo_id = p_equipo
          and m.minuto >= ((loc - make_interval(days => d) - interval '15 min') at time zone tz)
          and m.minuto <  ((loc - make_interval(days => d) + interval '15 min') at time zone tz)
        group by d having sum(m.cajas) > 0) q
      having count(*) >= 3),
    (select e.ts from eventos e where e.equipo_id = p_equipo and e.n > 0 order by e.ts desc limit 1),
    (select e.recibido from eventos e where e.equipo_id = p_equipo order by e.recibido desc limit 1),
    (select coalesce(sum(m.atascos), 0) from agg_minuto m where m.equipo_id = p_equipo and m.minuto >= hoy0)::bigint,
    (select coalesce(sum(m.ajustes), 0) from agg_minuto m where m.equipo_id = p_equipo and m.minuto >= hoy0)::bigint,
    coalesce((select e.tipo = 'atasco_inicio' from eventos e
              where e.equipo_id = p_equipo and e.tipo in ('atasco_inicio', 'atasco_fin')
              order by e.ts desc limit 1), false);
end $$;

-- ---------- Serie con ceros por paso ----------
create or replace function public.serie(p_equipo text, p_desde timestamptz, p_hasta timestamptz, p_paso text default 'hour')
returns table (inicio timestamptz, cajas bigint, estimadas bigint, ajustes bigint, atascos bigint)
language plpgsql stable security invoker set search_path = public as $$
declare tz constant text := 'America/Santiago';
begin
  if p_paso not in ('minute', 'hour', 'day', 'week', 'month') then
    raise exception 'paso_invalido: use minute, hour, day, week o month' using errcode = '22023';
  end if;
  if p_hasta <= p_desde then return; end if;
  if p_paso = 'minute' and p_hasta - p_desde > interval '3 days' then
    raise exception 'rango_muy_grande: máximo 3 días por minuto' using errcode = '22023';
  end if;
  if p_paso = 'hour' and p_hasta - p_desde > interval '120 days' then
    raise exception 'rango_muy_grande: máximo 120 días por hora' using errcode = '22023';
  end if;

  return query
  with s as (
    select g as ini_local
    from generate_series(date_trunc(p_paso, p_desde at time zone tz),
                         date_trunc(p_paso, (p_hasta - interval '1 microsecond') at time zone tz),
                         ('1 ' || p_paso)::interval) g
  ), d as (
    select date_trunc(p_paso, m.minuto at time zone tz) as k,
           sum(m.cajas) c, sum(m.estimadas) e, sum(m.ajustes) a, sum(m.atascos) x
    from agg_minuto m
    where p_paso = 'minute' and m.equipo_id = p_equipo and m.minuto >= p_desde and m.minuto < p_hasta
    group by 1
    union all
    select date_trunc(p_paso, h.hora at time zone tz),
           sum(h.cajas), sum(h.estimadas), sum(h.ajustes), sum(h.atascos)
    from agg_hora h
    where p_paso = 'hour' and h.equipo_id = p_equipo and h.hora >= date_trunc('hour', p_desde) and h.hora < p_hasta
    group by 1
    union all
    select date_trunc(p_paso, dd.dia::timestamp),
           sum(dd.cajas), sum(dd.estimadas), sum(dd.ajustes), sum(dd.atascos)
    from agg_dia dd
    where p_paso in ('day', 'week', 'month') and dd.equipo_id = p_equipo
      and dd.dia >= (p_desde at time zone tz)::date
      and dd.dia <= ((p_hasta - interval '1 microsecond') at time zone tz)::date
    group by 1
  )
  select (s.ini_local at time zone tz), coalesce(d.c, 0)::bigint, coalesce(d.e, 0)::bigint,
         coalesce(d.a, 0)::bigint, coalesce(d.x, 0)::bigint
  from s left join d on d.k = s.ini_local
  order by s.ini_local;
end $$;

-- ---------- Salud de los equipos ----------
create or replace function public.salud_equipos()
returns table (
  equipo_id text, nombre text, largo_caja_mm int, ultimo_contacto timestamptz,
  estado_reportado text, haz boolean, rssi int, pendientes int, vel_mm_s real,
  uptime_s int, filtrados int, perdidos_cola int, seq_faltantes_24h bigint,
  atascos_hoy bigint, ajustes_hoy bigint, en_atasco boolean)
language sql stable security invoker set search_path = public as $$
  select q.id, q.nombre, q.largo_caja_mm,
         (select e.recibido from eventos e where e.equipo_id = q.id order by e.recibido desc limit 1),
         h.extra ->> 'estado',
         (h.extra ->> 'haz')::boolean,
         (h.extra ->> 'rssi')::int,
         (h.extra ->> 'pendientes')::int,
         h.vel_mm_s,
         (h.extra ->> 'uptime_s')::int,
         (h.extra ->> 'filtrados')::int,
         (h.extra ->> 'perdidos_cola')::int,
         (select greatest(max(x.seq) - min(x.seq) + 1 - count(*), 0)
            from eventos x where x.equipo_id = q.id and x.ts > now() - interval '24 hours'),
         coalesce(dd.atascos, 0)::bigint,
         coalesce(dd.ajustes, 0)::bigint,
         coalesce((select e.tipo = 'atasco_inicio' from eventos e
                   where e.equipo_id = q.id and e.tipo in ('atasco_inicio', 'atasco_fin')
                   order by e.ts desc limit 1), false)
  from equipos q
  left join lateral (
    select e.extra, e.vel_mm_s from eventos e
    where e.equipo_id = q.id and e.tipo in ('heartbeat', 'inicio')
    order by e.ts desc limit 1
  ) h on true
  left join agg_dia dd on dd.equipo_id = q.id and dd.dia = (now() at time zone 'America/Santiago')::date
  where q.activo
  order by q.id;
$$;

-- ---------- Atascos de un rango (inicio, fin, duración, cajas revertidas) ----------
create or replace function public.atascos_rango(p_equipo text, p_desde timestamptz, p_hasta timestamptz)
returns table (inicio timestamptz, fin timestamptz, dur_ms bigint, cajas_revertidas bigint)
language sql stable security invoker set search_path = public as $$
  select i.ts, f.ts,
         case when f.ts is null then null else (extract(epoch from f.ts - i.ts) * 1000)::bigint end,
         coalesce((select -sum(a.n) from eventos a
                   where a.equipo_id = i.equipo_id and a.tipo = 'ajuste'
                     and a.ts between i.ts - interval '5 seconds' and i.ts + interval '1 second'), 0)::bigint
  from eventos i
  left join lateral (
    select e.ts from eventos e
    where e.equipo_id = i.equipo_id and e.tipo = 'atasco_fin' and e.ts >= i.ts
    order by e.ts limit 1
  ) f on true
  where i.equipo_id = p_equipo and i.tipo = 'atasco_inicio' and i.ts >= p_desde and i.ts < p_hasta
  order by i.ts;
$$;

-- ---------- Datos para proyecciones: cajas por día y franja de 15 min ----------
-- franja = 0..95 (00:00–00:15 = 0). Solo filas con datos.
create or replace function public.datos_proyeccion(p_equipo text, p_dias int default 56)
returns table (dia date, franja smallint, cajas bigint)
language sql stable security invoker set search_path = public as $$
  select (m.minuto at time zone 'America/Santiago')::date,
         (extract(hour from m.minuto at time zone 'America/Santiago') * 4
          + floor(extract(minute from m.minuto at time zone 'America/Santiago') / 15))::smallint,
         sum(m.cajas)::bigint
  from agg_minuto m
  where m.equipo_id = p_equipo
    and m.minuto >= ((date_trunc('day', now() at time zone 'America/Santiago') - make_interval(days => least(greatest(p_dias, 1), 400)))
                     at time zone 'America/Santiago')
  group by 1, 2
  order by 1, 2;
$$;

-- Primer dato del equipo (inicio de temporada)
create or replace function public.primer_dato(p_equipo text)
returns timestamptz language sql stable security invoker set search_path = public as $$
  select min(m.minuto) from agg_minuto m where m.equipo_id = p_equipo
$$;

grant execute on function public.resumen_vivo(text) to authenticated;
grant execute on function public.serie(text, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.salud_equipos() to authenticated;
grant execute on function public.atascos_rango(text, timestamptz, timestamptz) to authenticated;
grant execute on function public.datos_proyeccion(text, int) to authenticated;
grant execute on function public.primer_dato(text) to authenticated;
revoke execute on function public.resumen_vivo(text), public.serie(text, timestamptz, timestamptz, text),
  public.salud_equipos(), public.atascos_rango(text, timestamptz, timestamptz),
  public.datos_proyeccion(text, int), public.primer_dato(text) from public, anon;

-- ===== 20261116000006_push.sql =====
-- =====================================================================
--  0006 · Notificaciones push (Web Push) para jefaturas
--  Avisos:
--   - atasco:        cada atasco_inicio (una vez por atasco)
--   - sin_contacto:  el equipo lleva > 2 min sin enviar nada (una vez por corte)
--   - ritmo:         ritmo de los últimos 15 min < 50 % de lo habitual a esa hora
--                    (habitual = misma franja en los 14 días anteriores; máx. 1 aviso cada 30 min)
--  Flujo: pg_cron (cada minuto) → llamar_vigilar() → pg_net → Edge Function "vigilar"
--         → alertas_pendientes() → envía Web Push a los suscritos con ese aviso activado.
--  Un atasco además dispara llamar_vigilar() al instante desde el trigger de eventos.
-- =====================================================================

create table if not exists public.suscripciones_push (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh   text not null,
  auth     text not null,
  agente   text,
  creado   timestamptz not null default now()
);

create table if not exists public.preferencias_notif (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  atasco       boolean not null default true,
  sin_contacto boolean not null default true,
  ritmo        boolean not null default true,
  actualizado  timestamptz not null default now()
);

create table if not exists public.notificaciones_enviadas (
  id        bigint generated always as identity primary key,
  equipo_id text not null,
  tipo      text not null check (tipo in ('atasco', 'sin_contacto', 'ritmo')),
  ref       text not null,
  titulo    text not null,
  cuerpo    text not null,
  creado    timestamptz not null default now(),
  constraint notificaciones_unicas unique (equipo_id, tipo, ref)
);

alter table public.suscripciones_push      enable row level security;
alter table public.preferencias_notif      enable row level security;
alter table public.notificaciones_enviadas enable row level security;

drop policy if exists "mis suscripciones" on public.suscripciones_push;
create policy "mis suscripciones" on public.suscripciones_push
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.es_autorizado());

drop policy if exists "mis preferencias" on public.preferencias_notif;
create policy "mis preferencias" on public.preferencias_notif
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.es_autorizado());

drop policy if exists "autorizados leen avisos" on public.notificaciones_enviadas;
create policy "autorizados leen avisos" on public.notificaciones_enviadas
  for select to authenticated using (public.es_autorizado());

-- ---------- Cálculo de alertas (solo el servicio) ----------
create or replace function public.alertas_pendientes()
returns table (id bigint, equipo_id text, tipo text, titulo text, cuerpo text)
language plpgsql security definer set search_path = public as $$
declare
  tz  constant text := 'America/Santiago';
  loc timestamp := now() at time zone 'America/Santiago';
  q   record;
  v_ult timestamptz;
  v_r15 numeric;
  v_hab numeric;
  v_dias int;
  v_atasco boolean;
begin
  for q in select e.id, e.nombre from equipos e where e.activo loop
    -- atascos recientes
    insert into notificaciones_enviadas (equipo_id, tipo, ref, titulo, cuerpo)
    select q.id, 'atasco', ev.seq::text,
           'Atasco en ' || q.nombre,
           'Haz cortado desde las ' || to_char(ev.ts at time zone tz, 'HH24:MI') ||
           '. El conteo está en pausa hasta que se libere.'
    from eventos ev
    where ev.equipo_id = q.id and ev.tipo = 'atasco_inicio' and ev.ts > now() - interval '10 minutes'
    on conflict on constraint notificaciones_unicas do nothing;

    -- sin contacto (> 2 min, solo cortes de menos de 12 h para no avisar días después)
    select max(e.recibido) into v_ult from eventos e where e.equipo_id = q.id and e.recibido > now() - interval '12 hours';
    if v_ult is not null and v_ult < now() - interval '2 minutes' then
      insert into notificaciones_enviadas (equipo_id, tipo, ref, titulo, cuerpo)
      values (q.id, 'sin_contacto', to_char(v_ult, 'YYYYMMDDHH24MISS'),
              q.nombre || ' sin contacto',
              'Sin datos desde las ' || to_char(v_ult at time zone tz, 'HH24:MI') ||
              '. Revisa energía y WiFi del equipo. Si se apagó al terminar el turno, ignora este aviso.')
      on conflict on constraint notificaciones_unicas do nothing;
    end if;

    -- caída de ritmo
    v_atasco := coalesce((select e.tipo = 'atasco_inicio' from eventos e
                          where e.equipo_id = q.id and e.tipo in ('atasco_inicio', 'atasco_fin')
                          order by e.ts desc limit 1), false);
    if v_ult is not null and v_ult >= now() - interval '2 minutes' and not v_atasco then
      select coalesce(sum(m.cajas), 0) / 15.0 into v_r15
      from agg_minuto m where m.equipo_id = q.id and m.minuto > now() - interval '15 min' and m.minuto <= now();

      select avg(s) / 15.0, count(*) into v_hab, v_dias from (
        select d, sum(m.cajas) s
        from generate_series(1, 14) d
        join agg_minuto m on m.equipo_id = q.id
          and m.minuto >  ((loc - make_interval(days => d) - interval '15 min') at time zone tz)
          and m.minuto <= ((loc - make_interval(days => d)) at time zone tz)
        group by d having sum(m.cajas) > 0) x;

      if v_dias >= 3 and v_hab >= 5 and v_r15 < 0.5 * v_hab
         -- el equipo lleva al menos 20 min encendido hoy (evita avisar en el arranque)
         and exists (select 1 from agg_minuto m where m.equipo_id = q.id
                     and m.minuto < now() - interval '20 min' and m.minuto >= now() - interval '3 hours') then
        insert into notificaciones_enviadas (equipo_id, tipo, ref, titulo, cuerpo)
        values (q.id, 'ritmo',
                to_char(date_trunc('hour', loc) + floor(extract(minute from loc) / 30) * interval '30 min', 'YYYYMMDDHH24MI'),
                'Ritmo bajo en ' || q.nombre,
                replace(round(v_r15, 1)::text, '.', ',') || ' cajas/min en los últimos 15 min; lo habitual a esta hora es ' ||
                replace(round(v_hab, 1)::text, '.', ',') || '.')
        on conflict on constraint notificaciones_unicas do nothing;
      end if;
    end if;
  end loop;

  -- devolver lo creado en este minuto que aún no se ha enviado
  return query
  select n.id, n.equipo_id, n.tipo, n.titulo, n.cuerpo
  from notificaciones_enviadas n
  where n.creado > now() - interval '50 seconds'
    and not exists (select 1 from notificaciones_despachadas d where d.notificacion_id = n.id);
end $$;

create table if not exists public.notificaciones_despachadas (
  notificacion_id bigint primary key references public.notificaciones_enviadas (id) on delete cascade,
  enviados int not null default 0,
  despachado timestamptz not null default now()
);
alter table public.notificaciones_despachadas enable row level security;

-- Destinatarios de un tipo de aviso: usuarios autorizados y activos, con el aviso activado
create or replace function public.destinatarios_push(p_tipo text)
returns table (sub_id bigint, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select s.id, s.endpoint, s.p256dh, s.auth
  from suscripciones_push s
  join auth.users u on u.id = s.user_id
  join usuarios_autorizados a on a.email = lower(u.email) and a.activo
  left join preferencias_notif p on p.user_id = s.user_id
  where case p_tipo
          when 'atasco'       then coalesce(p.atasco, true)
          when 'sin_contacto' then coalesce(p.sin_contacto, true)
          when 'ritmo'        then coalesce(p.ritmo, true)
          else false end
$$;

revoke all on function public.alertas_pendientes(), public.destinatarios_push(text) from public, anon, authenticated;
grant execute on function public.alertas_pendientes(), public.destinatarios_push(text) to service_role;

-- ---------- Llamada a la Edge Function vía pg_net ----------
-- Necesita dos secretos en Supabase Vault (ver README):
--   url_funciones = https://<ref>.supabase.co/functions/v1
--   cron_secret   = el mismo valor que el secreto CRON_SECRET de las Edge Functions
create or replace function public.llamar_vigilar()
returns void language plpgsql security definer set search_path = public as $$
declare v_url text; v_sec text;
begin
  begin
    execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'url_funciones'$q$ into v_url;
    execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'$q$ into v_sec;
    if v_url is null or v_sec is null then return; end if;
    execute $q$select net.http_post(url := $1, headers := $2, body := '{}'::jsonb, timeout_milliseconds := 5000)$q$
      using v_url || '/vigilar',
            jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_sec);
  exception when others then
    raise warning 'llamar_vigilar: %', sqlerrm;   -- nunca bloquear la ingesta por un aviso
  end;
end $$;
revoke all on function public.llamar_vigilar() from public, anon, authenticated;

-- Atasco → aviso inmediato (además del cron)
create or replace function public.tg_eventos_aviso_atasco()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from nuevas where tipo = 'atasco_inicio') then
    perform public.llamar_vigilar();
  end if;
  return null;
end $$;

drop trigger if exists eventos_aviso_atasco on public.eventos;
create trigger eventos_aviso_atasco
  after insert on public.eventos
  referencing new table as nuevas
  for each statement execute function public.tg_eventos_aviso_atasco();

-- ---------- Programación con pg_cron (si está disponible) ----------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'vigilar-contador';
    perform cron.schedule('vigilar-contador', '* * * * *', 'select public.llamar_vigilar()');
  end if;
end $$;
