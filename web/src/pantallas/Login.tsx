import { useState, type FormEvent } from 'react'
import { Icono } from '../componentes/Icono'
import { entrarADemo, supabase } from '../lib/supabase'

function Marco({ children }: { children: React.ReactNode }) {
  return (
    <main className="acceso">
      <div className="acceso__caja">
        <div className="acceso__marca">
          <img src="/favicon.svg" width={40} height={40} alt="" />
          <div>
            <p className="titulo-seccion">Contador de cajas</p>
            <p className="rotulo">Packing · Acceso jefaturas</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  )
}

export function Cargando() {
  return <Marco><p className="nota" role="status">Verificando acceso…</p></Marco>
}

export function Login() {
  const [modo, setModo] = useState<'clave' | 'enlace'>('clave')
  const [email, setEmail] = useState('')
  const [clave, setClave] = useState('')
  const [estado, setEstado] = useState<{ tipo: 'error' | 'ok'; texto: string } | null>(null)
  const [enviando, setEnviando] = useState(false)

  async function entrar(ev: FormEvent) {
    ev.preventDefault()
    setEnviando(true); setEstado(null)
    const sb = supabase()
    if (modo === 'clave') {
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: clave })
      if (error) setEstado({ tipo: 'error', texto: error.message === 'Invalid login credentials' ? 'Correo o contraseña incorrectos.' : error.message })
    } else {
      const { error } = await sb.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: location.origin, shouldCreateUser: true } })
      setEstado(error ? { tipo: 'error', texto: error.message } : { tipo: 'ok', texto: `Te enviamos un enlace a ${email.trim()}. Ábrelo en este dispositivo.` })
    }
    setEnviando(false)
  }

  return (
    <Marco>
      <div className="segmentado" role="group" aria-label="Forma de entrar">
        <button type="button" aria-pressed={modo === 'clave'} onClick={() => setModo('clave')}>Con contraseña</button>
        <button type="button" aria-pressed={modo === 'enlace'} onClick={() => setModo('enlace')}>Enlace al correo</button>
      </div>
      <form className="acceso__form" onSubmit={entrar}>
        <label className="campo">
          <span className="rotulo">Correo</span>
          <input type="email" autoComplete="email" inputMode="email" required value={email} onChange={e => setEmail(e.target.value)} />
        </label>
        {modo === 'clave' && (
          <label className="campo">
            <span className="rotulo">Contraseña</span>
            <input type="password" autoComplete="current-password" required value={clave} onChange={e => setClave(e.target.value)} />
          </label>
        )}
        <button className="boton boton--primario" type="submit" disabled={enviando}>
          {enviando ? 'Entrando…' : modo === 'clave' ? 'Entrar' : 'Enviar enlace'}
        </button>
        {estado && (
          <p className={`aviso ${estado.tipo === 'error' ? 'aviso--error' : ''}`} role={estado.tipo === 'error' ? 'alert' : 'status'}>
            <Icono nombre={estado.tipo === 'error' ? 'alerta' : 'check'} tam={18} />
            <span>{estado.texto}</span>
          </p>
        )}
      </form>
      <p className="nota nota--tenue">
        Solo entran correos autorizados por la administración del packing.
      </p>
      <button type="button" className="enlace" onClick={entrarADemo}>Ver demostración con datos simulados</button>
    </Marco>
  )
}

export function NoAutorizado({ email }: { email: string }) {
  return (
    <Marco>
      <div className="aviso" role="alert">
        <Icono nombre="alerta" tam={18} />
        <span><strong>{email}</strong> inició sesión, pero no está en la lista de usuarios autorizados. Pide a un administrador que te agregue.</span>
      </div>
      <button className="boton" type="button" onClick={() => supabase().auth.signOut()}>
        <Icono nombre="salir" tam={18} />Cerrar sesión
      </button>
    </Marco>
  )
}
