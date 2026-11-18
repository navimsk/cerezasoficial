-- =====================================================================
--  0007 · Configuración del equipo editable desde la app
--  - vel_cinta_mm_s: velocidad de la cinta que fija un admin (null = el equipo usa la suya)
--  - aprender_vel:   si el equipo sigue ajustando la velocidad sola con las cajas sueltas
--  - config_actualizada: cambia cada vez que se edita; el equipo la recibe en la respuesta
--    de la función ingesta y solo aplica la configuración cuando esta marca cambia.
-- =====================================================================

alter table public.equipos add column if not exists vel_cinta_mm_s real
  check (vel_cinta_mm_s is null or vel_cinta_mm_s between 10 and 3000);
alter table public.equipos add column if not exists aprender_vel boolean not null default true;
alter table public.equipos add column if not exists config_actualizada timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'equipos_largo_caja_rango') then
    alter table public.equipos add constraint equipos_largo_caja_rango check (largo_caja_mm between 50 and 2000);
  end if;
end $$;

create or replace function public.tg_equipos_config() returns trigger
language plpgsql as $$
begin
  if new.largo_caja_mm is distinct from old.largo_caja_mm
     or new.vel_cinta_mm_s is distinct from old.vel_cinta_mm_s
     or new.aprender_vel is distinct from old.aprender_vel then
    new.config_actualizada := now();
  end if;
  return new;
end $$;

drop trigger if exists tg_equipos_config on public.equipos;
create trigger tg_equipos_config before update on public.equipos
  for each row execute function public.tg_equipos_config();

-- Lectura para usuarios autorizados; edición solo admin (política "admin edita equipos" de 0002)
grant select (vel_cinta_mm_s, aprender_vel, config_actualizada) on public.equipos to authenticated;
grant update (vel_cinta_mm_s, aprender_vel) on public.equipos to authenticated;

-- Medidas oficiales de la línea 1 (caja 50,5 × 27,5 × 20 cm, avanza a lo largo; cinta 17,54 m/min)
update public.equipos
   set largo_caja_mm = 505, vel_cinta_mm_s = round((17.54 * 1000 / 60)::numeric, 1)
 where id = 'linea-1' and largo_caja_mm = 450 and vel_cinta_mm_s is null;
