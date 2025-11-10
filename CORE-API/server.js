#!/usr/bin/env node
'use strict';

require('dotenv').config(); // Ładuj zmienne środowiskowe (PORT, ALLOWED_ORIGINS, API_ADMIN_KEY)

const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // Nagłówki bezpieczeństwa (CSP, HSTS itp.)
const rateLimit = require('express-rate-limit'); // Ograniczenie zapytań (anti-spam)
const Joi = require('joi'); // Walidacja inputów
const CorelayLogic = require('./corelay_logic'); // Logika biznesowa (CORE + RELAY) – placeholder jeśli nie istnieje
const DB = require('./database'); // Baza danych (mock lub realna) – placeholder jeśli nie istnieje

const app = express();
const port = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE SETUP (Bezpieczeństwo i logowanie)
// ============================================

// Security headers
app.use(helmet());

// Parser dla JSON i URL-encoded (z limitem na bezpieczeństwo)
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Dynamiczny CORS (dla Netlify PWAs i localhost)
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : [
      'http://localhost:3000',
      'https://*.netlify.app', // Dla wszystkich subdomains Netlify (Modivo/LPP/InPost sims)
      'https://corelay.tech'   // Twoja domena produkcyjna
    ];

app.use(cors({
  origin: (origin, callback) => {
    // Pozwól na brak origin (np. curl, mobile) lub z listy (prosty wildcard match)
    if (!origin || allowedOrigins.some(pattern => 
      origin.includes(pattern.replace(/\*/g, '')) // Match np. 'modivo.netlify.app' w '*.netlify.app'
    )) {
      callback(null, true);
    } else {
      callback(new Error('CORS: Origin niedozwolony – sprawdź konfigurację'));
    }
  },
  credentials: true, // Dla przyszłego auth (cookies/sessions)
  optionsSuccessStatus: 200 // Dla starszych przeglądarek
}));

// Rate limiting dla wrażliwych endpointów (np. /verify_transaction)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minut
  max: 100, // Max 100 zapytań na IP/user
  message: { success: false, message: 'Przekroczono limit zapytań – spróbuj za 15 minut' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // Nie liczy sukcesów do limitu
});
app.use('/api/verify_transaction', limiter);

// Middleware logowania (z timestampami dla debugowania)
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const userAgent = req.get('User-Agent') || 'Unknown';
  console.log(`[${timestamp}] ${req.method} ${req.path} | IP: ${req.ip} | UA: ${userAgent.slice(0, 50)}`);
  next();
});

// ============================================
// CUSTOM ERROR CLASS I GLOBAL HANDLER (Obsługa błędów)
// ============================================
class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
    Error.captureStackTrace(this, this.constructor);
  }
}

