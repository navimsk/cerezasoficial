import { useEffect, useState } from 'react'
import { useDatos } from '../datos/contexto'
import { Icono, type NombreIcono } from '../componentes/Icono'
import { useTema, type Tema } from '../lib/hooks'
import { salirDeDemo, supabase, supabaseConfigurado } from '../lib/supabase'
import {
  activarPush, desactivarPush, enviarPrueba, estadoPush, guardarPreferencias, leerPreferencias, notificacionLocal,
  type EstadoPush, type Preferencias,
} from '../lib/push'

const TEMAS: Array<{ v: Tema; texto: string; icono: NombreIcono }> = [
  { v: 'sistema', texto: 'Automático', icono: 'monitor' },
  { v: 'claro', texto: 'Claro', icono: 'sol' },
  { v: 'oscuro', texto: 'Oscuro', icono: 'luna' },
]

const TEXTO_ESTADO: Record<EstadoPush, string> = {
  activo: 'Activadas en este dispositivo.',
  inactivo: 'Desactivadas en este dispositivo.',
  bloqueado: 'El navegador tiene bloqueadas las notificaciones de esta app. Actívalas en los permisos del sitio y vuelve aquí.',
  no_soportado: 'Este navegador no permite notificaciones push.',
  ios_instalar: 'En iPhone o iPad los avisos solo llegan con la app instalada: toca Compartir → "Agregar a inicio", abre la app desde el ícono y vuelve aquí.',
  sin_configurar: 'Falta configurar la clave VAPID del servidor (ver README).',
}

const AVISOS: Array<{ k: keyof Preferencias; titulo: string; detalle: string }> = [
  { k: 'atasco', titulo: 'Atasco', detalle: 'Cuando el haz queda cortado y el conteo se detiene, y si al cierre del turno el sensor sigue tapado.' },
  { k: 'sin_contacto', titulo: 'Equipo sin contacto', detalle: 'Cuando el contador lleva más de 2 minutos sin enviar datos.' },
  { k: 'ritmo', titulo: 'Caída de ritmo', detalle: 'Cuando el ritmo de 15 min baja a menos de la mitad de lo habitual a esa hora.' },
]

export function Ajustes() {
  const [tema, setTema] = useTema()
  const { fuente, equipos, equipo, setEquipoId, perfil, sesion } = useDatos()

  return (
    <div className="pantalla">
      <h1 className="titulo-pantalla">Ajustes</h1>

      <section className="ajustes-bloque" aria-labelledby="aj-tema">
        <h2 id="aj-tema" className="rotulo">Tema</h2>
        <div className="segmentado" role="group" aria-label="Tema">
          {TEMAS.map(t => (
            <button key={t.v} type="button" aria-pressed={tema === t.v} onClick={() => setTema(t.v)}>
              <span className="fila-icono"><Icono nombre={t.icono} tam={18} />{t.texto}</span>
            </button>
          ))}
        </div>
        <p className="nota nota--tenue">Automático sigue la configuración del celular o computador.</p>
      </section>

      {equipos.length > 1 && (
        <section className="ajustes-bloque" aria-labelledby="aj-equipo">
          <h2 id="aj-equipo" className="rotulo">Equipo que se muestra</h2>
          <label className="campo">
            <span className="solo-lector">Equipo</span>
            <select value={equipo?.id} onChange={e => setEquipoId(e.target.value)}>
              {equipos.map(q => <option key={q.id} value={q.id}>{q.nombre}</option>)}
            </select>
          </label>
        </section>
      )}

      <section className="ajustes-bloque" aria-labelledby="aj-notif">
        <h2 id="aj-notif" className="rotulo">Notificaciones</h2>
        {fuente.modo === 'demo' ? <NotificacionesDemo /> : <Notificaciones />}
      </section>

      <section className="ajustes-bloque" aria-labelledby="aj-cuenta">
        <h2 id="aj-cuenta" className="rotulo">Cuenta y datos</h2>
        {fuente.modo === 'demo' ? (
          <>
            <p className="nota">Modo demo: datos simulados de varias semanas, generados en este dispositivo.</p>
            {supabaseConfigurado && <button type="button" className="boton" onClick={salirDeDemo}><Icono nombre="salir" tam={18} />Salir de la demo e iniciar sesión</button>}
          </>
        ) : (
          <>
            <p className="nota"><b>{perfil?.email ?? sesion?.user.email}</b> · {perfil?.rol === 'admin' ? 'Administración' : 'Jefatura'}</p>
            <button type="button" className="boton" onClick={() => supabase().auth.signOut()}><Icono nombre="salir" tam={18} />Cerrar sesión</button>
          </>
        )}
      </section>
    </div>
  )
}

