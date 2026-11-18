// Credenciales del equipo. Este archivo NO se sube a GitHub (está en .gitignore).
// Para un equipo nuevo: copia secretos.example.h como secretos.h y complétalo.
#pragma once

#define CFG_WIFI_SSID    "NOMBRE_DE_LA_RED"      // 2,4 GHz, nombre exacto (mayúsculas, tildes, espacios)
#define CFG_WIFI_PASS    "CLAVE_DE_LA_RED"
#define CFG_EQUIPO_ID    "linea-1"      // debe existir en la tabla equipos

// Supabase: SOLO la base del proyecto, SIN "/rest/v1/" ni "/functions/v1/". Vacío = solo monitor serie.
#define CFG_SUPABASE_URL "https://TU_REF.supabase.co"

// Token propio del equipo (node scripts/token-equipo.mjs linea-1). Es secreto.
#define CFG_EQUIPO_TOKEN ""

// SOLO compatibilidad v2 (clave anon/publishable). Vacía si se usa el token.
#define CFG_SUPABASE_KEY ""
