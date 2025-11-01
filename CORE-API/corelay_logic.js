// corelay_logic.js - Zawiera logikę biznesową
const otpGenerator = require('otp-generator');
const DB = require('./database');
const moment = require('moment');

// Czas ważności DYNAMICZNEGO KODU (jak BLIK) w sekundach
const OTP_VALIDITY_SECONDS = 30; 
// Czas ważności KODU GOŚCINNEGO (PIN) w minutach
const GUEST_CODE_VALIDITY_MINUTES = 60; 

const CorelayLogic = {
    // ------------------------------------------
    // FUNKCJA 1: GENEROWANIE KODU GOŚCINNEGO (PIN)
    // ------------------------------------------
    generateGuestPin: (userId, orderId) => {
        // Generuje 6-cyfrowy unikalny PIN
        const pin = otpGenerator.generate(6, { digits: true, upperCaseAlphabets: false, specialChars: false, lowerCaseAlphabets: false });
        const expiresAt = moment().add(GUEST_CODE_VALIDITY_MINUTES, 'minutes').valueOf();
        
        DB.addGuestCode(pin, orderId, expiresAt);
        
        return {
            pin: pin,
            expiresAt: expiresAt,
            expiresInMinutes: GUEST_CODE_VALIDITY_MINUTES
        };
    },
    
    // ------------------------------------------
    // FUNKCJA 2: OSTATECZNA WERYFIKACJA TRANSAKCJI
    // ------------------------------------------
    // Ta funkcja jest wywoływana przez Appkę Sklepu/Paczkomatu
    validateTransaction: (scannedUserId, scannedTimestamp, scannerStoreId, scannedGuestCode) => {
        // Krok 1: Sprawdzenie KODU GOŚCINNEGO (PIN)
        if (scannedGuestCode) {
            const guestCodeData = DB.validateGuestCode(scannedGuestCode);
            if (!guestCodeData) {
                 return { success: false, message: "Kod gościnny niepoprawny lub wygasł. Użyj swojego kodu dynamicznego." };
            }
            // Jeśli PIN jest OK, wiemy dla jakiego zamówienia był użyty
            const order = DB.getOrdersByUser(guestCodeData.userId).find(o => o.orderId === guestCodeData.orderId);
            // Przejdź do kroku 3 z tym zamówieniem
            return CorelayLogic._finalizeTransaction(order, scannerStoreId, "GUEST_PIN");
        }

        // Krok 2: Sprawdzenie KODU DYNAMICZNEGO (USER ID + Timestamp)
        if (!scannedUserId) {
            return { success: false, message: "Brak identyfikatora użytkownika." };
        }

        // Sprawdzenie DYNAMICZNEGO ŻYCIA KODU (jak BLIK)
        const ageSeconds = (moment().valueOf() - scannedTimestamp) / 1000;
        if (ageSeconds > OTP_VALIDITY_SECONDS) {
            return { success: false, message: `Kod wygasł. Użyto zrzutu ekranu lub jest starszy niż ${OTP_VALIDITY_SECONDS} sekund. Poproś o odświeżenie.` };
        }
        
        // Krok 3: Odszukanie Zamówienia i Weryfikacja Statusu (Logika "Gdzie/Co")
        const userOrders = DB.getOrdersByUser(scannedUserId);
        
        // *****************************************************************
        // Najważniejsza Logika: System sprawdza, które zamówienie pasuje
        // *****************************************************************
        const matchingOrder = userOrders.find(order => {
            // W przypadku ODBIORU: Sprawdzamy, czy ten sklep ma tę paczkę (storeId)
            if (order.status === 'READY_FOR_PICKUP' && order.storeId === scannerStoreId) {
                return true;
            }
            // W przypadku ZWROTU: Sprawdzamy, czy paczka odebrana (PICKED_UP) i ma czas na zwrot
            if (order.status === 'PICKED_UP' && order.maxTime > moment().valueOf()) {
                 // W przypadku ZWROTU nie musimy sprawdzać storeId, bo zwrot można zrobić wszędzie (uniwersalność)
                 return true;
            }
            return false;
        });

        if (!matchingOrder) {
             return { success: false, message: `Brak paczki 'DO ODBIORU' w sklepie ${scannerStoreId} lub nie masz aktywnych zwrotów.` };
        }
        
        // Krok 4: Przeprowadzenie Transakcji
        return CorelayLogic._finalizeTransaction(matchingOrder, scannerStoreId, "DYNAMIC_CODE");
    },
    
    // ------------------------------------------
    // FUNKCJA 3: FINALIZACJA TRANSAKCJI
    // ------------------------------------------
    _finalizeTransaction: (order, scannerStoreId, type) => {
        const response = {
            success: true,
            transactionType: null,
            message: "Transakcja zakończona pomyślnie.",
            order: order
        };
        
        // Obsługa ODBIORU
        if (order.status === 'READY_FOR_PICKUP') {
            DB.updateOrderStatus(order.orderId, 'PICKED_UP');
            response.transactionType = 'PICKUP';
            response.message = `Paczkę ODEBRANO. Status zmieniono na: Do Zwrotu (14 dni).`;
            return response;
        }

        // Obsługa ZWROTU
        if (order.status === 'PICKED_UP') {
            // Zmieniamy status paczki na ZWROCONO (lub inny do procesowania)
            DB.updateOrderStatus(order.orderId, 'RETURNED_PENDING_REFUND');
            response.transactionType = 'RETURN';
            response.message = `ZWROT przyjęty pomyślnie w punkcie: ${scannerStoreId}. Proces zwrotu pieniędzy rozpoczęty.`;
            return response;
        }

        return { success: false, message: "Nieznany błąd statusu." };
    }
};

module.exports = CorelayLogic;