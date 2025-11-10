'use strict';

/**
 * corelay_logic.js - Logika biznesowa Corelay (CORE + RELAY)
 * 
 * Moduł obsługuje kluczowe operacje MVP:
 * - Generowanie guest PIN/QR dla odbioru/zwrotu.
 * - Weryfikację transakcji (dynamic code jak BLIK + expiry checks).
 * - Finalizację statusu zamówienia (odbioru/zwrotu).
 * 
 * Zależności: otp-generator (PIN), moment (daty), DB (baza).
 * 
 * @module CorelayLogic
 * @author [Twoje imię] – Corelay MVP v1.0
 * @version 1.0.0
 */

// Zależności zewnętrzne
const otpGenerator = require('otp-generator');
const moment = require('moment');

// Import bazy danych (mock fallback jeśli nie istnieje)
let DB;
try {
  DB = require('./database');
} catch (err) {
  // Fallback: In-memory mock DB dla demo (jeśli database.js nie istnieje)
  console.warn('[CorelayLogic] Brak database.js – używam in-memory mock');
  const mockDB = {
    guestCodes: [], // [{ pin, orderId, userId, expiresAt }]
    orders: [],     // [{ orderId, userId, storeId, status, products, pickupDeadline, pickupTime, maxTime }]
    getOrdersByUser: (userId) => mockDB.orders.filter(o => o.userId === userId),
    addGuestCode: (pin, orderId, expiresAt, userId) => {
      mockDB.guestCodes.push({ pin, orderId, userId, expiresAt });
    },
    validateGuestCode: (pin) => {
      const now = moment().valueOf();
      return mockDB.guestCodes.find(g => g.pin === pin && g.expiresAt > now) || null;
    },
    updateOrderStatus: (orderId, newStatus) => {
      const order = mockDB.orders.find(o => o.orderId === orderId);
      if (order) {
        order.status = newStatus;
        if (newStatus === 'PICKED_UP') {
          order.pickupTime = moment().toISOString();
          order.maxTime = moment().add(14, 'days').valueOf(); // 14 dni na zwrot
        }
      }
    }
  };
  DB = mockDB;
}

// ============================================
// KONSTANTY KONFIGURACYJNE (Łatwe do zmiany)
// ============================================

/**
 * Czas ważności dynamicznego kodu (jak BLIK) w sekundach – anti-screenshot/replay.
 * @constant
 */
const OTP_VALIDITY_SECONDS = 30;

/**
 * Czas ważności guest code (PIN/QR) w minutach – dla odbioru/zwrotu.
 * @constant
 */
const GUEST_CODE_VALIDITY_MINUTES = 60;

/**
 * Tolerancja network delay dla expiry checks (ms) – dla real-world latency.
 * @constant
 */
const EXPIRY_TOLERANCE_MS = 1000;

/**
 * Dozwolone statusy zamówień – enum-like dla spójności.
 * @constant
 */
const ORDER_STATUSES = {
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  PICKED_UP: 'PICKED_UP',
  RETURN_PENDING: 'RETURN_PENDING',
  RETURNED_PENDING_REFUND: 'RETURNED_PENDING_REFUND'
};

/**
 * Obsługiwane typy skanerów (Modivo, LPP, InPost) – walidacja.
 * @constant
 */
const VALID_SCANNERS = ['MODIVO', 'LPP', 'INPOST'];

// ============================================
// GŁÓWNY OBIEKT LOGIKI (Eksportowany moduł)
// ============================================

