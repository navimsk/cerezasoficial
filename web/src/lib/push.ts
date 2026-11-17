// Notificaciones push (Web Push). La suscripción se guarda en Supabase (suscripciones_push)
// y la Edge Function "vigilar" envía los avisos.
import { supabase, URL_FUNCIONES } from './supabase'

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

export type EstadoPush =
  | 'no_soportado'        // navegador sin Push API
  | 'ios_instalar'        // iPhone/iPad: solo funciona con la app instalada en la pantalla de inicio
  | 'sin_configurar'      // falta VITE_VAPID_PUBLIC_KEY
  | 'bloqueado'           // el usuario negó el permiso
  | 'inactivo'
  | 'activo'

export interface Preferencias { atasco: boolean; sin_contacto: boolean; ritmo: boolean }

const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const instalada = () => matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true

export function soportado(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function registro(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  const r = await navigator.serviceWorker.getRegistration()
  return r ?? null
}

export async function estadoPush(): Promise<EstadoPush> {
  if (esIOS() && !instalada()) return 'ios_instalar'
  if (!soportado()) return 'no_soportado'
  if (Notification.permission === 'denied') return 'bloqueado'
  const r = await registro()
  const sub = await r?.pushManager.getSubscription()
  if (sub) return 'activo'
  if (!VAPID) return 'sin_configurar'
  return 'inactivo'
}

function base64UrlAUint8(b64: string): Uint8Array<ArrayBuffer> {
  const relleno = '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob((b64 + relleno).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function activarPush(): Promise<void> {
  if (!VAPID) throw new Error('Falta la clave pública VAPID (VITE_VAPID_PUBLIC_KEY).')
  const permiso = await Notification.requestPermission()
  if (permiso !== 'granted') throw new Error('No se dio permiso para notificaciones.')
  const r = await navigator.serviceWorker.ready
  const sub = (await r.pushManager.getSubscription()) ?? await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlAUint8(VAPID) })
  const j = sub.toJSON()
  const sb = supabase()
  const { data: u } = await sb.auth.getUser()
  if (!u.user) throw new Error('Sesión vencida: vuelve a entrar.')
  const { error } = await sb.from('suscripciones_push').upsert({
    user_id: u.user.id, endpoint: sub.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, agente: navigator.userAgent.slice(0, 200),
  }, { onConflict: 'endpoint' })
  if (error) { await sub.unsubscribe(); throw new Error(error.message) }
}

export async function desactivarPush(): Promise<void> {
  const r = await registro()
  const sub = await r?.pushManager.getSubscription()
  if (!sub) return
  await supabase().from('suscripciones_push').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe()
}

export async function leerPreferencias(): Promise<Preferencias> {
  const { data } = await supabase().from('preferencias_notif').select('atasco, sin_contacto, ritmo').maybeSingle()
  return data ?? { atasco: true, sin_contacto: true, ritmo: true }
}

export async function guardarPreferencias(p: Preferencias): Promise<void> {
  const sb = supabase()
  const { data: u } = await sb.auth.getUser()
  if (!u.user) throw new Error('Sesión vencida')
  const { error } = await sb.from('preferencias_notif').upsert({ user_id: u.user.id, ...p, actualizado: new Date().toISOString() })
  if (error) throw new Error(error.message)
}

/** Pide a la Edge Function un aviso de prueba a los dispositivos de este usuario. */
export async function enviarPrueba(): Promise<number> {
  const { data } = await supabase().auth.getSession()
  const r = await fetch(`${URL_FUNCIONES}/vigilar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify({ prueba: true }),
  })
  if (!r.ok) throw new Error(`La función respondió ${r.status}`)
  return (await r.json()).enviados ?? 0
}

/** Notificación local (sin servidor), para ver cómo se ve en modo demo. */
export async function notificacionLocal(): Promise<void> {
  if (!('Notification' in window)) throw new Error('Este navegador no muestra notificaciones.')
  const permiso = await Notification.requestPermission()
  if (permiso !== 'granted') throw new Error('No se dio permiso para notificaciones.')
  const r = await navigator.serviceWorker?.getRegistration()
  const opciones = { body: 'Haz cortado desde las 14:05. El conteo está en pausa hasta que se libere.', icon: '/icono-192.png', tag: 'demo' }
  if (r) await r.showNotification('Atasco en Línea 1 (ejemplo)', opciones)
  else new Notification('Atasco en Línea 1 (ejemplo)', opciones)
}
