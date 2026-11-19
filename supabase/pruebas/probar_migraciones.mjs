// Prueba las migraciones en un Postgres real (PGlite, en memoria) sin Docker.
//   cd supabase/pruebas && npm install && npm test
// Simula lo mínimo de Supabase (roles anon/authenticated/service_role, auth.jwt(), auth.users),
// aplica las migraciones DOS veces (idempotencia), carga datos del simulador por la misma
// función que usa la Edge Function "ingesta" y verifica seguridad, agregados y RPC.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { simularDia } from '../../web/src/demo/simulador.ts'
import { inicioDia, sumarDias } from '../../web/src/lib/tiempo.ts'

const DIR = new URL('../migrations/', import.meta.url)
const db = new PGlite()
let fallas = 0
const ok = (cond, msg) => { console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`); if (!cond) fallas++ }

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant select on auth.users to service_role;
  create publication supabase_realtime;
  create schema extensions;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`)

const archivos = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
console.log('Migraciones:', archivos.join(', '))
for (const vuelta of [1, 2]) {
  for (const f of archivos) {
    try { await db.exec(readFileSync(new URL(f, DIR), 'utf8')) }
    catch (e) { ok(false, `vuelta ${vuelta} ${f}: ${e.message}`); process.exit(1) }
  }
  ok(true, `migraciones aplicadas (vuelta ${vuelta})`)
}

// ---------- datos ----------
const token = 'token-de-prueba-0123456789abcdef'
const hash = createHash('sha256').update(token).digest('hex')
await db.query(`select public.registrar_token_equipo('linea-1', $1)`, [hash])

const ahora = Date.now()
const hoy = inicioDia(ahora)
let seq = 1, todos = []
const DIAS = 16
for (let i = DIAS; i >= 0; i--) {
  const d = i === 0 ? hoy : inicioDia(sumarDias(hoy + 12 * 3600e3, -i))
  const r = simularDia({ equipoId: 'linea-1', semilla: 7, diaInicio: d, indiceTemporada: 0.5, seqInicio: seq, forzarActivoEn: i === 0 ? ahora : undefined })
  seq = r.seqFin
  todos.push(...r.eventos.filter(e => e.ts <= ahora))
}
const json = e => ({ ...e, ts: new Date(e.ts).toISOString() })

async function comoRol(rol, claims, fn) {
  await db.exec('begin')
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? {})])
  await db.exec(`set local role ${rol}`)
  try { return await fn() } finally { await db.exec('rollback') }
}
async function comoRolCommit(rol, fn) {
  await db.exec('begin'); await db.exec(`set local role ${rol}`)
  try { const r = await fn(); await db.exec('commit'); return r } catch (e) { await db.exec('rollback'); throw e }
}

console.log(`Cargando ${todos.length} eventos (${DIAS + 1} días) por ingestar_eventos…`)
const t0 = Date.now()
let insertados = 0
for (let i = 0; i < todos.length; i += 500) {
  const lote = todos.slice(i, i + 500).map(json)
  const r = await comoRolCommit('service_role', () => db.query('select * from public.ingestar_eventos($1, $2)', [hash, JSON.stringify(lote)]))
  insertados += r.rows[0].insertados
}
console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
ok(insertados === todos.length, `insertados ${insertados} de ${todos.length}`)

// reenvío del mismo lote: no duplica
const relote = todos.slice(1000, 1500).map(json)
const re = await comoRolCommit('service_role', () => db.query('select * from public.ingestar_eventos($1, $2)', [hash, JSON.stringify(relote)]))
ok(re.rows[0].insertados === 0, 'reenviar un lote no inserta duplicados')

// token malo
try {
  await comoRolCommit('service_role', () => db.query('select * from public.ingestar_eventos($1, $2)', ['0'.repeat(64), '[]']))
  ok(false, 'token inválido debe fallar')
} catch (e) { ok(e.message.includes('token_invalido'), 'token inválido es rechazado') }

// ---------- agregados ----------
const sumaN = todos.reduce((a, e) => a + e.n, 0)
const agg = (await db.query(`select (select sum(cajas) from agg_minuto) m, (select sum(cajas) from agg_hora) h, (select sum(cajas) from agg_dia) d,
  (select sum(n) from eventos) e, (select sum(atascos) from agg_dia) a, (select count(*) from eventos where tipo='atasco_inicio') ae`)).rows[0]
ok(Number(agg.e) === sumaN && Number(agg.m) === sumaN && Number(agg.h) === sumaN && Number(agg.d) === sumaN,
  `conteo = suma de n en eventos y en los 3 agregados (${sumaN})`)
