import { useRef } from 'react'
import { decimal1, entero } from '../lib/formato'

/**
 * Número con numerales tabulares. Cuando sube, los dígitos que cambiaron entran con
 * un desplazamiento corto (180 ms; nada con prefers-reduced-motion).
 */
export function Cifra({ valor, decimales = 0, clase = '', etiqueta }: { valor: number | null; decimales?: 0 | 1; clase?: string; etiqueta?: string }) {
  const previo = useRef<{ v: number | null; s: string }>({ v: null, s: '' })
  const texto = valor === null || !Number.isFinite(valor) ? '—' : decimales ? decimal1(valor) : entero(valor)
  const sube = previo.current.v !== null && valor !== null && valor > previo.current.v
  const antes = previo.current.s
  previo.current = { v: valor, s: texto }

  // alinear por la derecha para saber qué dígitos cambiaron
  const desfase = texto.length - antes.length
  return (
    <span className={`cifra ${clase}`} aria-label={etiqueta ? `${etiqueta}: ${texto}` : undefined} role={etiqueta ? 'text' : undefined}>
      <span className="digitos" aria-hidden={etiqueta ? true : undefined}>
        {[...texto].map((c, i) => {
          const cambio = sube && antes[i - desfase] !== c
          return (
            <span key={cambio ? `${i}-${c}-${texto}` : `${i}`} className={cambio ? 'digito digito--sube' : 'digito'}>{c}</span>
          )
        })}
      </span>
    </span>
  )
}
