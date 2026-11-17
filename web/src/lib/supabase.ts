import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/+$/, '').replace(/\/rest\/v1$/, '')
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const MODO = (import.meta.env.VITE_MODO_DATOS as string | undefined) ?? 'auto'

export const supabaseConfigurado = !!(URL && KEY)

let cliente: SupabaseClient | null = null
export function supabase(): SupabaseClient {
  if (!cliente) {
    if (!URL || !KEY) throw new Error('Supabase no está configurado (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)')
    cliente = createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  }
  return cliente
}

export const URL_FUNCIONES = URL ? `${URL}/functions/v1` : ''

/** ¿La app usa datos simulados? (variable de entorno, o el usuario eligió "ver demostración"). */
export function usarDemo(): boolean {
  try {
    const p = new URLSearchParams(location.search)
    if (p.get('demo') === '1') localStorage.setItem('cajas.modo', 'demo')
    if (p.get('demo') === '0') localStorage.removeItem('cajas.modo')
    if (localStorage.getItem('cajas.modo') === 'demo') return true
  } catch { /* sin almacenamiento */ }
  if (MODO === 'demo') return true
  if (MODO === 'supabase') return false
  return !supabaseConfigurado
}

export function salirDeDemo() {
  try { localStorage.removeItem('cajas.modo') } catch { /* nada */ }
  location.href = '/'
}
export function entrarADemo() {
  try { localStorage.setItem('cajas.modo', 'demo') } catch { /* nada */ }
  location.href = '/'
}