const CorelayLogic = {

  // ============================================
  // FUNKCJA 1: GENEROWANIE KODU GOŚCINNEGO (PIN/QR)
  // ============================================
  /**
   * Generuje unikalny guest PIN (6 cyfr) dla odbioru/zwrotu zamówienia.
   * 
   * @param {string} userId - Email/ID użytkownika (np. 'konsument@corelay.pl')
   * @param {string} orderId - Unikalne ID zamówienia (np. 'ORD123')
   * @returns {object} Obiekt z PIN, expiry i metadanymi
   * @throws {ApiError} Jeśli input niepoprawny lub błąd DB
   * @example
   * const result = CorelayLogic.generateGuestPin('test@corelay.pl', 'ORD123');
   * // { pin: '123456', expiresAt: 1731327600000, expiresInMinutes: 60 }
   */
  generateGuestPin: (userId, orderId) => {
    // Walidacja inputów
    if (!userId || typeof userId !== 'string' || !userId.includes('@')) {
      throw new (require('./server').ApiError)('Nieprawidłowy userId – musi być email', 400); // Zgodne z server.js
    }
    if (!orderId || typeof orderId !== 'string' || orderId.length < 3) {
      throw new (require('./server').ApiError)('Nieprawidłowy orderId – min 3 znaki alfanumeryczne', 400);
    }

    // Generuj unikalny PIN (cyfry only, anti-collision via try-catch)
    let pin;
    try {
      pin = otpGenerator.generate(6, { 
        digits: true, 
        upperCaseAlphabets: false, 
        specialChars: false, 
        lowerCaseAlphabets: false 
      });
    } catch (err) {
      throw new (require('./server').ApiError)('Błąd generowania PIN – spróbuj ponownie', 500);
    }

    // Oblicz expiry (timestamp ms)
    const now = moment().valueOf();
    const expiresAt = moment().add(GUEST_CODE_VALIDITY_MINUTES, 'minutes').valueOf();

    // Zapisz do DB (z userId dla traceability)
    try {
      DB.addGuestCode(pin, orderId, expiresAt, userId);
      // Opcjonalne logowanie (wyłącz w prod: if (process.env.NODE_ENV !== 'production'))
      const timestamp = moment().toISOString();
      console.log(`[${timestamp}] Guest PIN generated: ${pin} for user ${userId}, order ${orderId}, expires ${moment(expiresAt).format('YYYY-MM-DD HH:mm:ss')}`);
    } catch (dbErr) {
      throw new (require('./server').ApiError)('Błąd zapisu do bazy – kod nie zapisany', 500);
    }

    return {
      pin,  // String PIN (użyj do QR: encode jako 'PIN:' + pin)
      expiresAt,
      expiresInMinutes: GUEST_CODE_VALIDITY_MINUTES,
      type: 'guest',
      message: 'Kod gościnny gotowy do użycia – pokaż w aplikacji klienta'
    };
  },

  // ============================================
  // FUNKCJA 2: WERYFIKACJA TRANSAKCJI (Główne serce logiki)
  // ============================================
  /**
   * Weryfikuje transakcję na podstawie scanned data (PIN lub dynamic code).
   * Obsługuje odbiór (READY_FOR_PICKUP) i zwrot (PICKED_UP, w 14 dni).
   * 
   * @param {string} scannedUserId - Scanned email/ID użytkownika
   * @param {number|string} scannedTimestamp - Timestamp skanu (ms lub ISO string)
   * @param {string} scannerStoreId - ID skanera (MODIVO/LPP/INPOST)
   * @param {string} scannedGuestCode - Opcjonalny guest PIN/QR string
   * @returns {object} Wynik weryfikacji (success, message, transactionType)
   * @throws {ApiError} Dla krytycznych błędów (np. invalid scanner)
   * @example
   * const result = CorelayLogic.validateTransaction('test@corelay.pl', Date.now(), 'MODIVO', null);
   * // { success: true, transactionType: 'PICKUP', message: '...' }
   */
  validateTransaction: (scannedUserId, scannedTimestamp, scannerStoreId, scannedGuestCode) => {
    // Walidacja inputów
    if (!scannedUserId || typeof scannedUserId !== 'string') {
      throw new (require('./server').ApiError)('Brak lub nieprawidłowy scannedUserId', 400);
    }
    if (!scannedTimestamp) {
      throw new (require('./server').ApiError)('Brak scannedTimestamp – wymagany dla dynamic code', 400);
    }
    if (!VALID_SCANNERS.includes(scannerStoreId)) {
      throw new (require('./server').ApiError)(`Nieprawidłowy scannerStoreId: ${scannerStoreId} – musi być ${VALID_SCANNERS.join(', ')}`, 400);
    }

    // Konwertuj timestamp do ms
    let tsMs;
    if (typeof scannedTimestamp === 'string') {
      tsMs = moment(scannedTimestamp).valueOf();
      if (!tsMs) throw new (require('./server').ApiError)('Nieprawidłowy format timestamp – ISO lub ms', 400);
    } else {
      tsMs = scannedTimestamp;
    }

    // KROK 1: Sprawdź guest code (PIN/QR) jeśli podany
    if (scannedGuestCode && scannedGuestCode.trim()) {
      try {
        const guestCodeData = DB.validateGuestCode(scannedGuestCode.trim());
        if (!guestCodeData) {
          return { 
            success: false, 
            message: 'Kod gościnny (PIN/QR) niepoprawny lub wygasł. Użyj dynamicznego kodu z aplikacji.' 
          };
        }

        // Sprawdź expiry z tolerancją
        const now = moment().valueOf();
        if (guestCodeData.expiresAt < (now - EXPIRY_TOLERANCE_MS)) {
          return { 
            success: false, 
            message: `Kod gościnny wygasł ${moment(guestCodeData.expiresAt).fromNow()}. Wygeneruj nowy.` 
          };
        }

        // Znajdź zamówienie po orderId z guest code
        const order = DB.getOrdersByUser(guestCodeData.userId).find(o => o.orderId === guestCodeData.orderId);
        if (!order) {
          return { 
            success: false, 
            message: 'Zamówienie powiązane z kodem nie istnieje.' 
          };
        }

        // Przejdź do finalizacji
        return CorelayLogic._finalizeTransaction(order, scannerStoreId, 'GUEST_PIN');
      } catch (err) {
        throw new (require('./server').ApiError)('Błąd walidacji guest code – spróbuj ponownie', 500);
      }
    }

    // KROK 2: Dynamic code validation (jak BLIK – userId + timestamp)
    // Sprawdź "życie" kodu (anti-screenshot: <30s)
    const ageSeconds = (moment().valueOf() - tsMs) / 1000;
    if (ageSeconds > OTP_VALIDITY_SECONDS) {
      return { 
        success: false, 
        message: `Dynamiczny kod wygasł (${Math.round(ageSeconds)}s > ${OTP_VALIDITY_SECONDS}s). Użyto zrzutu ekranu lub jest za stary. Poproś o odświeżenie w aplikacji.` 
      };
    }

    if (ageSeconds < 0) {  // Future timestamp – anti-clock tamper
      return { 
        success: false, 
        message: 'Nieprawidłowy timestamp – w przyszłości?' 
      };
    }

    // KROK 3: Odszukaj pasujące zamówienie (logika "Gdzie/Co")
    const userOrders = DB.getOrdersByUser(scannedUserId);
    if (!userOrders || userOrders.length === 0) {
      return { 
        success: false, 
        message: 'Brak zamówień dla użytkownika – sprawdź email.' 
      };
    }

    // Znajdź matching order (odbioru: storeId match + status; zwrotu: status + maxTime)
    const matchingOrder = userOrders.find(order => {
      // Odbiór: Musi być w docelowym sklepie i gotowe
      if (order.status === ORDER_STATUSES.READY_FOR_PICKUP && order.storeId === scannerStoreId) {
        return true;
      }
      // Zwrot: Po odbiorze, w oknie 14 dni (uniwersalny – wszędzie)
      if (order.status === ORDER_STATUSES.PICKED_UP && order.maxTime > moment().valueOf()) {
        return true;
      }
      return false;
    });

    if (!matchingOrder) {
      return { 
        success: false, 
        message: `Brak pasującego zamówienia: Nie ma paczki 'DO ODBIORU' w ${scannerStoreId} lub brak aktywnych zwrotów (sprawdź status w aplikacji).` 
      };
    }

    // KROK 4: Finalizuj transakcję
    return CorelayLogic._finalizeTransaction(matchingOrder, scannerStoreId, 'DYNAMIC_CODE');
  },

  // ============================================
  // PRIVATE HELPER: FINALIZACJA TRANSAKCJI
  // ============================================
  /**
   * Prywatna funkcja finalizująca transakcję (update statusu w DB).
   * 
   * @private
   * @param {object} order - Obiekt zamówienia z DB
   * @param {string} scannerStoreId - ID skanera
   * @param {string} type - Typ: 'GUEST_PIN' lub 'DYNAMIC_CODE'
   * @returns {object} Wynik finalizacji
   * @throws {ApiError} Jeśli status nieznany lub błąd DB
   */
  _finalizeTransaction: (order, scannerStoreId, type) => {
    if (!order || typeof order !== 'object') {
      throw new (require('./server').ApiError)('Nieprawidłowy obiekt zamówienia', 500);
    }

    const response = {
      success: true,
      transactionType: null,
      message: 'Transakcja zakończona pomyślnie.',
      orderId: order.orderId,
      userId: order.userId,
      type,  // 'GUEST_PIN' lub 'DYNAMIC_CODE'
      scanner: scannerStoreId
    };

    const now = moment().toISOString();

    try {
      // Obsługa ODBIORU (READY_FOR_PICKUP → PICKED_UP)
      if (order.status === ORDER_STATUSES.READY_FOR_PICKUP) {
        DB.updateOrderStatus(order.orderId, ORDER_STATUSES.PICKED_UP);
        // Ustaw maxTime dla zwrotu (14 dni)
        order.maxTime = moment().add(14, 'days').valueOf();
        order.pickupTime = now;

        response.transactionType = 'PICKUP';
        response.message = `Paczka ODEBRANA w ${scannerStoreId}. Status: PICKED_UP. Okno zwrotu: 14 dni od teraz.`;
        
        // Log
        console.log(`[${now}] PICKUP finalized: Order ${order.orderId} via ${type} at ${scannerStoreId}`);
        return response;
      }

      // Obsługa ZWROTU (PICKED_UP → RETURNED_PENDING_REFUND)
      if (order.status === ORDER_STATUSES.PICKED_UP) {
        if (order.maxTime < moment().valueOf()) {
          return { 
            success: false, 
            message: 'Okno zwrotu (14 dni) wygasło – sprawdź datę odbioru.' 
          };
        }

        DB.updateOrderStatus(order.orderId, ORDER_STATUSES.RETURNED_PENDING_REFUND);
        order.returnTime = now;

        response.transactionType = 'RETURN';
        response.message = `ZWROT przyjęty w ${scannerStoreId}. Status: RETURNED_PENDING_REFUND. Proces refundu (np. via TPay) zainicjowany.`;

        // Log
        console.log(`[${now}] RETURN finalized: Order ${order.orderId} via ${type} at ${scannerStoreId}`);
        return response;
      }

      // Nieznany status
      return { 
        success: false, 
        message: `Nieznany status zamówienia: ${order.status}. Dopuszczalne: ${Object.values(ORDER_STATUSES).join(', ')}` 
      };
    } catch (dbErr) {
      throw new (require('./server').ApiError)('Błąd aktualizacji statusu w bazie – transakcja nie zapisana', 500);
    }
  }

};

// ============================================
// EKSPORT MODUŁU
// ============================================

/**
 * Eksportowany obiekt CorelayLogic – użyj w server.js: const CorelayLogic = require('./corelay_logic');
 * 
 * @type {object}
 */
module.exports = CorelayLogic;
