# Contador de cajas · Packing de cerezas

Sistema para contar automáticamente las cajas que pasan por la cinta y mostrárselas a las
jefaturas en una app instalable (celular y PC).

```
ESP32 USR-EG118 + sensor  ──►  Supabase (Edge Function "ingesta" → Postgres)  ──►  App PWA (React)
     firmware/                      supabase/                                     web/
```

| Carpeta | Contenido |
|---|---|
| `web/` | App PWA: Vite + React + TypeScript, Apache ECharts, exceljs |
| `supabase/migrations/` | Todo el SQL, en migraciones versionadas (Supabase CLI) |
| `supabase/functions/` | Edge Functions `ingesta` (recibe del equipo) y `vigilar` (avisos push) |
| `supabase/pruebas/` | Pruebas de las migraciones en un Postgres real (PGlite, sin Docker) |
| `firmware/` | `contador_eg118.ino` v3 y `conteo.h`. Ver `firmware/CAMBIOS_FIRMWARE.md` |
| `scripts/` | Token de equipo y carga de datos de prueba |
| `DESIGN.md` | Dirección visual: paleta, tipografía, componentes, gráficos |

**Regla de oro:** el conteo de cajas es la **suma de la columna `n`** de `eventos`.

---

## 1. Probar la app en tu PC (modo demo, sin Supabase)

Requisitos: Node.js 20 o superior.

```bash
cd web
npm install
npm run dev          # abre http://localhost:5173
```

Sin variables de Supabase, la app arranca en **modo demo**: simula unas 6 semanas de turnos,
con colación, paradas, atascos y cajas pegadas, y cajas llegando en vivo. También se puede
entrar a la demo desde la pantalla de login ("Ver demostración") o con `?demo=1`; se sale
con `?demo=0`.

Pruebas:

```bash
cd web && npm test                         # proyecciones y hora de Chile
cd supabase/pruebas && npm install && npm test   # migraciones, seguridad, agregados, RPC, avisos
```

---

## 2. Configurar Supabase

> Nunca pongas la clave **service_role / secret** en la app, en el firmware ni en este
> repositorio. Las Edge Functions la reciben solas desde Supabase.

### 2.1 Vincular el proyecto y aplicar las migraciones

No hace falta Docker: los comandos trabajan directo contra el proyecto en la nube.

```bash
npx supabase login
npx supabase link --project-ref swqtfzxmlrludgkttspl
npx supabase db push          # aplica supabase/migrations/* en orden
```

Las migraciones **no borran datos**. La `0001` es el esquema que ya existe (idempotente) y
las demás agregan lo nuevo:

| Migración | Qué hace |
|---|---|
| 0001 esquema_base | tablas `equipos` y `eventos` (igual que antes) |
| 0002 seguridad | lista blanca `usuarios_autorizados`, RLS: **anon ya no lee nada**; inserción anon solo por compatibilidad |
| 0003 ingesta | `equipos.token_hash` y la función `ingestar_eventos` (solo la usa la Edge Function) |
| 0004 agregados | `agg_minuto`, `agg_hora`, `agg_dia` por trigger, con carga inicial de lo existente |
| 0005 rpc_app | `resumen_vivo`, `serie`, `salud_equipos`, `atascos_rango`, `datos_proyeccion`, `primer_dato` |
| 0006 push | suscripciones, preferencias, cálculo de avisos y `pg_cron` cada minuto |

Si alguna vez se borran eventos a mano, se recalculan los agregados con
`select recalcular_agregados();` en el SQL Editor.

### 2.2 Autorizar usuarios (lista blanca)

1. En Supabase → **Authentication → Users → Add user**, crea a la persona con correo y
   contraseña. Otra opción es que entre con "Enlace al correo".
2. En **SQL Editor**:
   ```sql
   insert into usuarios_autorizados (email, rol, nombre)
   values ('jefa.turno@empresa.cl', 'jefatura', 'Nombre Apellido');
   -- rol 'admin' puede además agregar usuarios y cambiar ajustes:
   -- insert into usuarios_autorizados (email, rol) values ('admin@empresa.cl', 'admin');
   ```
3. Para quitar el acceso: `update usuarios_autorizados set activo = false where email = '...';`

Quien inicie sesión sin estar en la lista ve el mensaje "no está en la lista de usuarios
autorizados" y no puede ver ningún dato.

En **Authentication → URL Configuration**, agrega la URL de Netlify (paso 4) en *Site URL*
y en *Redirect URLs* para que funcione el enlace al correo.

### 2.3 Desplegar las Edge Functions

```bash
npx supabase functions deploy ingesta
npx supabase functions deploy vigilar
```

`supabase/config.toml` ya las deja con `verify_jwt = false`: `ingesta` se valida con el
token del equipo y `vigilar` con un secreto propio o con el JWT del usuario.

### 2.4 Token del equipo y firmware v3

```bash
node scripts/token-equipo.mjs linea-1
```

El script entrega el token, que va en `EQUIPO_TOKEN` del `.ino`, y el SQL que guarda solo su
hash. Los pasos para cargar el firmware están en **`firmware/CAMBIOS_FIRMWARE.md`**. Mientras
el equipo siga con la v2, la inserción con clave anon sigue funcionando. Cuando todos estén
en v3:

```sql
update ajustes_sistema set valor = 'false' where clave = 'permitir_insert_anon';
```

### 2.5 Notificaciones push

1. Genera las claves VAPID (una sola vez):
   ```bash
   npx web-push generate-vapid-keys
   ```
2. Inventa un secreto para el cron (cualquier texto largo y aleatorio) y carga los secretos
   de las funciones:
   ```bash
   npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:avisos@empresa.cl CRON_SECRET=...
   ```
