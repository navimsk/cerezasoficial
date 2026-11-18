/*
  conteo.h — Algoritmo de conteo de cajas (C++ puro, sin dependencias de Arduino)
  ------------------------------------------------------------------------------
  Se llama a paso(hazCortado, pulsosEncoder) UNA VEZ POR MILISEGUNDO.
  Cada vez que cambia el conteo o pasa algo relevante, llama al callback con un Evento.

  CONTEO = suma de Evento.n   (n = +1 por caja, negativo en un ajuste)

  Casos que maneja:
   1. Cajas separadas ...................... 1 bloqueo del haz = 1 caja (se cuenta al validar el bloqueo,
                                              no al final: tiempo real).
   2. Cajas pegadas (sin hueco) ............ mientras el haz sigue cortado, suma +1 cada vez que la cinta
                                              avanza un largo de caja más (en tiempo real, no al final).
                                              Regla: la caja k (k>=2) se cuenta cuando el avance del bloqueo
                                              llega a (k-1+FRACCION)*LARGO.  FRACCION=0,6 deja margen a una
                                              caja algo más larga o una cinta algo más lenta.
   3. Velocidad de la cinta ................ MODO TIEMPO: se aprende sola midiendo cuánto tapa el haz cada
                                              caja aislada (promedio móvil acotado).
                                              MODO ENCODER: se mide con pulsos de un sensor en el rodillo.
   4. Cinta detenida con caja frente al haz  MODO ENCODER: el avance es 0, no cuenta nada (solución exacta).
                                              MODO TIEMPO: si el bloqueo supera MAX_PEGADAS cajas, se declara
                                              ATASCO/PARADA: se revierten las cajas estimadas de ese bloqueo
                                              (evento "ajuste" negativo) y se deja de contar hasta que el haz
                                              se libere. Paradas CORTAS (< ~0,6 caja de tiempo) no se pueden
                                              distinguir sin encoder.
   5. Interferencias (mano, hoja, gota) .... bloqueos menores a BLOQUEO_MIN se ignoran.
   6. Calados / rebotes del haz ............ huecos menores a HUECO_MIN no separan cajas.
   7. Objeto tapando el haz al encender .... no se cuenta: espera a que el haz se libere.
*/
#pragma once
#include <stdint.h>
#include <math.h>

namespace conteo {

enum TipoEvento : uint8_t {
  EV_CAJA = 1,          // primera caja de un bloqueo (+1)
  EV_CAJA_EST = 2,      // caja pegada estimada por avance (+1)
  EV_AJUSTE = 3,        // corrección (n negativo) al detectar atasco
  EV_BLOQUE = 4,        // resumen al cerrar un bloqueo (n = 0): duración, avance, cajas
  EV_ATASCO_INICIO = 5, // haz cortado demasiado tiempo (n = 0)
  EV_ATASCO_FIN = 6,    // haz liberado tras atasco (n = 0)
  EV_CINTA_DETENIDA = 7,// solo modo encoder
  EV_CINTA_MARCHA = 8,  // solo modo encoder
  EV_BLOQUEO_INICIAL = 9// el haz estaba cortado al encender (n = 0)
};

inline const char* nombreEvento(TipoEvento t) {
  switch (t) {
    case EV_CAJA: return "caja";
    case EV_CAJA_EST: return "caja_est";
    case EV_AJUSTE: return "ajuste";
    case EV_BLOQUE: return "bloque";
    case EV_ATASCO_INICIO: return "atasco_inicio";
    case EV_ATASCO_FIN: return "atasco_fin";
    case EV_CINTA_DETENIDA: return "cinta_detenida";
    case EV_CINTA_MARCHA: return "cinta_marcha";
    case EV_BLOQUEO_INICIAL: return "bloqueo_inicial";
  }
  return "?";
}

struct Config {
  uint16_t bloqueoMinMs   = 100;    // menos que esto = interferencia
  uint16_t huecoMinMs     = 30;     // haz libre al menos esto para cerrar un bloqueo
  float    largoCajaMm    = 450;    // largo en el sentido de avance
  float    velInicialMmS  = 500;    // velocidad supuesta al encender (modo tiempo)
  float    velMinMmS      = 100;    // límites del aprendizaje
  float    velMaxMmS      = 1500;
  float    fraccion       = 0.6f;   // umbral para estimar la siguiente caja pegada (0,5–0,8)
  uint8_t  maxPegadas     = 4;      // MODO TIEMPO: más cajas seguidas que esto = atasco/parada
  uint8_t  maxPegadasEnc  = 15;     // MODO ENCODER: solo atascos reales (la cinta avanza y el haz sigue tapado)
  bool     aprender       = true;   // aprender velocidad de cajas aisladas (modo tiempo)
  float    alfa           = 0.15f;  // peso de cada medición nueva en el aprendizaje
  bool     usarEncoder    = false;  // true si hay sensor de movimiento en el rodillo
  float    mmPorPulso     = 50;     // avance de la cinta por pulso del encoder
  uint32_t detenidaMs     = 1500;   // sin pulsos este tiempo = cinta detenida
};

struct Evento {
  TipoEvento tipo;
  int16_t  n;        // aporte al conteo
  uint32_t tMs;      // tiempo interno (ms desde el inicio)
  uint32_t durMs;    // duración del bloqueo / atasco
  float    avanceMm; // avance de la cinta durante el bloqueo
  uint8_t  cajas;    // cajas contadas en el bloqueo
};

typedef void (*Callback)(const Evento&, void* ctx);

class Contador {
public:
  enum Estado : uint8_t { INICIAL, LIBRE, VALIDANDO, EN_CAJA, ATASCO };