app.use((err, req, res, next) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] BŁĄD w ${req.path}: ${err.message} | Status: ${err.status || 500}`);
  
  if (err.name === 'ApiError') {
    return res.status(err.status).json({ 
      success: false, 
      message: err.message,
      path: req.path 
    });
  }
  
  // Nieznany błąd – nie ujawniaj detali w production
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ success: false, message: 'Wewnętrzny błąd serwera – sprawdź logi' });
  } else {
    res.status(500).json({ success: false, message: err.message, stack: err.stack });
  }
});

// ============================================
// ENDPOINTY API (Pełna logika MVP)
// ============================================

// ============================================
// HEALTH CHECK (Dla Render/Uptime monitoring)
// ============================================
/**
 * @route GET /health
 * @description Sprawdź status API – kluczowe dla deploymentu (Render)
 * @returns {object} Status zdrowia serwera
 * @example curl http://localhost:3000/health
 */
app.get('/health', (req, res) => {
  res.status(200).json({ 
    success: true, 
    status: 'OK – Corelay MVP gotowy do demo', 
    timestamp: new Date().toISOString(),
    version: 'Corelay MVP v1.0.0',
    uptime: process.uptime() 
  });
});

// ============================================
// ENDPOINT 1: POBIERANIE ZAMÓWIEŃ UŻYTKOWNIKA (Dla PWA klienta)
// ============================================
/**
 * @route POST /api/user/orders
 * @description Pobierz listę zamówień dla konkretnego użytkownika (email)
 * @body {userId: string} – Email użytkownika (np. 'konsument@corelay.pl')
 * @returns {object} Lista zamówień z statusami i produktami
 * @example POST /api/user/orders { "userId": "test@corelay.pl" }
 */
app.post('/api/user/orders', (req, res, next) => {
  // Walidacja inputu z Joi
  const schema = Joi.object({
    userId: Joi.string().email({ minDomainSegments: 2 }).required().label('User ID')
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    return next(new ApiError(`Nieprawidłowe dane: ${error.details[0].message}`, 400));
  }

  const { userId } = value;
  try {
    // Pobierz z bazy (mock lub real)
    const orders = DB.getOrdersByUser ? DB.getOrdersByUser(userId) : []; // Fallback jeśli DB nie istnieje
    res.json({ 
      success: true, 
      userId, 
      orders, 
      count: orders.length,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    next(new ApiError('Błąd pobierania zamówień z bazy danych', 500));
  }
});

// ============================================
// ENDPOINT 2: GENEROWANIE KODU GOŚCINNEGO / INICJOWANIE ZWROTU (Dla PWA klienta)
// ============================================
/**
 * @route POST /api/user/generate_guest_pin
 * @description Wygeneruj QR/PIN dla odbioru lub zwrotu (sprawdź status i okno czasowe)
 * @body {userId: string, orderId: string} – Email i ID zamówienia
 * @returns {object} Dane QR (string do wygenerowania) i expiry
 * @example POST /api/user/generate_guest_pin { "userId": "test@corelay.pl", "orderId": "ORD123" }
 */
app.post('/api/user/generate_guest_pin', (req, res, next) => {
  const schema = Joi.object({
    userId: Joi.string().email({ minDomainSegments: 2 }).required(),
    orderId: Joi.string().alphanum().length(6).required().label('Order ID')
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    return next(new ApiError(`Nieprawidłowe dane: ${error.details[0].message}`, 400));
  }

  const { userId, orderId } = value;
  try {
    // Pobierz zamówienie z bazy
    const order = (DB.getOrdersByUser ? DB.getOrdersByUser(userId) : []).find(o => o.orderId === orderId);
    if (!order) {
      return next(new ApiError('Zamówienie nie istnieje lub nie należy do użytkownika', 404));
    }
    if (order.status !== 'PENDING_PICKUP' && order.status !== 'PICKED_UP') {
      return next(new ApiError('Zamówienie nie kwalifikuje się do odbioru/zwrotu', 400));
    }

    // Sprawdź okno czasowe (7 dni na odbiór, 14 dni na zwrot po odbiorze)
    const now = new Date();
    const deadline = new Date(order.pickupDeadline);
    if (now > deadline) {
      return next(new ApiError('Czas na odbiór/zwrot wygasł', 400));
    }
    if (order.status === 'PICKED_UP') {
      const pickupDate = new Date(order.pickupTime);
      if (now - pickupDate > 14 * 24 * 60 * 60 * 1000) {
        return next(new ApiError('Poza 14-dniowym oknem zwrotu', 400));
      }
    }

    // Generuj token/QR via logika (mock jeśli CorelayLogic nie istnieje)
    const qrData = CorelayLogic.generateGuestPin 
      ? CorelayLogic.generateGuestPin(userId, orderId) 
      : `QR_DATA:${orderId}|USER:${userId}|TOKEN:${Date.now()}`; // Fallback mock

    const expiresIn = order.status === 'PENDING_PICKUP' 
      ? Math.abs(deadline - now) 
      : 14 * 24 * 60 * 60 * 1000; // Ms do expiry

    res.json({ 
      success: true, 
      qrData, // String do wygenerowania QR w frontendzie (np. via qrcode.react)
      orderId, 
      type: order.status === 'PICKED_UP' ? 'return' : 'pickup',
      expiresIn, 
      expiresAt: new Date(now.getTime() + expiresIn).toISOString()
    });
  } catch (err) {
    next(new ApiError('Błąd generowania kodu gościnnego', 500));
  }
});

// ============================================
// ENDPOINT 3: WERYFIKACJA TRANSAKCJI (Core – dla symulatorów skanerów Modivo/LPP/InPost)
// ============================================
/**
 * @route POST /api/verify_transaction
 * @description Zweryfikuj QR/PIN w "sklepie" lub paczkomacie (skanowanie)
 * @body {userId: string, timestamp: ISO, scannerId: string, guestPin: string}
 * @returns {object} Potwierdzenie weryfikacji i update statusu
 * @example POST /api/verify_transaction { "userId": "test@corelay.pl", "timestamp": "2025-11-10T18:00:00Z", "scannerId": "MODIVO", "guestPin": "QR_DATA:ORD123|USER:test@corelay.pl|TOKEN:12345" }
 */
app.post('/api/verify_transaction', (req, res, next) => {
  const schema = Joi.object({
    userId: Joi.string().email({ minDomainSegments: 2 }).required(),
    timestamp: Joi.string().isoDate().required(),
    scannerId: Joi.string().valid('MODIVO', 'LPP', 'INPOST').required(),
    guestPin: Joi.string().min(10).required().label('Guest PIN/QR Data')
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    return next(new ApiError(`Nieprawidłowe dane skanowania: ${error.details[0].message}`, 400));
  }

  const { userId, timestamp, scannerId, guestPin } = value;
  try {
    // Parse guestPin (prosty split dla demo: QR_DATA:orderId|USER:user|TOKEN:token)
    const parts = guestPin.split('|');
    if (parts.length < 3) {
      return next(new ApiError('Nieprawidłowy format QR/PIN – nie można sparsować', 400));
    }
    const [, orderId, , expectedUser] = parts; // Wyciągnij orderId i expectedUser
    if (expectedUser !== userId) {
      return next(new ApiError('QR/PIN nie pasuje do użytkownika', 400));
    }

    // Walidacja via logika (mock jeśli CorelayLogic nie istnieje)
    const validationResult = CorelayLogic.validateTransaction 
      ? CorelayLogic.validateTransaction(userId, new Date(timestamp), scannerId, guestPin)
      : { success: true, message: 'Mock validation – success', status: 'verified' }; // Fallback

    if (!validationResult.success) {
      return next(new ApiError(validationResult.message || 'Weryfikacja nieudana', 400));
    }

    // Update w bazie (mock lub real)
    const order = (DB.getOrdersByUser ? DB.getOrdersByUser(userId) : []).find(o => o.orderId === orderId);
    if (!order) {
      return next(new ApiError('Zamówienie nie znaleziono w bazie', 404));
    }

    order.status = order.status === 'PENDING_PICKUP' ? 'PICKED_UP' : 'RETURNED';
    order.scannerId = scannerId;
    order.verifiedAt = new Date().toISOString();
    // Symuluj zapis do DB
    if (DB.updateOrder) DB.updateOrder(order);

    res.json({ 
      success: true, 
      message: `Transakcja zweryfikowana w ${scannerId}! Status: ${order.status}`, 
      orderId, 
      scanner: scannerId, 
      verifiedAt: order.verifiedAt,
      timeTaken: Date.now() - new Date(timestamp).getTime() // Ms od timestamp do teraz
    });
  } catch (err) {
    next(new ApiError('Błąd weryfikacji transakcji – sprawdź token lub bazę', 500));
  }
});

// ============================================
// ENDPOINT 4: TRYB BOGA (Admin – tworzenie testowych zamówień dla demo)
// ============================================
/**
 * @route POST /api/admin/create_test_order
 * @description Utwórz testowe zamówienie (z autoryzacją kluczem dla bezpieczeństwa)
 * @header API-ADMIN-KEY: string – Klucz z .env (obowiązkowy)
 * @body {userId: string, orderId: string, storeId: string, products: array, status: string}
 * @returns {object} Potwierdzenie utworzenia testowego zamówienia
 * @example POST /api/admin/create_test_order -H "API-ADMIN-KEY: secret" -d '{"userId": "test@corelay.pl", "orderId": "ORD123", "storeId": "MODIVO", "products": [{"name": "Buty", "price": 299}], "status": "PENDING_PICKUP"}'
 */
app.post('/api/admin/create_test_order', (req, res, next) => {
  // Autoryzacja: Sprawdź header z env key
  const adminKey = req.headers['api-admin-key'] || req.headers['API-ADMIN-KEY'];
  if (adminKey !== process.env.API_ADMIN_KEY) {
    return next(new ApiError('Brak autoryzacji: Nieprawidłowy klucz admina', 401));
  }

  const schema = Joi.object({
    userId: Joi.string().email({ minDomainSegments: 2 }).required(),
    orderId: Joi.string().alphanum().length(6).required(),
    storeId: Joi.string().valid('MODIVO', 'LPP', 'INPOST').required(),
    products: Joi.array()
      .min(1)
      .max(10)
      .items(Joi.object({
        name: Joi.string().min(1).max(50).required(),
        price: Joi.number().min(0).max(10000).required()
      }))
      .required(),
    status: Joi.string()
      .valid('PENDING_PICKUP', 'PICKED_UP', 'RETURN_PENDING')
      .default('PENDING_PICKUP')
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    return next(new ApiError(`Nieprawidłowe dane admina: ${error.details[0].message}`, 400));
  }

  const { userId, orderId, storeId, products, status } = value;
  try {
    // Generuj deadline (7 dni od teraz dla PENDING_PICKUP)
    const now = new Date();
    const pickupDeadline = status === 'PENDING_PICKUP' 
      ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      : null;

    // Utwórz obiekt zamówienia
    const newOrder = {
      orderId,
      userId,
      storeId,
      products,
      status,
      pickupDeadline,
      createdAt: now.toISOString(),
      pickupTime: status === 'PICKED_UP' ? now.toISOString() : null
    };

    // Zapisz do bazy (mock lub real)
    if (DB.createOrder) {
      DB.createOrder(newOrder);
    } else {
      // Fallback: Zapisz do globalnej mock bazy (jeśli DB nie istnieje)
      global.mockOrders = global.mockOrders || [];
      global.mockOrders.push(newOrder);
    }

    res.json({ 
      success: true, 
      message: `Testowe zamówienie utworzone pomyślnie w ${storeId}`, 
      orderId, 
      productsCount: products.length,
      status, 
      createdAt: now.toISOString()
    });
  } catch (err) {
    next(new ApiError('Błąd tworzenia testowego zamówienia – sprawdź bazę danych', 500));
  }
});

// ============================================
// 404 HANDLER (Domyślna odpowiedź na nieznane endpointy)
// ============================================
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: `Endpoint ${req.method} ${req.path} nie istnieje – sprawdź dokumentację` 
  });
});

// ============================================
// URUCHOMIENIE SERWERA Z GRACEFUL SHUTDOWN
// ============================================
const server = app.listen(port, () => {
  const startTime = new Date().toISOString();
  console.log(`\n🚀 [${startTime}] Corelay API (Mózg) uruchomiony na http://localhost:${port}`);
  console.log(`   Health check: http://localhost:${port}/health`);
  console.log(`   Env: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`\nGotowe do demo! Użyj /api/admin/create_test_order do seedowania danych.\n`);
});

// Graceful shutdown (obsługa SIGTERM/SIGINT dla Render/Heroku/Docker)
process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);

function shutDown() {
  console.log(`\n[${new Date().toISOString()}] Otrzymano sygnał shutdown – zamykanie serwera...`);
  server.close((err) => {
    if (err) {
      console.error('Błąd podczas shutdown:', err);
      process.exit(1);
    }
    console.log('Serwer zamknięty poprawnie. Do widzenia!');
    process.exit(0);
  });
}

// Eksport dla testów (np. supertest lub integration tests)
module.exports = app;