function NotificacionesDemo() {
  const [msj, setMsj] = useState<string | null>(null)
  return (
    <>
      <div className="aviso"><Icono nombre="campana" tam={18} /><span>En la versión con Supabase llegan avisos de atasco, equipo sin contacto y caída de ritmo, aunque la app esté cerrada. En la demo puedes ver cómo se ve uno.</span></div>
      <button type="button" className="boton" onClick={() => notificacionLocal().then(() => setMsj('Aviso de ejemplo enviado.'), e => setMsj(e.message))}>
        <Icono nombre="campana" tam={18} />Mostrar un aviso de ejemplo
      </button>
      {msj && <p className="nota" role="status">{msj}</p>}
    </>
  )
}

function Notificaciones() {
  const [estado, setEstado] = useState<EstadoPush | null>(null)
  const [pref, setPref] = useState<Preferencias | null>(null)
  const [msj, setMsj] = useState<{ error: boolean; texto: string } | null>(null)
  const [ocupado, setOcupado] = useState(false)

  useEffect(() => {
    estadoPush().then(setEstado)
    leerPreferencias().then(setPref).catch(() => setPref({ atasco: true, sin_contacto: true, ritmo: true }))
  }, [])

  const accion = async (f: () => Promise<unknown>, ok: string) => {
    setOcupado(true); setMsj(null)
    try { await f(); setMsj({ error: false, texto: ok }) } catch (e) { setMsj({ error: true, texto: e instanceof Error ? e.message : String(e) }) }
    setEstado(await estadoPush()); setOcupado(false)
  }

  const cambiar = async (k: keyof Preferencias, v: boolean) => {
    if (!pref) return
    const nuevo = { ...pref, [k]: v }
    setPref(nuevo)
    try { await guardarPreferencias(nuevo) } catch (e) { setPref(pref); setMsj({ error: true, texto: e instanceof Error ? e.message : String(e) }) }
  }

  return (
    <>
      {estado && (
        <p className={`aviso${estado === 'bloqueado' ? ' aviso--error' : ''}`}>
          <Icono nombre={estado === 'activo' ? 'check' : estado === 'bloqueado' ? 'alerta' : 'campana'} tam={18} />
          <span>{TEXTO_ESTADO[estado]}</span>
        </p>
      )}
      <div className="fila-botones">
        {estado === 'inactivo' && <button type="button" className="boton boton--primario" disabled={ocupado} onClick={() => accion(activarPush, 'Listo: este dispositivo recibirá avisos.')}><Icono nombre="campana" tam={18} />Activar en este dispositivo</button>}
        {estado === 'activo' && <>
          <button type="button" className="boton" disabled={ocupado} onClick={() => accion(async () => { const n = await enviarPrueba(); if (!n) throw new Error('No se envió a ningún dispositivo. Desactiva y vuelve a activar.') }, 'Aviso de prueba enviado. Debería llegar en unos segundos.')}>Enviar aviso de prueba</button>
          <button type="button" className="boton" disabled={ocupado} onClick={() => accion(desactivarPush, 'Este dispositivo ya no recibirá avisos.')}>Desactivar en este dispositivo</button>
        </>}
      </div>
      {msj && <p className={`nota${msj.error ? ' texto-error' : ''}`} role={msj.error ? 'alert' : 'status'}>{msj.texto}</p>}

      <fieldset className="avisos" disabled={!pref}>
        <legend className="nota nota--tenue">Qué avisos quieres recibir (en todos tus dispositivos):</legend>
        {AVISOS.map(a => (
          <label key={a.k} className="interruptor">
            <input type="checkbox" role="switch" checked={pref?.[a.k] ?? true} onChange={e => cambiar(a.k, e.target.checked)} />
            <span className="interruptor__pista" aria-hidden />
            <span className="interruptor__texto"><b>{a.titulo}</b><span className="nota nota--tenue">{a.detalle}</span></span>
          </label>
        ))}
      </fieldset>
    </>
  )
}