ok(Number(agg.a) === Number(agg.ae), `atascos agregados = eventos atasco_inicio (${agg.a})`)

// recalcular desde cero da lo mismo
await db.query('select public.recalcular_agregados()')
const agg2 = (await db.query('select sum(cajas) d from agg_dia')).rows[0]
ok(Number(agg2.d) === sumaN, 'recalcular_agregados reproduce el total')

// ---------- seguridad ----------
const anonLee = await comoRol('anon', {}, () => db.query('select count(*)::int c from eventos'))
ok(anonLee.rows[0].c === 0, 'anon NO lee eventos')
const anonAgg = await comoRol('anon', {}, async () => { try { return (await db.query('select count(*)::int c from agg_dia')).rows[0].c } catch { return 0 } })
ok(anonAgg === 0, 'anon NO lee agregados')
const anonIns = await comoRol('anon', {}, async () => {
  try { await db.query(`insert into eventos (equipo_id, seq, tipo, n) values ('linea-1', 99999999, 'caja', 1)`); return true } catch { return false }
})
ok(anonIns, 'anon SÍ inserta mientras permitir_insert_anon = true (compatibilidad firmware v2)')
const anonInsOtro = await comoRol('anon', {}, async () => {
  try { await db.query(`insert into eventos (equipo_id, seq, tipo, n) values ('equipo-falso', 1, 'caja', 1)`); return true } catch { return false }
})
ok(!anonInsOtro, 'anon NO inserta para un equipo que no existe')
await db.query(`update ajustes_sistema set valor = 'false' where clave = 'permitir_insert_anon'`)
const anonIns2 = await comoRol('anon', {}, async () => {
  try { await db.query(`insert into eventos (equipo_id, seq, tipo, n) values ('linea-1', 99999998, 'caja', 1)`); return true } catch { return false }
})
ok(!anonIns2, 'anon NO inserta con permitir_insert_anon = false')
await db.query(`update ajustes_sistema set valor = 'true' where clave = 'permitir_insert_anon'`)

const anonToken = await comoRol('anon', {}, async () => { try { await db.query(`select token_hash from equipos`); return true } catch { return false } })
ok(!anonToken, 'anon no puede leer token_hash')

const uid = '11111111-1111-1111-1111-111111111111'
await db.query(`insert into auth.users (id, email) values ($1, 'jefa@packing.cl')`, [uid])
const claims = { sub: uid, email: 'jefa@packing.cl', role: 'authenticated' }
const noAut = await comoRol('authenticated', claims, () => db.query('select count(*)::int c from eventos'))
ok(noAut.rows[0].c === 0, 'usuario autenticado pero NO autorizado no lee eventos')
const tokAuth = await comoRol('authenticated', claims, async () => { try { await db.query(`select token_hash from equipos`); return true } catch { return false } })
ok(!tokAuth, 'usuario autenticado no puede leer token_hash')

await db.query(`insert into usuarios_autorizados (email, rol) values ('jefa@packing.cl', 'jefatura')`)
const aut = await comoRol('authenticated', claims, () => db.query('select count(*)::int c from eventos'))
ok(aut.rows[0].c > 0, 'usuario autorizado lee eventos')
const perfil = await comoRol('authenticated', claims, () => db.query('select * from mi_perfil()'))
ok(perfil.rows[0].rol === 'jefatura', 'mi_perfil() devuelve el rol')
const noAdmin = await comoRol('authenticated', claims, async () => {
  try { await db.query(`insert into usuarios_autorizados (email) values ('otro@x.cl')`); return true } catch { return false }
})
ok(!noAdmin, 'jefatura NO puede agregar usuarios')

// ---------- RPC ----------
const enJs = (desde, hasta) => todos.filter(e => e.ts >= desde && e.ts < hasta).reduce((a, e) => a + e.n, 0)
const rv = await comoRol('authenticated', claims, () => db.query(`select * from resumen_vivo('linea-1')`))
const r = rv.rows[0]
console.log('  resumen_vivo:', { hoy: r.hoy, ayer: r.ayer_misma_hora, sem: r.semana_anterior_misma_hora, ritmo10: r.ritmo10, habitual: r.ritmo_habitual, atascos: r.atascos_hoy, en_atasco: r.en_atasco })
ok(Number(r.hoy) === enJs(hoy, ahora + 1), `resumen_vivo.hoy coincide con los eventos (${r.hoy})`)
const ayerFin = sumarDias(ahora, -1)
ok(Math.abs(Number(r.ayer_misma_hora) - enJs(inicioDia(ayerFin), ayerFin)) <= 40, 'ayer a la misma hora ≈ eventos (resolución de 1 min)')

