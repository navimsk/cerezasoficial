import { useCallback, useEffect, useRef, useState } from 'react'
import { cacheGuardar, cacheLeer } from './hooks'

export interface Consulta<T> {
  datos: T | null
  cargando: boolean
  error: string | null
  /** Cuándo se obtuvo el dato que se muestra (puede venir de la caché local). */
  actualizado: number | null
  desdeCache: boolean
  recargar: () => void
  setDatos: (f: (d: T | null) => T | null) => void
}

/**
 * Consulta con caché local (para mala señal), recarga periódica y sin "saltos":
 * mientras carga, se mantiene el dato anterior.
 */
export function useConsulta<T>(clave: string | null, fn: () => Promise<T>, opciones: { cada?: number; cache?: boolean } = {}): Consulta<T> {
  const { cada, cache = true } = opciones
  const fnRef = useRef(fn)
  fnRef.current = fn
  const inicial = clave && cache ? cacheLeer<T>(clave) : null
  const [datos, setDatosE] = useState<T | null>(inicial?.v ?? null)
  const [actualizado, setActualizado] = useState<number | null>(inicial?.t ?? null)
  const [desdeCache, setDesdeCache] = useState(!!inicial)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [vuelta, setVuelta] = useState(0)
  const claveRef = useRef(clave)

  useEffect(() => {
    if (claveRef.current !== clave) {
      claveRef.current = clave
      const c = clave && cache ? cacheLeer<T>(clave) : null
      setDatosE(c?.v ?? null); setActualizado(c?.t ?? null); setDesdeCache(!!c)
    }
    if (!clave) return
    let vivo = true
    setCargando(true)
    fnRef.current()
      .then(d => {
        if (!vivo) return
        setDatosE(d); setActualizado(Date.now()); setDesdeCache(false); setError(null)
        if (cache) cacheGuardar(clave, d)
      })
      .catch(e => { if (vivo) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (vivo) setCargando(false) })
    return () => { vivo = false }
  }, [clave, vuelta, cache])

  useEffect(() => {
    if (!cada || !clave) return
    const id = setInterval(() => { if (document.visibilityState === 'visible') setVuelta(v => v + 1) }, cada)
    const alVolver = () => { if (document.visibilityState === 'visible') setVuelta(v => v + 1) }
    document.addEventListener('visibilitychange', alVolver)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', alVolver) }
  }, [cada, clave])

  const recargar = useCallback(() => setVuelta(v => v + 1), [])
  const setDatos = useCallback((f: (d: T | null) => T | null) => setDatosE(d => f(d)), [])
  return { datos, cargando, error, actualizado, desdeCache, recargar, setDatos }
}
