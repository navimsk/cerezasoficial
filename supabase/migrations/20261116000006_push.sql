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
