import { NavLink, Outlet } from 'react-router-dom'
import { useDatos } from '../datos/contexto'
import { useAhora, useEnLinea } from '../lib/hooks'
import { hace } from '../lib/formato'
import { IndicadorVivo } from './Estado'
import { Icono, type NombreIcono } from './Icono'

const DESTINOS: Array<{ a: string; texto: string; icono: NombreIcono; movil: boolean }> = [
  { a: '/', texto: 'En vivo', icono: 'vivo', movil: true },
  { a: '/historial', texto: 'Historial', icono: 'historial', movil: true },
  { a: '/proyecciones', texto: 'Proyección', icono: 'proyeccion', movil: true },
  { a: '/exportar', texto: 'Exportar', icono: 'exportar', movil: true },
  { a: '/equipos', texto: 'Equipos', icono: 'equipo', movil: true },
  { a: '/ajustes', texto: 'Ajustes', icono: 'ajustes', movil: false },
]

export function Shell() {
  const { equipo, fuente, ultimoContacto } = useDatos()
  const ahora = useAhora(1000)
  const enLinea = useEnLinea()

  return (
    <div className="app">
      <nav className="riel" aria-label="Secciones">
        <div className="riel__marca">
          <img src="/favicon.svg" width={28} height={28} alt="" />
          Contador de cajas
        </div>
        {DESTINOS.map(d => (
          <NavLink key={d.a} to={d.a} end={d.a === '/'} className={d.a === '/ajustes' ? 'riel__pie' : undefined}>
            <Icono nombre={d.icono} />{d.texto}
          </NavLink>
        ))}
      </nav>

      <div className="cabecera">
        <header className="barra-sup">
          <span className="barra-sup__linea">{equipo?.nombre ?? 'Línea'}</span>
          {fuente.modo === 'demo' && <span className="marca-demo" title="Datos simulados">DEMO</span>}
          <span className="barra-sup__espacio" />
          <IndicadorVivo ultimo={ultimoContacto} ahora={ahora} conectado={enLinea} />
          <NavLink to="/ajustes" className="boton boton--icono ajustes-movil" aria-label="Ajustes">
            <Icono nombre="ajustes" />
          </NavLink>
        </header>
        {!enLinea && (
          <div className="banda banda--sin-conexion" role="status">
            <Icono nombre="sinSenal" tam={16} />
            Sin internet. Se muestra el último dato recibido{ultimoContacto ? ` (${hace(ultimoContacto, ahora)})` : ''}.
          </div>
        )}
      </div>

      <main className="contenido" id="contenido">
        <Outlet />
      </main>

      <nav className="nav-inf" aria-label="Secciones">
        {DESTINOS.filter(d => d.movil).map(d => (
          <NavLink key={d.a} to={d.a} end={d.a === '/'}>
            <Icono nombre={d.icono} tam={22} />{d.texto}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
