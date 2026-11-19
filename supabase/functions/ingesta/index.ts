// Edge Function "ingesta": recibe eventos del ESP32.
//
//   POST https://<ref>.supabase.co/functions/v1/ingesta
//   Headers:  Content-Type: application/json
//             x-equipo-token: <token del equipo>
//   Cuerpo:   un evento o un arreglo de hasta 500 eventos (mismo JSON que el firmware v2)
//
// Respuestas:
//   200 { equipo, recibidos, validos, insertados, duplicados, rechazados[] }
//       (eventos inválidos se rechazan y se informan, pero el lote se confirma:
//        reenviarlos no los volvería válidos)
//   400 JSON inválido · 401 token faltante o inválido · 405 método · 413 lote grande · 500 error
//
// La clave de servicio (SUPABASE_SERVICE_ROLE_KEY) la inyecta Supabase en el entorno de la
// función; no está en este repositorio.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { sha256Hex, validarLote } from '../_compartido/eventos.ts'

const cabeceras = { 'Content-Type': 'application/json; charset=utf-8' }
const responder = (cuerpo: unknown, estado = 200) => new Response(JSON.stringify(cuerpo), { status: estado, headers: cabeceras })

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder({ error: 'metodo_no_permitido' }, 405)

  const token = (req.headers.get('x-equipo-token') ?? '').trim()
  if (token.length < 20) return responder({ error: 'token_faltante' }, 401)

  let cuerpo: unknown
  try { cuerpo = await req.json() } catch { return responder({ error: 'json_invalido' }, 400) }

  const v = validarLote(cuerpo)
  if ('error' in v) return responder({ error: v.error }, 413)

  const hash = await sha256Hex(token)
  const { data, error } = await sb.rpc('ingestar_eventos', { p_token_hash: hash, p_eventos: v.validos })
  if (error) {
    if (error.message.includes('token_invalido')) return responder({ error: 'token_invalido' }, 401)
    console.error('ingesta:', error.message)
    return responder({ error: 'error_base_datos' }, 500)
  }
  const fila = Array.isArray(data) ? data[0] : data
  const insertados = fila?.insertados ?? 0
  if (v.rechazados.length) console.warn(`ingesta ${fila?.equipo}: ${v.rechazados.length} rechazados`, v.rechazados.slice(0, 5))

  // Configuración editable desde la app: el equipo la aplica cuando cambia "version".
  const { data: q } = await sb.from('equipos')
    .select('largo_caja_mm, vel_cinta_mm_s, aprender_vel, baliza_max_min, config_actualizada')
    .eq('id', fila?.equipo).maybeSingle()
  const config = q ? {
    version: new Date(q.config_actualizada).getTime(),
    largo_caja_mm: q.largo_caja_mm,
    vel_cinta_mm_s: q.vel_cinta_mm_s ?? 0,       // 0 = sin velocidad fijada: el equipo usa la suya
    aprender_vel: q.aprender_vel,
    baliza_max_min: q.baliza_max_min,           // 0 = sin límite
  } : undefined

  return responder({
    config,
    equipo: fila?.equipo,
    recibidos: v.validos.length + v.rechazados.length,
    validos: v.validos.length,
    insertados,
    duplicados: v.validos.length - insertados,
    rechazados: v.rechazados.slice(0, 20),
  })
})
