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
