import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { Equipo, FuenteDatos } from './tipos'
import { FuenteDemo } from '../demo/fuenteDemo'
import { FuenteSupabase } from './fuenteSupabase'
import { supabase, usarDemo } from '../lib/supabase'
import { cacheGuardar, cacheLeer } from '../lib/hooks'
import { Login, NoAutorizado, Cargando } from '../pantallas/Login'

export interface Perfil { email: string; rol: 'jefatura' | 'admin' | null; nombre: string }

interface Ctx {
  fuente: FuenteDatos
  equipo: Equipo | null
  equipos: Equipo[]
  setEquipoId: (id: string) => void
  /** Último evento recibido (de cualquier tipo), para el indicador en vivo. */
  ultimoContacto: number | null
  perfil: Perfil | null
  sesion: Session | null
}

const Contexto = createContext<Ctx | null>(null)

/** Elige la fuente y, con Supabase, exige sesión de un usuario autorizado. */
export function ProveedorDatos({ children }: { children: ReactNode }) {
  const demo = useMemo(usarDemo, [])
  if (demo) return <ConFuente fuente={null} perfil={{ email: 'demo', rol: 'jefatura', nombre: 'Demo' }} sesion={null}>{children}</ConFuente>
  return <ConSesion>{children}</ConSesion>
}

function ConSesion({ children }: { children: ReactNode }) {
  const [sesion, setSesion] = useState<Session | null | undefined>(undefined)
  const [perfil, setPerfil] = useState<Perfil | null | undefined>(undefined)

  useEffect(() => {
    const sb = supabase()
    sb.auth.getSession().then(({ data }) => setSesion(data.session))
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSesion(s))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!sesion) { setPerfil(sesion === null ? null : undefined); return }
    const cache = cacheLeer<Perfil>(`perfil.${sesion.user.id}`)
    supabase().rpc('mi_perfil').single().then(({ data, error }) => {
      if (error) {
        // sin red: confiar en el último perfil conocido para mostrar datos guardados
        setPerfil(cache?.v ?? { email: sesion.user.email ?? '', rol: null, nombre: '' })
        return
      }
      const d = data as { email: string; rol: Perfil['rol']; nombre: string | null }
      const p = { email: d.email, rol: d.rol, nombre: d.nombre ?? '' }
      cacheGuardar(`perfil.${sesion.user.id}`, p)
      setPerfil(p)
    })
  }, [sesion])

  if (sesion === undefined || (sesion && perfil === undefined)) return <Cargando />
  if (!sesion) return <Login />
  if (!perfil?.rol) return <NoAutorizado email={perfil?.email ?? sesion.user.email ?? ''} />
  return <ConFuente fuente="supabase" perfil={perfil} sesion={sesion}>{children}</ConFuente>
}

function ConFuente({ fuente: tipo, perfil, sesion, children }: { fuente: 'supabase' | null; perfil: Perfil; sesion: Session | null; children: ReactNode }) {
  const fuente = useMemo<FuenteDatos>(() => (tipo === 'supabase' ? new FuenteSupabase() : new FuenteDemo()), [tipo])
  const [equipos, setEquipos] = useState<Equipo[]>(() => cacheLeer<Equipo[]>('equipos')?.v ?? [])
  const [equipoId, setEquipoId] = useState<string>(() => leer('cajas.equipo') ?? '')
  const [ultimoContacto, setUltimo] = useState<number | null>(() => cacheLeer<number>('ultimoContacto')?.v ?? null)

  useEffect(() => {
    fuente.equipos().then(e => { setEquipos(e); cacheGuardar('equipos', e) }).catch(() => { /* sin red: se usa la caché */ })
  }, [fuente])
  const equipo = equipos.find(e => e.id === equipoId) ?? equipos[0] ?? null

  useEffect(() => {
    if (!equipo) return
    let vivo = true
    const fijar = (t: number | null) => { if (vivo && t) { setUltimo(u => Math.max(u ?? 0, t)); cacheGuardar('ultimoContacto', t) } }
    fuente.resumenVivo(equipo.id).then(r => fijar(r.ultimoContacto)).catch(() => {})
    const quitar = fuente.suscribir(equipo.id, e => fijar(fuente.modo === 'supabase' ? Date.now() : e.ts))
    // respaldo por si Realtime se corta: refrescar el último contacto cada 30 s
    const id = setInterval(() => { fuente.resumenVivo(equipo.id).then(r => fijar(r.ultimoContacto)).catch(() => {}) }, 30_000)
    return () => { vivo = false; quitar(); clearInterval(id) }
  }, [fuente, equipo])

  const valor = useMemo<Ctx>(() => ({
    fuente, equipo, equipos, ultimoContacto, perfil, sesion,
    setEquipoId: (id: string) => { setEquipoId(id); guardar('cajas.equipo', id) },
  }), [fuente, equipo, equipos, ultimoContacto, perfil, sesion])

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>
}

export function useDatos() {
  const c = useContext(Contexto)
  if (!c) throw new Error('useDatos fuera de ProveedorDatos')
  return c
}

function leer(k: string): string | null { try { return localStorage.getItem(k) } catch { return null } }
function guardar(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* sin almacenamiento */ } }
