'use strict';

/**
 * database.js - In-Memory Mock Baza Danych Corelay (MVP)
 * 
 * Prosta baza w pamięci RAM: orders i guestCodes. Łatwa do edycji przed demo.
 * Zintegrowana z corelay_logic.js i server.js (używa ApiError).
 * 
 * Dla production: Zamień na MongoDB/PostgreSQL. Dla persistencji: Zapisz do JSON file (komentarz poniżej).
 * 
 * @module DB
 * @version 1.0.0
 */

// Zależności zewnętrzne (opcjonalne: moment dla dat; fallback na Date)
let moment;
try {
  moment = require('moment');
} catch (err) {
  console.warn('[DB] Brak moment – używam native Date');
  moment = {
    valueOf: () => Date.now(),
    add: (amount, unit) => ({ valueOf: () => Date.now() + (unit === 'hours' ? amount * 3600000 : unit === 'days' ? amount * 86400000 : 0) }),
    format: () => new Date().toISOString()
  };
}

// Import ApiError (z server.js – fallback jeśli nie istnieje)
let ApiError;
try {
  ApiError = require('./server').ApiError;
} catch (err) {
  // Fallback custom class
  class ApiError extends Error {
    constructor(message, status = 500) {
      super(message);
      this.status = status;
    }
  }
  ApiError = ApiError;
}

// ============================================
// SAMPLE DANE (EDYTUJ PRZED DEMO – dla user_wojtek = 'wojtek@corelay.pl')
// ============================================

/**
 * Mock baza: Orders i GuestCodes. Uruchamia się na starcie.
 * 
 * @private
 */
const mockDatabase = {
  // 1. ZAMÓWIENIA KLIENTÓW (ARRAY OBIEKTÓW)
  orders: [
    // ZAMÓWIENIE 1: Modivo – Gotowe do odbioru (READY_FOR_PICKUP)
    {
      userId: 'wojtek@corelay.pl',  // Email użytkownika (zgodne z app client)
      orderId: 'ORD-1001',
      storeId: 'MODIVO',
      products: [{ name: 'Niebieski Sweter M', price: 199 }],  // Array dla zwrotów (wybór)
      status: 'READY_FOR_PICKUP',
      pickupDeadline: moment().add(48, 'hours').format('YYYY-MM-DD'),  // 2 dni na odbiór
      createdAt: moment().toISOString(),
      maxTime: null  // Ustawiane na PICKED_UP (14 dni na zwrot)
    },
    // ZAMÓWIENIE 2: LPP – Odebrane (PICKED_UP, kwalifikuje do zwrotu)
    {
      userId: 'wojtek@corelay.pl',
      orderId: 'ORD-1002',
      storeId: 'LPP',
      products: [{ name: 'Kurtka Jeansowa L', price: 299 }],
      status: 'PICKED_UP',
      pickupDeadline: moment().subtract(1, 'day').format('YYYY-MM-DD'),  // Odebrane wczoraj
      pickupTime: moment().subtract(1, 'day').toISOString(),
      createdAt: moment().subtract(2, 'days').toISOString(),
      maxTime: moment().add(13, 'days').valueOf()  // 14 dni od odbioru
    },
    // ZAMÓWIENIE 3: InPost – Gotowe do odbioru w paczkomacie
    {
      userId: 'wojtek@corelay.pl',
      orderId: 'ORD-1003',
      storeId: 'INPOST',
      products: [{ name: 'Sukienka Vinted', price: 149 }],
      status: 'READY_FOR_PICKUP',
      pickupDeadline: moment().add(7, 'days').format('YYYY-MM-DD'),
      createdAt: moment().toISOString(),
      maxTime: null
    },
    // Dodaj więcej: np. { ..., status: 'RETURN_PENDING' } dla testu zwrotu
  ],

  // 2. KODY GOŚCINNE (ARRAY: PIN/QR z expiry, one-time use)
  guestCodes: [
    // Przykładowy testowy (opcjonalny – usuń dla czystego startu)
    // { code: '123456', orderId: 'ORD-1002', userId: 'wojtek@corelay.pl', expiresAt: moment().add(1, 'hour').valueOf() }
  ]
};

