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
