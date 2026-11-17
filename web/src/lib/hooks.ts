import { useEffect, useState, useSyncExternalStore } from 'react'

/** Reloj que se actualiza cada `cada` ms (para "hace X s"). */
export function useAhora(cada = 1000): number {
  const [t, setT] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), cada)
    return () => clearInterval(id)
  }, [cada])
  return t
}

/** true si el navegador tiene conexión de red. */
export function useEnLinea(): boolean {
  return useSyncExternalStore(
    cb => {
      window.addEventListener('online', cb)
      window.addEventListener('offline', cb)
      return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb) }
    },
    () => navigator.onLine,
    () => true,
  )
}

export type Tema = 'sistema' | 'claro' | 'oscuro'

export function aplicarTema(t: Tema) {
  const el = document.documentElement
  if (t === 'claro') el.dataset.theme = 'light'
  else if (t === 'oscuro') el.dataset.theme = 'dark'
  else delete el.dataset.theme
  try { localStorage.setItem('cajas.tema', t) } catch { /* sin almacenamiento */ }
}

export function useTema(): [Tema, (t: Tema) => void] {
  const [tema, setTema] = useState<Tema>(() => {
    try { return (localStorage.getItem('cajas.tema') as Tema) || 'sistema' } catch { return 'sistema' }
  })
  return [tema, (t: Tema) => { aplicarTema(t); setTema(t) }]
}

/** Guarda/lee el último valor bueno de una consulta (para funcionar con mala señal). */
export function cacheGuardar<T>(clave: string, valor: T) {
  try { localStorage.setItem(`cajas.cache.${clave}`, JSON.stringify({ t: Date.now(), v: valor })) } catch { /* lleno o bloqueado */ }
}
export function cacheLeer<T>(clave: string): { t: number; v: T } | null {
  try {
    const s = localStorage.getItem(`cajas.cache.${clave}`)
    return s ? JSON.parse(s) : null
  } catch { return null }
}
