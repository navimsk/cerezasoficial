# Cambios del firmware: v2 → v3 (envío con token propio)

En `contador_eg118.ino` cambia **solo la forma de enviar**. El algoritmo (`conteo.h`),
los pines, el JSON de cada evento y la cola sin conexión quedan iguales.

## 1. Configuración (arriba del archivo)

**Antes (v2):**
```cpp
const char* SUPABASE_URL  = "";                        // ej: "https://abcdefgh.supabase.co"
const char* SUPABASE_KEY  = "";                        // clave "anon" o "publishable"
```

**Después (v3):**
```cpp
const char* SUPABASE_URL  = "https://swqtfzxmlrludgkttspl.supabase.co";   // SIN /rest/v1/
const char* EQUIPO_TOKEN  = "el-token-que-entrega-scripts/token-equipo.mjs";
const char* SUPABASE_KEY  = "";   // dejar vacía: solo se usa en modo compatibilidad v2
```

## 2. `enviarLote()`: URL y cabeceras

**Antes:**
```cpp
String url = String(SUPABASE_URL) + "/rest/v1/eventos?on_conflict=equipo_id,seq";
...
http.addHeader("apikey", SUPABASE_KEY);
http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
http.addHeader("Prefer", "resolution=ignore-duplicates,missing=default,return=minimal");
```

**Después:**
```cpp
String url = String(SUPABASE_URL) + "/functions/v1/ingesta";
...
http.addHeader("Content-Type", "application/json");
http.addHeader("x-equipo-token", EQUIPO_TOKEN);
```

La función responde `200` con
`{"equipo":"linea-1","recibidos":25,"validos":25,"insertados":25,"duplicados":0,"rechazados":[]}`.
Cualquier `2xx` confirma el lote, igual que antes. Un `401` significa que el token está
malo y el firmware lo avisa por el monitor serie. Los eventos inválidos vienen en
`rechazados` y no se reintentan.

El archivo v3 completo ya trae los dos modos: si `EQUIPO_TOKEN` está vacío y
`SUPABASE_KEY` tiene la clave anon, sigue enviando como la v2.

## 3. Pasos para pasar el equipo a v3

1. Generar el token y su hash (en la raíz del proyecto):
   ```
   node scripts/token-equipo.mjs linea-1
   ```
   El script imprime el **token**, que se pega en `EQUIPO_TOKEN`, y una sentencia SQL con
   el **hash**, que se ejecuta en Supabase → SQL Editor. El token en claro nunca se
   guarda en la base.
2. Copiar `firmware/contador_eg118/` (el `.ino` y `conteo.h`), completar WiFi,
   `SUPABASE_URL` y `EQUIPO_TOKEN`, y cargarlo como siempre (Reload + Subir).
3. En el monitor serie debe aparecer
   `envío: función ingesta (token)`, `WiFi: conectado` y `caja n=+1`.
4. Cuando todos los equipos estén en v3, cerrar la puerta antigua en SQL Editor:
   ```sql
   update ajustes_sistema set valor = 'false' where clave = 'permitir_insert_anon';
   ```