// Opcjonalna persistencja: Zapisz do JSON file po zmianach (odkomentuj i dodaj fs)
// const fs = require('fs');
// function saveToFile() { fs.writeFileSync('mockdb.json', JSON.stringify(mockDatabase, null, 2)); }
// function loadFromFile() { /* load on init */ }

const now = () => moment().valueOf();

// ============================================
// GŁÓWNY OBIEKT BAZY (FUNKCJE CRUD)
// ============================================

/**
 * Główny obiekt DB – eksportowany do corelay_logic i server.
 * 
 * @type {object}
 */
const DB = {

  // ============================================
  // FUNKCJA 1: POBIERANIE ZAMÓWIEŃ UŻYTKOWNIKA
  // ============================================
  /**
   * Pobiera wszystkie zamówienia dla danego użytkownika (email).
   * 
   * @param {string} userId - Email użytkownika (np. 'wojtek@corelay.pl')
   * @returns {array} Tablica zamówień lub pusta tablica
   * @throws {ApiError} Jeśli userId niepoprawny
   * @example DB.getOrdersByUser('wojtek@corelay.pl') // [{orderId: 'ORD-1001', ...}]
   */
  getOrdersByUser: (userId) => {
    if (!userId || typeof userId !== 'string' || !userId.includes('@')) {
      throw new ApiError('Nieprawidłowy userId – musi być email', 400);
    }

    const orders = mockDatabase.orders.filter(o => o.userId === userId);
    // Log (opcjonalne)
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[${moment().toISOString()}] DB: Pobrano ${orders.length} zamówień dla ${userId}`);
    }
    return orders;
  },

  // ============================================
  // FUNKCJA 2: UTWORZENIE NOWEGO ZAMÓWIENIA (DLA ADMIN)
  // ============================================
  /**
   * Tworzy nowe zamówienie (używa admin endpoint).
   * Auto-generuje createdAt, pickupDeadline (7 dni), waliduje status.
   * 
   * @param {object} orderData - Dane: {userId, orderId, storeId, products: array, status}
   * @returns {object} Utworzone zamówienie
   * @throws {ApiError} Jeśli dane niepoprawne lub duplikat orderId
   * @example DB.createOrder({ userId: 'test@pl', orderId: 'ORD-1004', storeId: 'MODIVO', products: [{name:'Buty', price:299}], status: 'READY_FOR_PICKUP' })
   */
  createOrder: (orderData) => {
    // Walidacja
    if (!orderData.userId || !orderData.orderId || !orderData.storeId || !Array.isArray(orderData.products) || orderData.products.length === 0) {
      throw new ApiError('Brakujące dane: userId, orderId, storeId, products (array)', 400);
    }
    if (!['MODIVO', 'LPP', 'INPOST'].includes(orderData.storeId)) {
      throw new ApiError(`Nieprawidłowy storeId: ${orderData.storeId} – musi być MODIVO/LPP/INPOST`, 400);
    }
    if (mockDatabase.orders.find(o => o.orderId === orderData.orderId)) {
      throw new ApiError(`Duplikat orderId: ${orderData.orderId} już istnieje`, 409);
    }
    if (!['READY_FOR_PICKUP', 'PICKED_UP', 'RETURN_PENDING'].includes(orderData.status)) {
      throw new ApiError(`Nieprawidłowy status: ${orderData.status}`, 400);
    }

    // Waliduj products (każdy ma name i price)
    for (const p of orderData.products) {
      if (!p.name || typeof p.price !== 'number' || p.price < 0) {
        throw new ApiError('Products muszą mieć name (string) i price (number >=0)', 400);
      }
    }

    const newOrder = {
      ...orderData,
      createdAt: moment().toISOString(),
      pickupDeadline: orderData.status === 'READY_FOR_PICKUP' 
        ? moment().add(7, 'days').format('YYYY-MM-DD')  // Domyślnie 7 dni
        : null,
      pickupTime: orderData.status === 'PICKED_UP' ? moment().toISOString() : null,
      maxTime: orderData.status === 'PICKED_UP' 
        ? moment().add(14, 'days').valueOf()  // 14 dni na zwrot
        : null
    };

    mockDatabase.orders.push(newOrder);
    // Opcjonalnie: saveToFile();
    
    // Log
    console.log(`[${moment().toISOString()}] DB: Utworzono zamówienie ${newOrder.orderId} dla ${newOrder.userId} (status: ${newOrder.status})`);
    
    return newOrder;
  },

  // ============================================
  // FUNKCJA 3: AKTUALIZACJA STATUSU ZAMÓWIENIA
  // ============================================
  /**
   * Aktualizuje status zamówienia i ustawia maxTime (dla PICKED_UP).
   * 
   * @param {string} orderId - Unikalne ID zamówienia
   * @param {string} newStatus - Nowy status (READY_FOR_PICKUP, PICKED_UP, RETURN_PENDING, RETURNED_PENDING_REFUND)
   * @returns {boolean} true jeśli zaktualizowano
   * @throws {ApiError} Jeśli orderId nie istnieje lub niepoprawny status
   * @example DB.updateOrderStatus('ORD-1001', 'PICKED_UP')
   */
  updateOrderStatus: (orderId, newStatus) => {
    if (!orderId || typeof orderId !== 'string' || orderId.length < 3) {
      throw new ApiError('Nieprawidłowy orderId – min 3 znaki', 400);
    }
    if (!['READY_FOR_PICKUP', 'PICKED_UP', 'RETURN_PENDING', 'RETURNED_PENDING_REFUND'].includes(newStatus)) {
      throw new ApiError(`Nieprawidłowy status: ${newStatus}`, 400);
    }

    const orderIndex = mockDatabase.orders.findIndex(o => o.orderId === orderId);
    if (orderIndex === -1) {
      throw new ApiError(`Zamówienie ${orderId} nie istnieje`, 404);
    }

    const order = mockDatabase.orders[orderIndex];
    order.status = newStatus;
    order.updatedAt = moment().toISOString();

    if (newStatus === 'PICKED_UP') {
      order.pickupTime = moment().toISOString();
      order.maxTime = moment().add(14, 'days').valueOf();  // Okno zwrotu
    } else if (newStatus === 'RETURN_PENDING' || newStatus === 'RETURNED_PENDING_REFUND') {
      order.returnTime = moment().toISOString();
      order.maxTime = null;  // Po zwrocie reset
    }

    // Opcjonalnie: saveToFile();
    
    // Log
    console.log(`[${moment().toISOString()}] DB: Zaktualizowano ${orderId} na ${newStatus} (user: ${order.userId})`);
    
    return true;
  },

  // ============================================
  // FUNKCJA 4: DODAWANIE KODU GOŚCINNEGO (PIN/QR)
  // ============================================
  /**
   * Dodaje nowy guest code (PIN/QR), usuwa stary jeśli istnieje.
   * 
   * @param {string} code - PIN (string, np. '123456') lub QR data
   * @param {string} orderId - Powiązane zamówienie
   * @param {number} expiresAt - Timestamp expiry (ms)
   * @param {string} userId - Email użytkownika (dla traceability)
   * @returns {void}
   * @throws {ApiError} Jeśli parametry niepoprawne lub expiry < now
   * @example DB.addGuestCode('123456', 'ORD-1001', now() + 3600000, 'wojtek@corelay.pl')
   */
  addGuestCode: (code, orderId, expiresAt, userId) => {
    if (!code || typeof code !== 'string' || code.length < 4) {
      throw new ApiError('Nieprawidłowy code – min 4 znaki', 400);
    }
    if (!orderId || !userId) {
      throw new ApiError('Brak orderId lub userId', 400);
    }
    if (expiresAt <= now()) {
      throw new ApiError('Expiry musi być w przyszłości', 400);
    }

    // Usuń stary kod dla tego orderId (one-per-order)
    DB.removeGuestCode(orderId);

    mockDatabase.guestCodes.push({
      code,
      orderId,
      userId,
      expiresAt
    });

    // Log
    console.log(`[${moment().toISOString()}] DB: Dodano guest code ${code} dla ${orderId} (user: ${userId}, expires: ${moment(expiresAt).format('YYYY-MM-DD HH:mm:ss')})`);
  },

  // ============================================
  // FUNKCJA 5: USUWANIE KODU GOŚCINNEGO
  // ============================================
  /**
   * Usuwa guest code po orderId (lub po użyciu w validate).
   * 
   * @param {string} orderId - ID zamówienia do usunięcia kodu
   * @returns {number} Liczba usuniętych (0 lub 1)
   * @example DB.removeGuestCode('ORD-1001')
   */
  removeGuestCode: (orderId) => {
    const beforeCount = mockDatabase.guestCodes.length;
    mockDatabase.guestCodes = mockDatabase.guestCodes.filter(c => c.orderId !== orderId);
    const removed = beforeCount - mockDatabase.guestCodes.length;
    
    if (removed > 0) {
      console.log(`[${moment().toISOString()}] DB: Usunięto guest code dla ${orderId}`);
    }
    
    return removed;
  },

  // ============================================
  // FUNKCJA 6: WALIDACJA KODU GOŚCINNEGO
  // ============================================
  /**
   * Sprawdza ważność guest code i usuwa po użyciu (one-time).
   * 
   * @param {string} code - PIN/QR do walidacji
   * @returns {object|null} Dane kodu (z orderId, userId, expiresAt) lub null (invalid/expired)
   * @throws {ApiError} Jeśli code niepoprawny
   * @example const codeData = DB.validateGuestCode('123456'); // {code, orderId, userId, expiresAt}
   */
  validateGuestCode: (code) => {
    if (!code || typeof code !== 'string') {
      throw new ApiError('Nieprawidłowy code – musi być string', 400);
    }

    const nowTime = now();
    const codeEntry = mockDatabase.guestCodes.find(c => c.code === code.trim());
    
    if (!codeEntry) {
      throw new ApiError('Kod gościnny nie istnieje', 404);
    }
    
    if (codeEntry.expiresAt < (nowTime - 1000)) {  // Tolerancja 1s
      DB.removeGuestCode(codeEntry.orderId);
      throw new ApiError('Kod wygasł', 400);
    }

    // Użyty – usuń (one-time)
    DB.removeGuestCode(codeEntry.orderId);
    
    // Log
    console.log(`[${moment().toISOString()}] DB: Zweryfikowano i usunięto code ${code} dla ${codeEntry.orderId} (user: ${codeEntry.userId})`);
    
    return {
      code: codeEntry.code,
      orderId: codeEntry.orderId,
      userId: codeEntry.userId,
      expiresAt: codeEntry.expiresAt
    };
  },

  // ============================================
  // HELPER: POBRANIE ZAMÓWIENIA PO ID
  // ============================================
  /**
   * Helper: Pobiera pojedyncze zamówienie po orderId.
   * 
   * @param {string} orderId - ID zamówienia
   * @returns {object|null} Zamówienie lub null
   */
  getOrderById: (orderId) => {
    return mockDatabase.orders.find(o => o.orderId === orderId) || null;
  },

  // ============================================
  // HELPER: CZYSZCZENIE EXPIRED KODÓW (CRON-LIKE, WYWOŁUJ OKAZJONALNIE)
  // ============================================
  /**
   * Czyści wygasłe guest codes (dla performance).
   * 
   * @returns {number} Liczba usuniętych
   */
  cleanupExpiredCodes: () => {
    const nowTime = now();
    const before = mockDatabase.guestCodes.length;
    mockDatabase.guestCodes = mockDatabase.guestCodes.filter(c => c.expiresAt > nowTime);
    const cleaned = before - mockDatabase.guestCodes.length;
    
    if (cleaned > 0) {
      console.log(`[${moment().toISOString()}] DB: Wyczyszczono ${cleaned} wygasłych kodów`);
    }
    
    return cleaned;
  }

};

// Inicjalizacja: Opcjonalnie wyczyść na starcie
DB.cleanupExpiredCodes();

// Opcjonalnie: Zapisz sample do file na init (dla backup)
// saveToFile();

// ============================================
// EKSPORT MODUŁU
// ============================================

/**
 * Eksport DB – użyj w server.js i corelay_logic.js: const DB = require('./database');
 */
module.exports = DB;
