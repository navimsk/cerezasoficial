// Edge Function "vigilar": calcula avisos y los envía por Web Push.
//
// Dos formas de llamarla:
//  1) pg_cron (cada minuto) y el trigger de atasco, vía pg_net, con  x-cron-secret: <CRON_SECRET>
//  2) la app, para una notificación de prueba:  Authorization: Bearer <JWT del usuario>,
//     cuerpo { "prueba": true }  → se envía solo a los dispositivos de ese usuario.
//
// Secretos de la función (supabase secrets set …):
//   CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:… o https://…)
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import webpush from 'npm:web-push@3.6.7'
import { igualSeguro } from '../_compartido/eventos.ts'

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})
webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'mailto:avisos@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
  Deno.env.get('VAPID_PRIVATE_KEY') ?? '',
)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (c: unknown, s = 200) => new Response(JSON.stringify(c), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

interface Sub { sub_id: number; endpoint: string; p256dh: string; auth: string }

async function enviar(subs: Sub[], carga: Record<string, unknown>): Promise<number> {
  let ok = 0
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(carga), { TTL: 600, urgency: 'high' })
      ok++
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) await sb.from('suscripciones_push').delete().eq('id', s.sub_id)   // suscripción vencida
      else console.error('push:', status, (e as Error).message)
    }
  }))
  return ok
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'metodo_no_permitido' }, 405)

  // ---- 1) llamada del cron ----
  const secreto = req.headers.get('x-cron-secret')
  const esperado = Deno.env.get('CRON_SECRET') ?? ''
  if (secreto !== null) {
    if (!esperado || !igualSeguro(secreto, esperado)) return json({ error: 'no_autorizado' }, 401)
    const { data: alertas, error } = await sb.rpc('alertas_pendientes')
    if (error) { console.error(error.message); return json({ error: 'error_base_datos' }, 500) }
    const resumen: Array<{ id: number; tipo: string; enviados: number }> = []
    for (const a of alertas ?? []) {
      const { data: subs } = await sb.rpc('destinatarios_push', { p_tipo: a.tipo })
      const enviados = await enviar((subs ?? []) as Sub[], {
        titulo: a.titulo, cuerpo: a.cuerpo, tipo: a.tipo, equipo: a.equipo_id, url: '/', etiqueta: `${a.equipo_id}-${a.tipo}`,
      })
      await sb.from('notificaciones_despachadas').upsert({ notificacion_id: a.id, enviados })
      resumen.push({ id: a.id, tipo: a.tipo, enviados })
    }
    return json({ avisos: resumen })
  }

  // ---- 2) notificación de prueba pedida por un usuario ----
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ error: 'no_autorizado' }, 401)
  const { data: u, error: eu } = await sb.auth.getUser(jwt)
  if (eu || !u.user?.email) return json({ error: 'no_autorizado' }, 401)
  const { data: aut } = await sb.from('usuarios_autorizados').select('rol').eq('email', u.user.email.toLowerCase()).eq('activo', true).maybeSingle()
  if (!aut) return json({ error: 'no_autorizado' }, 403)
  const { data: subs } = await sb.from('suscripciones_push').select('id, endpoint, p256dh, auth').eq('user_id', u.user.id)
  const enviados = await enviar((subs ?? []).map(s => ({ sub_id: s.id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth })), {
    titulo: 'Notificación de prueba', cuerpo: 'Así se verán los avisos de atasco, sin contacto y ritmo bajo.', tipo: 'prueba', url: '/ajustes',
  })
  return json({ enviados })
})