  void begin(const Config& c, Callback cb, void* ctx) {
    cfg = c; cbk = cb; ctxp = ctx;
    velMmS = c.velInicialMmS; iMuestra = 0; nMuestras = 0;
    estado = INICIAL; t = 0; total = 0; filtrados = 0;
    primerPaso = true; detenida = false; msSinPulso = 0; ultimoIntervaloPulso = 0;
  }

  // Llamar una vez por milisegundo.
  void paso(bool haz, uint16_t pulsos = 0) {
    t++;
    float avance = calcularAvance(pulsos);

    if (primerPaso) {
      primerPaso = false;
      if (haz) { estado = INICIAL; emitir(EV_BLOQUEO_INICIAL, 0, 0, 0, 0); }
      else estado = LIBRE;
      hueco = 0;
    }

    switch (estado) {
      case INICIAL:   // esperar a que el haz se libere antes de contar
        if (!haz) { if (++hueco >= cfg.huecoMinMs) { estado = LIBRE; hueco = 0; } }
        else hueco = 0;
        break;

      case LIBRE:
        if (haz) { estado = VALIDANDO; corrida = 1; avanceBloque = avance; hueco = 0; avanceHueco = 0; }
        break;

      case VALIDANDO:
        // Igual que EN_CAJA, huecos cortos (calados, rebotes) no cortan la validación
        if (haz) {
          if (hueco > 0) { corrida += hueco; avanceBloque += avanceHueco; hueco = 0; avanceHueco = 0; }
          corrida++; avanceBloque += avance;
          if (corrida >= cfg.bloqueoMinMs) {
            estado = EN_CAJA; durBloque = corrida; cajasBloque = 1;
            total += 1;
            emitir(EV_CAJA, +1, durBloque, avanceBloque, 1);
          }
        } else {
          hueco++; avanceHueco += avance;
          if (hueco >= cfg.huecoMinMs) { filtrados++; estado = LIBRE; hueco = 0; avanceHueco = 0; }
        }
        break;

      case EN_CAJA:
        if (haz) {
          if (hueco > 0) { durBloque += hueco; avanceBloque += avanceHueco; hueco = 0; avanceHueco = 0; }
          durBloque++; avanceBloque += avance;
          // cajas pegadas: contar en tiempo real según el avance
          // la caja número (cajasBloque+1) se cuenta cuando el avance llega a (cajasBloque + fraccion) * largo
          const uint8_t limite = cfg.usarEncoder ? cfg.maxPegadasEnc : cfg.maxPegadas;
          while (cajasBloque < limite &&
                 avanceBloque >= ((float)cajasBloque + cfg.fraccion) * cfg.largoCajaMm) {
            cajasBloque++; total += 1;
            emitir(EV_CAJA_EST, +1, durBloque, avanceBloque, cajasBloque);
          }
          // atasco / parada: más de maxPegadas cajas de avance
          if (avanceBloque >= ((float)limite + 1.0f) * cfg.largoCajaMm) {   // margen de 1 caja
            int16_t revertir = (int16_t)(cajasBloque - 1);
            if (revertir > 0) { total -= revertir; emitir(EV_AJUSTE, -revertir, durBloque, avanceBloque, 1); }
            cajasBloque = 1;
            estado = ATASCO; durAtasco = durBloque;
            emitir(EV_ATASCO_INICIO, 0, durBloque, avanceBloque, 1);
          }
        } else {
          hueco++; avanceHueco += avance;
          if (hueco >= cfg.huecoMinMs) cerrarBloque();
        }
        break;

      case ATASCO:
        durAtasco++;
        if (!haz) {
          if (++hueco >= cfg.huecoMinMs) {
            emitir(EV_ATASCO_FIN, 0, durAtasco, 0, 1);
            estado = LIBRE; hueco = 0;
          }
        } else hueco = 0;
        break;
    }
  }

