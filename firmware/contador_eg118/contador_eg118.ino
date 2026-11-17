/*
  CONTADOR DE CAJAS — USR-EG118  (v3)
  ------------------------------------------------------------
  - El algoritmo de conteo está en conteo.h (probado con 14 escenarios en PC).
  - Corre en su propia tarea, 1 muestra por milisegundo, sin importar el WiFi.
  - Cada evento se guarda en una cola y se envía por lotes a Supabase.
    Si no hay internet, se acumulan (hasta MAX_PENDIENTES) y se envían después.
    Cada evento lleva un correlativo (seq) guardado en memoria permanente:
    reenviar nunca duplica, y si se pierde alguno la base de datos lo detecta.
  - DO1 (relé) da un pulso por cada caja → luz piloto.
  - DO2 (relé) queda activado mientras hay atasco → baliza / alarma.

  NOVEDAD v3: envía a la Edge Function "ingesta" con un TOKEN PROPIO del equipo
  (cabecera x-equipo-token). Ya no usa la clave anon de Supabase.
  Si EQUIPO_TOKEN queda vacío y SUPABASE_KEY tiene la clave anon, funciona como la v2
  (inserción directa por REST), mientras la base lo permita (permitir_insert_anon).

  ARCHIVOS: este .ino y conteo.h deben estar en la MISMA carpeta "contador_eg118".
  Monitor serie: 115200 baudios.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <time.h>
#include <sys/time.h>
#include "conteo.h"

// ======================= CONFIGURACIÓN =======================
const char* WIFI_SSID     = "NOMBRE_DE_LA_RED";        // 2,4 GHz (el hotspot del celular sirve)
const char* WIFI_PASS     = "CLAVE_DE_LA_RED";
const char* EQUIPO_ID     = "linea-1";                 // debe existir en la tabla 'equipos'

// Supabase: SOLO la base del proyecto, SIN "/rest/v1/" ni "/functions/v1/".
// Dejar SUPABASE_URL vacío = solo monitor serie.
const char* SUPABASE_URL  = "";                        // ej: "https://abcdefgh.supabase.co"

// Token propio del equipo (se genera con:  node scripts/token-equipo.mjs linea-1).
// Con token se envía a /functions/v1/ingesta. Es secreto: no lo publiques.
const char* EQUIPO_TOKEN  = "";

// SOLO compatibilidad con la v2: clave anon/publishable. Dejar vacía si se usa EQUIPO_TOKEN.
const char* SUPABASE_KEY  = "";

// Entrada del sensor: confirmar con prueba_eg118.ino
// true  = DI1 vale 1 con el haz CORTADO     false = DI1 vale 0 con el haz CORTADO
const bool DI_ACTIVO_ALTO = false;

// Relés (confirmado en el equipo): DO1 = bit 1, DO2 = bit 2
const uint8_t BIT_DO1 = 1;
const uint8_t BIT_DO2 = 2;

// Parámetros del algoritmo (ver conteo.h)
conteo::Config crearConfig() {
  conteo::Config c;
  c.bloqueoMinMs  = 100;    // ignorar bloqueos más cortos
  c.huecoMinMs    = 30;     // hueco mínimo que separa dos cajas
  c.largoCajaMm   = 450;    // largo de la caja en el sentido de avance
  c.velInicialMmS = 500;    // velocidad aproximada de la cinta (medirla: se ajusta sola después)
  c.maxPegadas    = 4;      // más cajas pegadas seguidas = atasco / cinta detenida
  c.usarEncoder   = false;  // true si se instala sensor de movimiento en el rodillo (ver USAR_AI_ENCODER)
  c.mmPorPulso    = 50;
  return c;
}

// Sensor de movimiento opcional en la entrada analógica AI1 (ver notas al final)
const bool  USAR_AI_ENCODER = false;
const int   AI_UMBRAL_ALTO  = 1800;   // lectura ADC (0-4095) para considerar pulso activo
const int   AI_UMBRAL_BAJO  = 1200;   // histéresis

const char* TZ_CHILE = "<-04>4<-03>,M9.1.6/24,M4.1.6/24";
const uint32_t HEARTBEAT_MS   = 30000;
const int      MAX_PENDIENTES = 1000;   // eventos guardados si no hay internet (~56 KB de RAM)
const int      LOTE_MAX       = 25;     // eventos por envío (la función acepta hasta 500)
// =============================================================

const int PIN_DI = 39, PIN_AI = 35, PIN_WDT = 3, PIN_DATA = 4, PIN_CLOCK = 15, PIN_LATCH = 2;

// ---------- Eventos ----------
struct Registro {
  char     tipo[16];
  int16_t  n;
  uint32_t durMs;
  float    avanceMm;
  uint8_t  cajas;
  int32_t  total;        // total del contador al momento del evento (sesión actual)
  float    vel;
  int64_t  epochMs;      // 0 = el equipo aún no tenía hora
  uint64_t seq;
};

QueueHandle_t cola;
conteo::Contador contador;
Preferences prefs;
volatile bool hazActual = false;
volatile uint8_t relesActual = 0;
volatile uint32_t do1ApagarEn = 0;
volatile bool enAtasco = false;

int64_t ahoraEpochMs() {
  struct timeval tv; gettimeofday(&tv, nullptr);
  if (tv.tv_sec < 1700000000) return 0;
  return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

void escribirReles(uint8_t v) {
  digitalWrite(PIN_LATCH, LOW);
  shiftOut(PIN_DATA, PIN_CLOCK, MSBFIRST, v);
  digitalWrite(PIN_LATCH, HIGH);
  relesActual = v;
}

// Llamado por el algoritmo (dentro de la tarea de conteo)
void alEvento(const conteo::Evento& e, void*) {
  Registro r{};
  strncpy(r.tipo, conteo::nombreEvento(e.tipo), sizeof(r.tipo) - 1);
  r.n = e.n; r.durMs = e.durMs; r.avanceMm = e.avanceMm; r.cajas = e.cajas;
  r.total = contador.totalCajas(); r.vel = contador.velocidadMmS();
  r.epochMs = ahoraEpochMs();
  xQueueSend(cola, &r, 0);

  if (e.n > 0) do1ApagarEn = millis() + 150;                       // pulso luz piloto
  if (e.tipo == conteo::EV_ATASCO_INICIO) enAtasco = true;
  if (e.tipo == conteo::EV_ATASCO_FIN)    enAtasco = false;
}

// ---------- Tarea de conteo: 1 ms ----------
void tareaConteo(void*) {
  TickType_t sig = xTaskGetTickCount();
  uint32_t ultimoMs = millis(), ultimoWdt = 0; bool wdt = false, aiAlto = false;
  for (;;) {
    vTaskDelayUntil(&sig, pdMS_TO_TICKS(1));
    uint32_t ahora = millis();
    uint32_t pasos = ahora - ultimoMs; ultimoMs = ahora;
    if (pasos == 0) continue;
    if (pasos > 20) pasos = 20;

    bool v = digitalRead(PIN_DI);
    bool haz = DI_ACTIVO_ALTO ? v : !v;
    hazActual = haz;

    uint16_t pulsos = 0;
    if (USAR_AI_ENCODER) {
      int a = analogRead(PIN_AI);
      if (!aiAlto && a > AI_UMBRAL_ALTO) { aiAlto = true; pulsos = 1; }
      else if (aiAlto && a < AI_UMBRAL_BAJO) aiAlto = false;
    }
    for (uint32_t i = 0; i < pasos; i++) contador.paso(haz, i == 0 ? pulsos : 0);

    uint8_t deseado = 0;
    if ((int32_t)(do1ApagarEn - ahora) > 0) deseado |= (1 << BIT_DO1);
    if (enAtasco) deseado |= (1 << BIT_DO2);
    if (deseado != relesActual) escribirReles(deseado);

    if (ahora - ultimoWdt >= 500) { ultimoWdt = ahora; wdt = !wdt; digitalWrite(PIN_WDT, wdt); }
  }
}

// ---------- Cola de pendientes (RAM) ----------
Registro* pend;  int pIni = 0, pCant = 0, pCap = 0;
uint64_t seqSiguiente = 1;
uint32_t perdidosPorCola = 0;

void agregarPendiente(Registro& r) {
  r.seq = seqSiguiente++;
  prefs.putULong64("seq", seqSiguiente);              // memoria permanente: nunca se repite un seq
  if (pCant == pCap) { pIni = (pIni + 1) % pCap; pCant--; perdidosPorCola++; }   // lleno: se descarta el más antiguo
  pend[(pIni + pCant) % pCap] = r; pCant++;
}

void encolarLocal(const char* tipo) {                     // eventos propios del equipo (inicio, heartbeat)
  Registro r{};
  strncpy(r.tipo, tipo, sizeof(r.tipo) - 1);
  r.total = contador.totalCajas(); r.vel = contador.velocidadMmS(); r.epochMs = ahoraEpochMs();
  agregarPendiente(r);
}

const char* nombreEstado() {
  if (contador.cintaDetenida()) return "cinta_detenida";
  switch (contador.estadoActual()) {
    case conteo::Contador::INICIAL:  return "esperando_haz_libre";
    case conteo::Contador::ATASCO:   return "atasco";
    case conteo::Contador::EN_CAJA:
    case conteo::Contador::VALIDANDO: return "caja_en_haz";
    default: return "normal";
  }
}

// Arma el JSON de un evento
int jsonEvento(char* buf, size_t n, const Registro& r) {
  char ts[48] = "";
  if (r.epochMs > 0) {
    time_t s = r.epochMs / 1000; struct tm g; gmtime_r(&s, &g);
    snprintf(ts, sizeof(ts), ",\"ts\":\"%04d-%02d-%02dT%02d:%02d:%02d.%03dZ\"",
             g.tm_year + 1900, g.tm_mon + 1, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec, (int)(r.epochMs % 1000));
  }
  char extra[200] = "";
  if (strcmp(r.tipo, "heartbeat") == 0 || strcmp(r.tipo, "inicio") == 0) {
    snprintf(extra, sizeof(extra),
      ",\"extra\":{\"estado\":\"%s\",\"haz\":%s,\"rssi\":%d,\"pendientes\":%d,\"filtrados\":%lu,\"uptime_s\":%lu,\"perdidos_cola\":%lu}",
      nombreEstado(), hazActual ? "true" : "false", WiFi.RSSI(), pCant,
      (unsigned long)contador.pulsosFiltrados(), (unsigned long)(millis() / 1000), (unsigned long)perdidosPorCola);
  }
  return snprintf(buf, n,
    "{\"equipo_id\":\"%s\",\"seq\":%llu,\"tipo\":\"%s\",\"n\":%d,\"dur_ms\":%lu,\"avance_mm\":%.0f,"
    "\"cajas\":%u,\"total\":%ld,\"vel_mm_s\":%.0f%s%s}",
    EQUIPO_ID, (unsigned long long)r.seq, r.tipo, r.n, (unsigned long)r.durMs, r.avanceMm,
    r.cajas, (long)r.total, r.vel, ts, extra);
}

bool usarToken() { return strlen(EQUIPO_TOKEN) > 0; }

// Envía hasta LOTE_MAX eventos. Devuelve cuántos se confirmaron.
int enviarLote() {
  if (pCant == 0 || strlen(SUPABASE_URL) == 0 || WiFi.status() != WL_CONNECTED) return 0;
  int k = pCant < LOTE_MAX ? pCant : LOTE_MAX;
  String body; body.reserve(k * 330); body += "[";
  char buf[420];
  for (int i = 0; i < k; i++) {
    jsonEvento(buf, sizeof(buf), pend[(pIni + i) % pCap]);
    if (i) body += ",";
    body += buf;
  }
  body += "]";

  WiFiClientSecure cli; cli.setInsecure();          // pruebas: no valida el certificado
  HTTPClient http;
  String url = String(SUPABASE_URL) +
               (usarToken() ? "/functions/v1/ingesta"
                            : "/rest/v1/eventos?on_conflict=equipo_id,seq");
  if (!http.begin(cli, url)) return 0;
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  if (usarToken()) {
    http.addHeader("x-equipo-token", EQUIPO_TOKEN);
  } else {                                           // modo compatibilidad v2
    http.addHeader("apikey", SUPABASE_KEY);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
    http.addHeader("Prefer", "resolution=ignore-duplicates,missing=default,return=minimal");
  }
  int code = http.POST(body);
  if (code < 200 || code >= 300) {
    String resp = http.getString().substring(0, 200);
    if (code == 401) Serial.printf("Supabase: 401 — %s. Revisa EQUIPO_TOKEN.\n", resp.c_str());
    else Serial.printf("Supabase: error %d %s\n", code, resp.c_str());
    http.end(); return 0;
  }
  if (usarToken()) {
    String resp = http.getString();
    if (resp.indexOf("\"rechazados\":[]") < 0) Serial.printf("Supabase: %s\n", resp.substring(0, 200).c_str());
  }
  http.end();
  pIni = (pIni + k) % pCap; pCant -= k;
  return k;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_WDT, OUTPUT);
  pinMode(PIN_DI, INPUT);
  pinMode(PIN_DATA, OUTPUT); pinMode(PIN_CLOCK, OUTPUT); pinMode(PIN_LATCH, OUTPUT);
  escribirReles(0);

  prefs.begin("contador", false);
  seqSiguiente = prefs.getULong64("seq", 1);
  pCap = MAX_PENDIENTES;
  pend = (Registro*)malloc(sizeof(Registro) * pCap);
  while (!pend && pCap > 50) { pCap /= 2; pend = (Registro*)malloc(sizeof(Registro) * pCap); }

  Serial.printf("\n=== Contador de cajas v3 · %s · seq %llu · envío: %s ===\n", EQUIPO_ID,
                (unsigned long long)seqSiguiente,
                strlen(SUPABASE_URL) == 0 ? "solo serie" : (usarToken() ? "función ingesta (token)" : "REST anon (compatibilidad)"));

  cola = xQueueCreate(128, sizeof(Registro));
  contador.begin(crearConfig(), alEvento, nullptr);
  xTaskCreatePinnedToCore(tareaConteo, "conteo", 4096, nullptr, 10, nullptr, 1);

  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  configTzTime(TZ_CHILE, "pool.ntp.org", "time.google.com");
  encolarLocal("inicio");
}

uint32_t ultimoHb = 0, proximoEnvio = 0;
bool avisoWifi = false;

void loop() {
  // 1) pasar eventos del algoritmo a la cola de envío
  Registro r;
  while (xQueueReceive(cola, &r, 0) == pdTRUE) {
    agregarPendiente(r);
    if (r.n != 0 || strncmp(r.tipo, "atasco", 6) == 0 || strncmp(r.tipo, "cinta", 5) == 0)
      Serial.printf("%-15s n=%+d total=%ld dur=%lums vel=%.0fmm/s\n", r.tipo, r.n, (long)r.total, (unsigned long)r.durMs, r.vel);
  }

  // 2) heartbeat
  if (millis() - ultimoHb >= HEARTBEAT_MS) { ultimoHb = millis(); encolarLocal("heartbeat"); }

  // 3) WiFi
  bool con = WiFi.status() == WL_CONNECTED;
  if (con != avisoWifi) {
    avisoWifi = con;
    if (con) Serial.printf("WiFi: conectado %s (%d dBm)\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    else Serial.println("WiFi: desconectado, guardando eventos...");
  }

  // 4) enviar
  if (pCant > 0 && (int32_t)(millis() - proximoEnvio) >= 0) {
    if (strlen(SUPABASE_URL) == 0) { pIni = (pIni + pCant) % pCap; pCant = 0; }   // modo solo serie
    else {
      int ok = enviarLote();
      proximoEnvio = millis() + (ok > 0 ? (pCant > 0 ? 50 : 500) : 5000);
    }
  }
  delay(5);
}

/*
  NOTAS
  - Contador persistente: el total real sale de la base de datos (suma de n), no del equipo.
    El 'total' que envía el equipo es solo de la sesión actual (desde que encendió).
  - Sin hora de internet, los eventos se guardan sin 'ts' y Supabase usa la hora de llegada.
  - Sensor de movimiento opcional (resuelve exacto el caso "cinta detenida con caja en el haz"):
    un sensor inductivo PNP mirando los pernos del rodillo, con su salida a AI1 a través de una
    resistencia de 1,5 kΩ (con 24 V) o 1 kΩ (con 12 V) para no pasar de ~20 mA, y COM de AI a 0 V.
    Luego: USAR_AI_ENCODER = true, c.usarEncoder = true y c.mmPorPulso = avance de la cinta entre pernos.
    Revisar con el monitor serie que el umbral AI detecte bien los pulsos antes de usarlo.
*/
