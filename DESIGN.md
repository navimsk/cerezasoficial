# DESIGN.md — Contador de cajas · Sala de control

Documento de diseño de la app para jefaturas del packing. Todo lo visual del proyecto
sale de aquí. Si algo no está definido, se resuelve con estos principios y se agrega a
este documento.

---

## 1. Dirección

**Un instrumento de sala de control de una planta agroindustrial.** No es un
"dashboard": es un tablero que se lee de pie, a dos metros, con sol o en la sala de
máquinas de noche.

- **Sobrio y preciso:** papel cálido de día y grafito de noche. Líneas finas que
  ordenan como en un panel eléctrico rotulado: rótulos cortos en mayúsculas y cifras
  grandes.
- **Los números mandan:** cada pantalla tiene **una** cifra principal. Lo demás es
  contexto y se ve más chico y más gris.
- **El rojo cereza es una señal, no decoración:** marca lo que está vivo (el punto de
  "en vivo", la serie de hoy, la caja que acaba de sumar) y lo que importa. Si una
  pantalla tiene mucho cereza, está mal.
- **El estado nunca va solo en color:** siempre va ícono + texto + color.

Pregunta de control para cada pantalla: *¿una jefatura sabe en 2 segundos cuántas
cajas van hoy y a qué ritmo?*

---

## 2. Color

Los tokens viven en `web/src/estilos/tokens.css`. El modo oscuro es una paleta elegida
aparte, no una inversión automática. El tema se puede forzar con
`<html data-theme="light|dark">` y, si no se fuerza, sigue al sistema.

### Superficies y tinta

| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--fondo` | `#f3f1ec` | `#0f0e0d` | plano de la página |
| `--superficie` | `#fbfaf7` | `#191816` | paneles y gráficos |
| `--superficie-2` | `#ece9e3` | `#23211e` | hover, campos, fila activa |
| `--tinta` | `#1a1714` (17:1) | `#eeebe5` (15:1) | cifras y texto principal |
| `--tinta-2` | `#55504a` (7,6:1) | `#bdb7ae` (8,9:1) | texto secundario |
| `--tinta-3` | `#6b655e` (≥ 4,75:1 en todas las superficies claras) | `#8f8981` (5,1:1) | rótulos, ejes, notas |
| `--linea` | `#dcd8d0` | `#2e2c28` | filetes (1 px) y grilla |
| `--linea-fuerte` | `#bdb8ae` | `#45423c` | eje base, divisores mayores |

### Acento: cereza

| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--cereza` | `#9e1b34` | `#e5566c` | marca de la serie "hoy / vivo" y punto en vivo |
| `--cereza-texto` | `#9e1b34` (7,6:1) | `#ef6b7f` (6,0:1) | texto en acento (poco) |
| `--cereza-lavado` | cereza al 10 % | cereza al 14 % | área bajo la línea, banda de proyección |

### Serie de contexto: acero

Va en la serie con la que se compara: ayer, el periodo B o el histórico.

| Token | Claro | Oscuro |
|---|---|---|
| `--acero` | `#2b6a9e` | `#5a9bd3` |
| `--gris-serie` | `#a39e95` | `#5e5a54` |

El par cereza/acero pasó el validador de dataviz (`validate_palette.js`) en los dos
modos: CVD ΔE 16,6 en claro y 16,2 en oscuro; visión normal 25,1 y 25,9; contraste
≥ 3:1. Cuando la comparación es solo contexto, se usa `--gris-serie` y no acero
(forma "énfasis").

### Secuencial (mapa de calor): acero, un solo tono

`--seq-0 … --seq-6`, de casi el color de la superficie hasta acero profundo. El cero
real se pinta igual que la superficie, con la celda vacía.

- Claro: `#eef1f4 #cfdbe6 #a7c0d6 #7aa1c2 #4f80ab #2b6a9e #1b4a73`
- Oscuro: `#1d2126 #1f3448 #23496b #2a6190 #3b7db3 #5a9bd3 #93c0e6`

### Estados (reservados: nunca se usan como serie)