  // Cambia la configuración en marcha (desde la app). Llamar desde la MISMA tarea que paso().
  //  largoMm: largo de la caja en el sentido de avance (se ignora si está fuera de 50–2000 mm)
  //  velFijaMmS > 0: usa esa velocidad desde ya y reinicia el aprendizaje desde ese valor
  //  aprender: seguir ajustando la velocidad con las cajas aisladas
  void ajustar(float largoMm, float velFijaMmS, bool aprender) {
    if (largoMm >= 50 && largoMm <= 2000) cfg.largoCajaMm = largoMm;
    cfg.aprender = aprender;
    if (velFijaMmS > 0 && !cfg.usarEncoder) {
      if (velFijaMmS < cfg.velMinMmS) velFijaMmS = cfg.velMinMmS;
      if (velFijaMmS > cfg.velMaxMmS) velFijaMmS = cfg.velMaxMmS;
      velMmS = velFijaMmS; iMuestra = 0; nMuestras = 0;
    }
  }

  // --- consultas para el heartbeat / pantalla ---
  int32_t  totalCajas()   const { return total; }
  uint32_t pulsosFiltrados() const { return filtrados; }
  float    velocidadMmS() const { return velMmS; }
  Estado   estadoActual() const { return estado; }
  bool     cintaDetenida() const { return detenida; }
  const Config& config() const { return cfg; }

private:
  Config cfg; Callback cbk = nullptr; void* ctxp = nullptr;
  Estado estado = INICIAL;
  uint32_t t = 0, corrida = 0, hueco = 0, durBloque = 0, durAtasco = 0;
  float avanceBloque = 0, avanceHueco = 0, velMmS = 500;
  uint8_t cajasBloque = 0;
  int32_t total = 0; uint32_t filtrados = 0;
  bool primerPaso = true;
  // encoder
  bool detenida = false; uint32_t msSinPulso = 0, ultimoIntervaloPulso = 0;
  // aprendizaje de velocidad
  static const uint8_t N_MUESTRAS = 7;
  float muestras[N_MUESTRAS] = {0};
  uint8_t iMuestra = 0, nMuestras = 0;

  float mediana() const {
    float v[N_MUESTRAS];
    for (uint8_t i = 0; i < nMuestras; i++) v[i] = muestras[i];
    for (uint8_t i = 1; i < nMuestras; i++) {           // orden por inserción (pocos valores)
      float x = v[i]; int j = i - 1;
      while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
      v[j + 1] = x;
    }
    return (nMuestras % 2) ? v[nMuestras / 2] : 0.5f * (v[nMuestras / 2 - 1] + v[nMuestras / 2]);
  }

  float calcularAvance(uint16_t pulsos) {
    if (!cfg.usarEncoder) return velMmS / 1000.0f;          // mm por ms
    if (pulsos > 0) {
      if (msSinPulso > 0) {
        ultimoIntervaloPulso = msSinPulso;
        velMmS = cfg.mmPorPulso * 1000.0f / (float)ultimoIntervaloPulso;
      }
      msSinPulso = 0;
      if (detenida) { detenida = false; emitir(EV_CINTA_MARCHA, 0, 0, 0, 0); }
      return pulsos * cfg.mmPorPulso;
    }
    msSinPulso++;
    if (!detenida && msSinPulso >= cfg.detenidaMs) {
      detenida = true; velMmS = 0;
      emitir(EV_CINTA_DETENIDA, 0, msSinPulso, 0, 0);
    }
    return 0;
  }

  void cerrarBloque() {
    // Aprender velocidad con la MEDIANA de las últimas cajas aisladas:
    // resiste bien a valores raros (una caja que se frenó, dos pegadas no detectadas, etc.)
    if (!cfg.usarEncoder && cfg.aprender && cajasBloque == 1 && durBloque > 0) {
      float vMedida = cfg.largoCajaMm * 1000.0f / (float)durBloque;
      if (vMedida >= cfg.velMinMmS && vMedida <= cfg.velMaxMmS) {
        muestras[iMuestra] = vMedida; iMuestra = (iMuestra + 1) % N_MUESTRAS;
        if (nMuestras < N_MUESTRAS) nMuestras++;
        if (nMuestras >= 3) velMmS = mediana();
      }
    }
    emitir(EV_BLOQUE, 0, durBloque, avanceBloque, cajasBloque);
    estado = LIBRE; hueco = 0; avanceHueco = 0;
  }

  void emitir(TipoEvento tipo, int16_t n, uint32_t dur, float av, uint8_t cajas) {
    if (!cbk) return;
    Evento e{tipo, n, t, dur, av, cajas};
    cbk(e, ctxp);
  }
};

} // namespace conteo