const s = await comoRol('authenticated', claims, () => db.query(
  `select * from serie('linea-1', $1, $2, 'day')`, [new Date(sumarDias(hoy, -14)).toISOString(), new Date(ahora).toISOString()]))
ok(s.rows.length === 15, `serie por día: 15 puntos con ceros (${s.rows.length})`)
const sh = await comoRol('authenticated', claims, () => db.query(
  `select * from serie('linea-1', $1, $2, 'hour')`, [new Date(hoy).toISOString(), new Date(hoy + 86400e3).toISOString()]))
ok(sh.rows.length === 24 && sh.rows.reduce((a, x) => a + Number(x.cajas), 0) === Number(r.hoy), 'serie por hora de hoy: 24 puntos que suman lo de hoy')
const sw = await comoRol('authenticated', claims, () => db.query(
  `select * from serie('linea-1', $1, $2, 'week')`, [new Date(sumarDias(hoy, -16)).toISOString(), new Date(ahora).toISOString()]))
ok(sw.rows.length >= 3, `serie por semana (${sw.rows.length} semanas)`)

const sal = await comoRol('authenticated', claims, () => db.query(`select * from salud_equipos()`))
console.log('  salud:', sal.rows[0])
ok(sal.rows.length === 1 && sal.rows[0].rssi !== null, 'salud_equipos devuelve el último heartbeat')

const at = await comoRol('authenticated', claims, () => db.query(
  `select * from atascos_rango('linea-1', $1, $2)`, [new Date(sumarDias(hoy, -16)).toISOString(), new Date(ahora).toISOString()]))
ok(at.rows.length === Number(agg.ae), `atascos_rango lista todos los atascos (${at.rows.length})`)

const dp = await comoRol('authenticated', claims, () => db.query(`select * from datos_proyeccion('linea-1', 30)`))
ok(dp.rows.length > 100, `datos_proyeccion devuelve franjas de 15 min (${dp.rows.length})`)

const pd = await comoRol('authenticated', claims, () => db.query(`select primer_dato('linea-1') p`))
ok(pd.rows[0].p !== null, 'primer_dato')

// ---------- avisos ----------
const al = await comoRolCommit('service_role', () => db.query('select * from alertas_pendientes()'))
console.log('  alertas:', al.rows.map(x => `${x.tipo}: ${x.cuerpo}`))
ok(true, 'alertas_pendientes se ejecuta')
// forzar un atasco reciente y comprobar que genera aviso una sola vez
const ultSeq = (await db.query(`select max(seq)::bigint m from eventos`)).rows[0].m
await comoRolCommit('service_role', () => db.query('select * from public.ingestar_eventos($1, $2)', [hash, JSON.stringify([
  { seq: Number(ultSeq) + 1, tipo: 'atasco_inicio', n: 0, ts: new Date().toISOString() }])]))
const al1 = await comoRolCommit('service_role', () => db.query('select * from alertas_pendientes()'))
ok(al1.rows.some(x => x.tipo === 'atasco'), `atasco reciente genera aviso: "${al1.rows.find(x => x.tipo === 'atasco')?.cuerpo}"`)
await db.query(`insert into notificaciones_despachadas (notificacion_id) select id from notificaciones_enviadas on conflict do nothing`)
const al2 = await comoRolCommit('service_role', () => db.query('select * from alertas_pendientes()'))
ok(al2.rows.length === 0, 'segunda llamada no repite avisos ya despachados')
const rv2 = await comoRol('authenticated', claims, () => db.query(`select en_atasco from resumen_vivo('linea-1')`))
ok(rv2.rows[0].en_atasco === true, 'resumen_vivo marca en_atasco')
const dest = await comoRolCommit('service_role', () => db.query(`select * from destinatarios_push('atasco')`))
ok(dest.rows.length === 0, 'sin suscripciones no hay destinatarios')

const noServ = await comoRol('authenticated', claims, async () => { try { await db.query('select * from alertas_pendientes()'); return true } catch { return false } })
ok(!noServ, 'un usuario no puede ejecutar alertas_pendientes')

// ---------- 0007 · configuración del equipo desde la app ----------
console.log('\nConfiguración del equipo')
const cfg0 = (await db.query(`select largo_caja_mm, vel_cinta_mm_s, aprender_vel, config_actualizada from equipos where id = 'linea-1'`)).rows[0]
ok(cfg0.largo_caja_mm === 505 && Math.abs(cfg0.vel_cinta_mm_s - 292.3) < 0.05, `línea 1 con medidas oficiales (${cfg0.largo_caja_mm} mm, ${cfg0.vel_cinta_mm_s} mm/s)`)
const jefaEdita = await comoRol('authenticated', claims, async () =>
  (await db.query(`update equipos set vel_cinta_mm_s = 100 where id = 'linea-1' returning id`)).rows.length)
