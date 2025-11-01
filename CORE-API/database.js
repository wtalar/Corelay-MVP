// database.js - Twoja lista zamówień (przed demo edytuj i wklej ten kod)
const moment = require('moment');

// UWAGA: To jest stała baza, którą edytujesz ręcznie przed startem serwera
const mockDatabase = {
    // ------------------------------------------
    // 1. ZAMÓWIENIA KLIENTÓW (ORDER DATA)
    // ------------------------------------------
    // Tutaj umieszczamy wszystkie paczki przypisane do użytkownika (UserID)
    orders: [
        // ZAMÓWIENIE 1: Dla Modivo (Sklep: MODIVO, Status: GOTOWE DO ODBIORU)
        { userId: "user_wojtek", orderId: "ORD-1001", storeId: "MODIVO", product: "Niebieski Sweter, M", status: "READY_FOR_PICKUP", maxTime: moment().add(48, 'hours').valueOf() },
        
        // ZAMÓWIENIE 2: Dla LPP (Sklep: LPP, Status: ODEBRANE - Kwalifikuje się do zwrotu)
        { userId: "user_wojtek", orderId: "ORD-1002", storeId: "LPP", product: "Kurtka Jeansowa, L", status: "PICKED_UP", maxTime: moment().add(14, 'days').valueOf() },

        // ZAMÓWIENIE 3: Dla InPost (Przesyłka Vinted)
        { userId: "user_wojtek", orderId: "ORD-1003", storeId: "INPOST", product: "Sukienka Vinted", status: "READY_FOR_PICKUP" }
    ],

    // ------------------------------------------
    // 2. KODY GOŚCINNE (DELEGOWANIE)
    // ------------------------------------------
    // Ta tablica przechowuje KOD PIN i datę jego wygaśnięcia
    guestCodes: [
        // Przykład ręcznego kodu testowego (na start jest pusta)
        // { code: "123456", orderId: "ORD-1002", expiresAt: 1748239000000 } 
    ]
};

/**
 * Funckje do zarządzania bazą
 */
const DB = {
    // Odnajduje wszystkie zamówienia danego użytkownika
    getOrdersByUser: (userId) => mockDatabase.orders.filter(o => o.userId === userId),
    
    // Zmienia status zamówienia i aktualizuje datę zwrotu
    updateOrderStatus: (orderId, newStatus) => {
        const order = mockDatabase.orders.find(o => o.orderId === orderId);
        if (order) {
            order.status = newStatus;
            // Jeśli paczka odebrana, ustawiamy nowy maxTime (14 dni na zwrot)
            if (newStatus === 'PICKED_UP') {
                order.maxTime = moment().add(14, 'days').valueOf();
            }
            return true;
        }
        return false;
    },

    // Dodawanie/usuwanie kodów gościnnych
    addGuestCode: (code, orderId, expiresAt) => {
        // Usuwamy stary kod, jeśli istniał
        DB.removeGuestCode(orderId);
        mockDatabase.guestCodes.push({ code, orderId, expiresAt });
    },
    removeGuestCode: (orderId) => {
        mockDatabase.guestCodes = mockDatabase.guestCodes.filter(c => c.orderId !== orderId);
    },
    // Sprawdza, czy kod PIN jest ważny
    validateGuestCode: (code) => {
        const now = moment().valueOf();
        const codeEntry = mockDatabase.guestCodes.find(c => c.code === code);
        
        if (codeEntry && codeEntry.expiresAt > now) {
            // Kod użyty, natychmiast go usuwamy, aby był JEDNORAZOWY
            DB.removeGuestCode(codeEntry.orderId);
            return codeEntry;
        }
        return null;
    }
};

module.exports = DB;