3. En **SQL Editor**, guarda en Vault lo que necesita `pg_cron` para llamar a la función:
   ```sql
   select vault.create_secret('https://swqtfzxmlrludgkttspl.supabase.co/functions/v1', 'url_funciones');
   select vault.create_secret('EL_MISMO_CRON_SECRET', 'cron_secret');
   ```
4. Verifica en **Database → Extensions** que `pg_cron` y `pg_net` estén activas. La migración
   0006 las activa si están disponibles y programa el job `vigilar-contador` cada minuto.
5. Pon `VITE_VAPID_PUBLIC_KEY` en la app (paso 3). Cada jefatura activa los avisos en
   **Ajustes → Notificaciones** y puede mandarse una prueba.

Avisos que llegan:
- **Atasco:** al instante.
- **Equipo sin contacto por más de 2 min:** un aviso por cada corte. Si el equipo se apaga al
  terminar el turno, también llega uno.
- **Caída de ritmo:** los últimos 15 min van a menos de la mitad de lo habitual a esa hora.
  Se usan los 14 días anteriores y se manda como máximo un aviso cada 30 min.

---

## 3. Configurar la app

Copia `web/.env.example` como `web/.env` y completa:

```
VITE_SUPABASE_URL=https://swqtfzxmlrludgkttspl.supabase.co      # SIN /rest/v1/
VITE_SUPABASE_ANON_KEY=<clave anon o publishable>
VITE_VAPID_PUBLIC_KEY=<clave pública VAPID>
VITE_MODO_DATOS=auto
```

### Datos de prueba en Supabase (opcional)

Para ver la app llena con datos que pasan por el camino real (función `ingesta`), crea un
equipo de prueba y cárgale 4 semanas:

```bash
node scripts/token-equipo.mjs prueba-1        # ejecuta el SQL que imprime
node scripts/cargar-datos-prueba.mjs --url https://swqtfzxmlrludgkttspl.supabase.co --token <TOKEN> --equipo prueba-1 --dias 28
```

Después, en Ajustes, elige "prueba-1". Para borrarlo:
`delete from eventos where equipo_id = 'prueba-1'; select recalcular_agregados();`

---

## 4. Desplegar en Netlify

El repositorio ya trae `netlify.toml`, que compila `web/` y publica `web/dist`.

1. Sube el proyecto a GitHub (el `.gitignore` deja fuera `.env`).
2. En Netlify: **Add new site → Import from Git** → elige el repositorio.
3. En **Site configuration → Environment variables**, agrega las mismas `VITE_…` del paso 3.
4. **Deploy**. Copia la URL (`https://<algo>.netlify.app`) en Supabase → Authentication →
   URL Configuration (paso 2.2).

La app es una PWA: el service worker guarda la app para abrirla con mala señal y muestra el
último dato con su antigüedad ("Sin internet · dato hace 6 min").

---

## 5. Instalar la app en el celular

- **Android (Chrome):** abre la URL → menú ⋮ → **Instalar app** (o "Agregar a la pantalla
  principal").
- **iPhone/iPad (Safari):** abre la URL → botón **Compartir** → **Agregar a inicio**. En iOS
  las notificaciones solo funcionan con la app instalada (iOS 16.4 o superior): ábrela desde
  el ícono y actívalas en Ajustes.
- **PC (Chrome/Edge):** ícono de instalar en la barra de direcciones.

---

## 6. Migrar a la base de datos local de la empresa

1. En la app: **Exportar → SQL (.sql)** con el rango completo (por ejemplo desde el inicio de
   la temporada).
2. El archivo trae un esquema mínimo compatible con PostgreSQL 12 o superior (`equipos` y
   `eventos`) y los `INSERT … ON CONFLICT DO NOTHING`. Se puede ejecutar más de una vez y no
   duplica.
   ```bash
   psql -h servidor -U usuario -d basedatos -f cajas_linea-1_2026-11-01_a_2026-11-30.sql
   ```
3. Para replicar todo (agregados, funciones, seguridad) en un Postgres propio, las
   migraciones de `supabase/migrations/` sirven casi tal cual. Lo único propio de Supabase es
   `auth.*` (usuarios), `supabase_realtime`, `pg_net`/Vault (avisos) y los roles
   `anon`/`authenticated`/`service_role`. `supabase/pruebas/probar_migraciones.mjs` muestra
   los mínimos que hay que simular.
4. Consulta base: cajas por día en hora de Chile:
   ```sql
   select (ts at time zone 'America/Santiago')::date as dia, sum(n) as cajas
   from eventos where equipo_id = 'linea-1' group by 1 order by 1;
   ```

---

## 7. Cómo se calculan las proyecciones

La lógica está en `web/src/proyecciones/index.ts` y tiene pruebas en `proyecciones.test.ts`.
Cada gráfico de la app explica su método en "Cómo se calcula".

- **Cierre de hoy:** cada día con turno de las últimas 4 semanas aporta un escenario. Se toma
  lo que ese día produjo desde la hora actual hasta su cierre, se escala por cómo va hoy
  frente a ese día (mitad por el acumulado y mitad por la última hora) y se suma a lo que
  llevas. El estimado es la mediana de los escenarios y el rango, los percentiles 10 a 90.
  Necesita al menos 5 días con turno.
- **Próximos 7 días:** para cada día de la semana, un promedio exponencial (α = 0,4) de ese
  mismo día en semanas anteriores. El rango es ±1,28 veces el error típico del método para
  ese día. Necesita al menos 14 días.
- **Acumulado de temporada:** se proyecta el promedio diario de los últimos 14 días
  (incluidos los días sin turno), con un rango que crece con la raíz del horizonte. Necesita
  al menos 7 días.

No hay metas de producción: todo se compara con el propio historial.
