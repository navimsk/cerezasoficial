-- =====================================================================
--  0008 · Prevención del sensor tapado fuera de turno
--  - baliza_max_min: minutos máximos que la baliza de atasco (relé DO2) queda encendida
--    (0 = sin límite). El equipo lo recibe con su configuración.
--  - hora_cierre: hora habitual de término del turno (hora de Chile, opcional).
--    Hasta 2 h después de esa hora, si el haz sigue cortado, se avisa "sensor tapado"
--    una vez por día, para revisarlo antes de irse.
--  El aviso usa la misma preferencia que "Atasco" (no agrega un interruptor nuevo).
-- =====================================================================

alter table public.equipos add column if not exists baliza_max_min smallint not null default 10
  check (baliza_max_min between 0 and 1440);
alter table public.equipos add column if not exists hora_cierre time;

grant select (baliza_max_min, hora_cierre) on public.equipos to authenticated;
grant update (baliza_max_min, hora_cierre) on public.equipos to authenticated;

-- La baliza viaja al equipo: su cambio también cambia la versión de la configuración
create or replace function public.tg_equipos_config() returns trigger
language plpgsql as $$
begin
  if new.largo_caja_mm is distinct from old.largo_caja_mm
     or new.vel_cinta_mm_s is distinct from old.vel_cinta_mm_s
     or new.aprender_vel is distinct from old.aprender_vel
     or new.baliza_max_min is distinct from old.baliza_max_min then
    new.config_actualizada := now();
  end if;
  return new;
end $$;

-- Nuevo tipo de aviso
alter table public.notificaciones_enviadas drop constraint if exists notificaciones_enviadas_tipo_check;
alter table public.notificaciones_enviadas add constraint notificaciones_enviadas_tipo_check
  check (tipo in ('atasco', 'sin_contacto', 'ritmo', 'sensor_tapado'));

create or replace function public.destinatarios_push(p_tipo text)
returns table (sub_id bigint, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select s.id, s.endpoint, s.p256dh, s.auth
  from suscripciones_push s
  join auth.users u on u.id = s.user_id
  join usuarios_autorizados a on a.email = lower(u.email) and a.activo
  left join preferencias_notif p on p.user_id = s.user_id
  where case p_tipo
          when 'atasco'        then coalesce(p.atasco, true)
          when 'sensor_tapado' then coalesce(p.atasco, true)
          when 'sin_contacto'  then coalesce(p.sin_contacto, true)
          when 'ritmo'         then coalesce(p.ritmo, true)
          else false end
$$;

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
  v_desde timestamptz;
  v_haz boolean;
  v_cierre timestamp;
begin
  for q in select e.id, e.nombre, e.hora_cierre from equipos e where e.activo loop
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

    -- estado del haz: atasco abierto, o el último heartbeat reporta haz cortado
    select e.tipo = 'atasco_inicio', e.ts into v_atasco, v_desde from eventos e
     where e.equipo_id = q.id and e.tipo in ('atasco_inicio', 'atasco_fin')
     order by e.ts desc limit 1;
    v_atasco := coalesce(v_atasco, false);
    select (e.extra ->> 'haz')::boolean into v_haz from eventos e
     where e.equipo_id = q.id and e.tipo in ('heartbeat', 'inicio') and e.recibido > now() - interval '2 minutes'
     order by e.ts desc limit 1;

    -- sensor tapado después del cierre (ventana de 2 h desde hora_cierre; una vez por día)
    if q.hora_cierre is not null and v_ult is not null and v_ult >= now() - interval '2 minutes' then
      v_cierre := loc::date + q.hora_cierre;
      if v_cierre > loc then v_cierre := v_cierre - interval '1 day'; end if;
      if loc < v_cierre + interval '2 hours' and (v_atasco or coalesce(v_haz, false)) then
        insert into notificaciones_enviadas (equipo_id, tipo, ref, titulo, cuerpo)
        values (q.id, 'sensor_tapado', to_char(v_cierre, 'YYYYMMDD'),
                'Sensor tapado en ' || q.nombre,
                'Terminó el turno (' || to_char(q.hora_cierre, 'HH24:MI') || ') y el haz sigue cortado' ||
                case when v_atasco then ' desde las ' || to_char(v_desde at time zone tz, 'HH24:MI') else '' end ||
                '. Revisa que no quede una caja u objeto frente al sensor y que el reflector esté en su lugar.')
        on conflict on constraint notificaciones_unicas do nothing;
      end if;
    end if;

    -- caída de ritmo
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

revoke all on function public.alertas_pendientes(), public.destinatarios_push(text) from public, anon, authenticated;
grant execute on function public.alertas_pendientes(), public.destinatarios_push(text) to service_role;
