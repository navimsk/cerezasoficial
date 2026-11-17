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
