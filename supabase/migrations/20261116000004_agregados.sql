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