| Estado | Ícono | Claro | Oscuro |
|---|---|---|---|
| **Operando** | círculo con check | `#1d7a3a` | `#4cc06b` |
| **Atasco** | triángulo con ! | `#9a5b00` | `#f0a83c` |
| **Sin conexión** | antena tachada | `#b3381f` | `#f07a5f` |
| **Detenido / sin datos** | círculo vacío | `--tinta-3` | `--tinta-3` |

Todos cumplen ≥ 4,5:1 como texto sobre `--superficie`. "Sin conexión" es bermellón,
no cereza: el cereza nunca significa error.

---

## 3. Tipografía

Hay una sola familia, **Barlow** (Jeremy Tran, OFL), en dos anchos. Su origen está en
la rotulación de carreteras y señalética: se lee de lejos y suena industrial sin
volverse fría. Se autoaloja con `@fontsource` y así funciona sin conexión.

| Rol | Familia | Peso | Notas |
|---|---|---|---|
| Cifra principal | Barlow Semi Condensed | 600 | `tabular-nums`, interletrado −0,02em |
| Cifras secundarias | Barlow Semi Condensed | 600 | `tabular-nums` |
| Rótulos (instrumento) | Barlow Semi Condensed | 600 | MAYÚSCULAS, +0,08em, `--tinta-3` |
| Títulos de pantalla | Barlow Semi Condensed | 600 | |
| Texto, botones, tablas | Barlow | 400 / 500 | tablas con `tabular-nums` |

**Numerales tabulares en todas las cifras que cambian en vivo** (decisión del
proyecto): así el contador no "baila" al sumar. Esto se aparta a propósito de la regla
general de dataviz, que reserva los tabulares para columnas.

### Escala (px)

| Token | Móvil | ≥ 900 px | Uso |
|---|---|---|---|
| `--t-hero` | `clamp(88px, 26vw, 132px)` | hasta 176 | **una** por pantalla |
| `--t-xl` | 40 | 48 | cifras de apoyo (ritmo) |
| `--t-l` | 28 | 32 | cifras de fila |
| `--t-m` | 20 | 20 | títulos de sección |
| `--t-base` | 16 | 16 | texto |
| `--t-s` | 14 | 14 | tablas, notas |
| `--t-xs` | 12 | 12 | rótulos en mayúsculas, ejes |

Interlineado de 1,5 para texto y de 0,9 a 1 para cifras grandes.

---

## 4. Espacio, forma y profundidad

- **Escala de espacio:** 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 (`--e-1` … `--e-8`).
- **Margen lateral:** 16 px en el celular y 32 px desde 900 px. El ancho máximo del
  contenido es 1440 px.
- **Radios:** 2 px en controles y 4 px en paneles. Nada de radios grandes ni de
  píldoras infladas; las únicas píldoras son los estados, de 999 px.
- **Profundidad:** casi plana. Los paneles se separan con **filetes de 1 px** (`--linea`)
  y no con sombras. La única sombra (`0 1px 2px` al 8 %) es para menús flotantes.
- **Composición:** asimétrica y con jerarquía. La cifra principal ocupa el ancho; las
  métricas de apoyo van en una **fila rotulada**, separadas por filetes verticales,
  como los medidores de un tablero. **No** se usan grillas de tarjetas iguales.

---

## 5. Componentes

