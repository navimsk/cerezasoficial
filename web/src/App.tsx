import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Shell } from './componentes/Shell'
import { ProveedorDatos } from './datos/contexto'
import { Ajustes } from './pantallas/Ajustes'
import { Pendiente } from './pantallas/Pendiente'
import { EnVivo } from './pantallas/EnVivo'
import { Historial } from './pantallas/Historial'
import { Equipos } from './pantallas/Equipos'
import { Proyecciones } from './pantallas/Proyecciones'
import { Exportar } from './pantallas/Exportar'

export default function App() {
  return (
    <ProveedorDatos>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<EnVivo />} />
            <Route path="historial" element={<Historial />} />
            <Route path="proyecciones" element={<Proyecciones />} />
            <Route path="exportar" element={<Exportar />} />
            <Route path="equipos" element={<Equipos />} />
            <Route path="ajustes" element={<Ajustes />} />
            <Route path="*" element={<Pendiente titulo="Página no encontrada" fase={0} descripcion="Esta dirección no existe." />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ProveedorDatos>
  )
}
