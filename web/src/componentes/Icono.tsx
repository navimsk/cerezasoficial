// Set de íconos propio (24×24, trazo 1,75, currentColor). Ver DESIGN.md §8.
const P: Record<string, string> = {
  vivo: 'M12 10.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6z M7.8 7.8a6 6 0 0 0 0 8.4 M16.2 7.8a6 6 0 0 1 0 8.4 M5 5a10 10 0 0 0 0 14 M19 5a10 10 0 0 1 0 14',
  historial: 'M4 20h16 M7 16.5v-5 M12 16.5V6 M17 16.5v-8',
  proyeccion: 'M3 18l5-6 4 3 4-5 M3 21h18',
  exportar: 'M12 4v11 M7.5 10.5 12 15l4.5-4.5 M4 16.5V20h16v-3.5',
  equipo: 'M4 10h16v9H4z M8 14.5h3 M15.5 14.5h.01 M12 10V6.5 M9.4 4.6a3.7 3.7 0 0 1 5.2 0',
  ajustes: 'M4 7h9 M17 7h3 M15 5v4 M4 17h3 M11 17h9 M9 15v4',
  check: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M8.3 12.4l2.6 2.6 4.8-5.2',
  alerta: 'M12 3.8 2.6 20h18.8z M12 10v4.4 M12 17.2v.05',
  sinSenal: 'M3 3l18 18 M8.6 16.1a5 5 0 0 1 4.8-1.2 M5.2 12.6a10 10 0 0 1 3.4-2.2 M16.4 11a10 10 0 0 1 2.4 1.6 M1.9 9a15 15 0 0 1 3.8-2.6 M10.3 5.1A15 15 0 0 1 22.1 9 M12 19.6v.05',
  vacio: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M8.5 12h7',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 11v5.2 M12 7.8v.05',
  arriba: 'M12 19V5.5 M6.5 11 12 5.5l5.5 5.5',
  abajo: 'M12 5v13.5 M6.5 13 12 18.5l5.5-5.5',
  igual: 'M5 10h14 M5 14h14',
  sol: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M5.3 18.7l1.4-1.4 M17.3 6.7l1.4-1.4',
  luna: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  monitor: 'M3.5 4.5h17v11h-17z M8.5 19.5h7 M12 15.5v4',
  wifi: 'M1.9 9a15 15 0 0 1 20.2 0 M5.2 12.6a10 10 0 0 1 13.6 0 M8.6 16.1a5 5 0 0 1 6.8 0 M12 19.6v.05',
  sensor: 'M3 9h4v6H3z M17 9h4v6h-4z M7 12h2 M11 12h2 M15 12h2',
  cinta: 'M5 14a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z M19 14a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z M5 14h14 M5 19h14 M7 8h5v6H7z M13 9h4v5h-4z',
  reloj: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7.5V12l3 2',
  descarga: 'M12 4v11 M7.5 10.5 12 15l4.5-4.5 M5 20h14',
  salir: 'M14 4h5v16h-5 M10 8l-4 4 4 4 M6 12h10',
  campana: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0',
  mas: 'M5 12h.05 M12 12h.05 M19 12h.05',
}

export type NombreIcono = keyof typeof P

export function Icono({ nombre, tam = 20, titulo, trazo = 1.75 }: { nombre: NombreIcono; tam?: number; titulo?: string; trazo?: number }) {
  return (
    <svg
      width={tam} height={tam} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={trazo} strokeLinecap="round" strokeLinejoin="round"
      role={titulo ? 'img' : undefined} aria-hidden={titulo ? undefined : true} aria-label={titulo}
    >
      <path d={P[nombre]} />
    </svg>
  )
}