| Componente | Descripción |
|---|---|
| `Rotulo` | Etiqueta de instrumento en mayúsculas pequeñas, en `--tinta-3`. Va arriba de toda cifra. |
| `Cifra` | Número con `tabular-nums`. Al subir, anima los dígitos 180 ms con un desplazamiento vertical corto. Sin `prefers-reduced-motion` cambia sin animación. |
| `Medidor` | Rótulo + cifra + nota (delta o unidad). Es la unidad de la "fila rotulada". |
| `Delta` | Diferencia con signo ("+124 vs ayer a esta hora"). Va en color de tinta, con flecha ▲▼ en SVG; el color nunca carga el sentido solo. |
| `IndicadorVivo` | Punto cereza (pulso lento de 2 s, que se apaga con reduced-motion) + "EN VIVO" + antigüedad ("hace 4 s"). Pasa a gris con "SIN SEÑAL · último dato hace 6 min" cuando se cae. |
| `EstadoChip` | Ícono + texto + color de estado. Siempre los tres. |
| `Panel` | Bloque con rótulo de cabecera y filete superior. Sin sombra; fondo `--superficie`. |
| `Segmentado` | Selector de rango o paso: botones contiguos con filete, el activo en `--tinta` sobre `--superficie`. |
| `Tabla` | Filas de 44 px, cifras alineadas a la derecha con tabulares, cabecera fija. |
| `Aviso` | Mensaje explicativo, como "Se necesitan al menos 7 días de datos". Ícono i + texto, sin color de estado. |
| Navegación | **Celular:** barra inferior de 5 destinos con ícono + texto, de 56 px más el área segura. **≥ 900 px:** riel lateral izquierdo de 220 px. |

Todo lo tocable mide al menos **44 × 44 px**, con foco visible de 2 px en `--tinta` y
desplazamiento de 2 px.

---

## 6. Gráficos (según la skill dataviz)

- **Librería:** Apache ECharts, con el tema construido desde los tokens (`web/src/graficos/tema.ts`).
- **Líneas:** 2 px. **Barras:** de 24 px como máximo, con extremo redondeado de 4 px y
  base recta. **Áreas:** lavado al 10 %.
- **Grilla y ejes:** filete de 1 px **sólido** en `--linea`; nunca punteado. Los ejes
  usan texto `--t-xs` en `--tinta-3`.
- **Línea punteada solo para lo proyectado,** para que lo futuro se lea distinto de
  lo medido. La banda de confianza va en `--cereza-lavado`.
- **Hoy frente a contexto:** hoy en cereza y el contexto en `--gris-serie` (énfasis).
  Para dos periodos que importan por igual: A en cereza, B en acero, con leyenda y
  etiquetas directas.
- **Interacción:** cada gráfico tiene tooltip (cruz en líneas y por elemento en barras)
  y su **vista de tabla** equivalente.
- **Ejes:** nunca dos ejes Y. Las cifras de los ejes van redondeadas.
- **Recarga:** el render anterior se mantiene atenuado mientras carga; no hay
  "esqueletos" que salten.

---

## 7. Movimiento

- Solo tres animaciones: **la cifra que suma** (180 ms), **el pulso del punto en vivo**
  (2 s, opacidad) y **la fila nueva del feed**, que aparece con un fundido de 200 ms.
- Las transiciones de hover y foco duran 120 ms.
- Con `prefers-reduced-motion: reduce` todo lo anterior queda en 0.

---

## 8. Iconografía

Son SVG en línea propios (`web/src/componentes/Icono.tsx`): trazo de 1,75 px, 24 × 24,
extremos redondeados, en `currentColor`. **No se usan emojis.** El set incluye
en vivo, historial, proyección, exportar, equipo, ajustes, check, alerta, sin señal,
cinta, sensor, wifi, flechas y descarga.

---

## 9. Tono del texto

- Es español de Chile, neutro y operativo. Las frases son cortas y las palabras, las de
  la planta: **cajas, línea, cinta, atasco, turno, equipo**.
- Las unidades van siempre explícitas: "cajas/min" y "hace 3 min".
- Las cifras usan punto de miles y coma decimal (`es-CL`): 12.480 cajas; 18,4 cajas/min.
- Las fechas van como "lun 17 nov" y las horas en 24 h: 14:05.
- Ninguna frase de marketing. Ningún "¡Bienvenido de vuelta!". Los mensajes vacíos
  dicen qué pasa y qué hacer: "Sin datos en este rango. El equipo envía datos al
  encenderse."

---

## 10. Prohibido

Degradados morados o azules · glassmorphism y desenfoques · emojis como íconos ·
sombras grandes · grillas de tarjetas idénticas · "Bienvenido de vuelta" ·
ilustraciones genéricas · frases de marketing · metas de producción inventadas · color
como único portador de un estado · dos ejes Y · animaciones de relleno.
