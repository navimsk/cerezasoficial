import { Icono } from '../componentes/Icono'

/** Marcador de pantalla que se construye en una fase posterior. */
export function Pendiente({ titulo, fase, descripcion }: { titulo: string; fase: number; descripcion: string }) {
  return (
    <>
      <h1 className="titulo-pantalla">{titulo}</h1>
      <div className="aviso">
        <Icono nombre="info" tam={18} />
        <span>{descripcion} Se construye en la fase {fase}.</span>
      </div>
    </>
  )
}