ok(jefaEdita === 0, 'jefatura no puede cambiar la velocidad')
await db.query(`insert into usuarios_autorizados (email, rol) values ('admin@packing.cl', 'admin')`)
const claimsAdmin = { sub: uid, email: 'admin@packing.cl', role: 'authenticated' }
const adminEdita = await comoRol('authenticated', claimsAdmin, async () => {
  const r = await db.query(`update equipos set vel_cinta_mm_s = 250, aprender_vel = false where id = 'linea-1' returning vel_cinta_mm_s, aprender_vel, config_actualizada`)
  return r.rows[0]
})
ok(adminEdita?.vel_cinta_mm_s === 250 && adminEdita.aprender_vel === false, 'admin puede cambiar velocidad y aprendizaje')
ok(adminEdita && new Date(adminEdita.config_actualizada) >= new Date(cfg0.config_actualizada), 'editar la configuración actualiza su versión')
const tokenOculto = await comoRol('authenticated', claimsAdmin, async () => { try { await db.query(`select token_hash from equipos`); return false } catch { return true } })
ok(tokenOculto, 'token_hash sigue oculto para usuarios')
const fueraRango = await (async () => { try { await db.query(`update equipos set vel_cinta_mm_s = 5000 where id = 'linea-1'`); return false } catch { return true } })()
ok(fueraRango, 'velocidad fuera de rango se rechaza')

// ---------- 0008 · sensor tapado al cierre y baliza ----------
console.log('\nSensor tapado al cierre')
const cfgB = (await db.query(`select baliza_max_min, hora_cierre from equipos where id = 'linea-1'`)).rows[0]
ok(cfgB.baliza_max_min === 10 && cfgB.hora_cierre === null, 'baliza 10 min por defecto y sin hora de cierre')
const sinCierre = await comoRolCommit('service_role', () => db.query(`select * from alertas_pendientes() where tipo = 'sensor_tapado'`))
ok(sinCierre.rows.length === 0, 'sin hora de cierre no hay aviso de sensor tapado')
// cierre hace 30 min (hora de Chile) con el atasco de la prueba anterior todavía abierto
await db.query(`update equipos set hora_cierre = ((now() at time zone 'America/Santiago') - interval '30 min')::time where id = 'linea-1'`)
const tap1 = await comoRolCommit('service_role', () => db.query(`select * from alertas_pendientes() where tipo = 'sensor_tapado'`))
ok(tap1.rows.length === 1, `haz cortado después del cierre avisa: "${tap1.rows[0]?.cuerpo}"`)
await db.query(`insert into notificaciones_despachadas (notificacion_id) select id from notificaciones_enviadas on conflict do nothing`)
const tap2 = await comoRolCommit('service_role', () => db.query(`select * from alertas_pendientes() where tipo = 'sensor_tapado'`))
ok(tap2.rows.length === 0, 'el aviso de sensor tapado sale una sola vez por día')
// cierre hace 3 h: fuera de la ventana de 2 h
await db.query(`delete from notificaciones_enviadas where tipo = 'sensor_tapado'`)
await db.query(`update equipos set hora_cierre = ((now() at time zone 'America/Santiago') - interval '3 hours')::time where id = 'linea-1'`)
const tap3 = await comoRolCommit('service_role', () => db.query(`select * from alertas_pendientes() where tipo = 'sensor_tapado'`))
ok(tap3.rows.length === 0, 'pasadas 2 h del cierre ya no avisa')
const versionAntes = (await db.query(`select config_actualizada from equipos where id = 'linea-1'`)).rows[0].config_actualizada
await db.exec('begin'); await db.exec(`update equipos set baliza_max_min = 0 where id = 'linea-1'`)
const versionDespues = (await db.query(`select config_actualizada from equipos where id = 'linea-1'`)).rows[0].config_actualizada
await db.exec('rollback')
ok(new Date(versionDespues) >= new Date(versionAntes), 'cambiar la baliza actualiza la versión de la configuración')
const malTipo = await (async () => { try { await db.query(`insert into notificaciones_enviadas (equipo_id, tipo, ref, titulo, cuerpo) values ('linea-1','otro','x','t','c')`); return false } catch { return true } })()
ok(malTipo, 'tipos de aviso desconocidos se rechazan')

console.log(fallas ? `\n${fallas} PRUEBA(S) FALLARON` : '\nTodas las pruebas pasan.')
process.exit(fallas ? 1 : 0)
