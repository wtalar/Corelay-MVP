// server.js - Główny silnik API Corelay
const express = require('express');
const cors = require('cors');
const CorelayLogic = require('./corelay_logic');
const DB = require('./database'); // Nasza baza danych
const app = express();
const port = process.env.PORT || 8080;

// Konfiguracja CORS (Kluczowe dla połączenia między aplikacjami)
// To pozwala Twoim aplikacjom na Netlify łączyć się z API na Render
const allowedOrigins = [
    'http://localhost:8080', 
    'https://*.netlify.app',
    'https://*.corelay.tech' // Ustawienie Twojej domeny
];
app.use(cors({
    origin: (origin, callback) => {
        // Zezwól na zapytania z pustym 'origin' (np. mobilne) lub z listy
        if (!origin || allowedOrigins.some(pattern => new RegExp(pattern).test(origin))) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

app.use(express.json());

// Testowy endpoint, aby Render wiedział, że API działa
app.get('/api', (req, res) => {
    res.send('Corelay API Base is Active. Waiting for /user/orders endpoint.');
});


// ------------------------------------------
// 1. ENDPOINT: POBIERANIE DANYCH UŻYTKOWNIKA (Dla Appki Klienta)
// ------------------------------------------
app.post('/api/user/orders', (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).send({ success: false, message: 'Brak User ID.' });
    }
    const orders = DB.getOrdersByUser(userId);
    res.json({ success: true, user: userId, orders: orders });
});

// ------------------------------------------
// 2. ENDPOINT: INICJOWANIE ZWROTU/GENEROWANIE KODU GOŚCINNEGO
// ------------------------------------------
app.post('/api/user/generate_guest_pin', (req, res) => {
    const { userId, orderId } = req.body;
    if (!userId || !orderId) {
        return res.status(400).send({ success: false, message: 'Brak danych.' });
    }
    
    // Sprawdzenie, czy paczka jest w ogóle do zwrotu (np. odebrana)
    const order = DB.getOrdersByUser(userId).find(o => o.orderId === orderId);
    if (!order || order.status !== 'PICKED_UP') {
        return res.status(400).send({ success: false, message: 'Zamówienie niekwalifikuje się do zwrotu.' });
    }

    const result = CorelayLogic.generateGuestPin(userId, orderId);
    res.json({ success: true, ...result });
});


// ------------------------------------------
// 3. ENDPOINT: WERYFIKACJA (Dla Skanera Modivo/LPP/InPost)
// ------------------------------------------
// Ten endpoint jest sercem systemu.
app.post('/api/verify_transaction', (req, res) => {
    const { userId, timestamp, scannerId, guestPin } = req.body;

    // Przekazanie danych do logiki biznesowej
    const result = CorelayLogic.validateTransaction(userId, timestamp, scannerId, guestPin);

    res.json(result);
});


// ------------------------------------------
// 4. ENDPOINT: TRYB BOGA (Do tworzenia nowych zamówień przez Ciebie)
// ------------------------------------------
app.post('/api/admin/create_test_order', (req, res) => {
    const { userId, orderId, storeId, product, status } = req.body;
    
    // Tę logikę trzeba by dopisać w DB, ale na potrzeby PoC zwrócimy tylko bazę
    // Będziesz po prostu edytował plik database.js przed uruchomieniem serwera!
    res.json({ success: true, message: "Edycja bazy danych w pliku 'database.js' przed uruchomieniem serwera." });
});


// Uruchomienie serwera
app.listen(port, () => {
    console.log(`Corelay API (Mózg) działa na porcie: ${port}`);
});

