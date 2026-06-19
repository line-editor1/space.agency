// ══════════════════════════════════════════════════════════════════
// SPACE AUTH — единый модуль системы авторизации v4
// Подключается во всех файлах (chat.html, space_team.html, space_control.html)
// Экспортирует свои функции через глобальный объект window.SpaceAuth.
//
// ИСКЛЮЧИТЕЛЬНЫЙ ИСТОЧНИК ПРАВДЫ ДЛЯ СЕССИИ:
// — localStorage содержит только { uid: "...", ts: 1234567890 }
// — Роль и флаг активности запрашиваются напрямую из Firestore:
//   `/artifacts/space-video-agency/public/data/users/{uid}`
// ══════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    const SESSION_KEY = 'space_session_v4';
    const OWNER_BACKUP_KEY = 'space_owner_backup_v4';
    const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

    const APP_ID = 'space-video-agency';
    const USER_COLLECTION_PATH = ['artifacts', APP_ID, 'public', 'data', 'users'];

    let dbInstance = null;

    // Ленивая инициализация Firebase Firestore для использования внутри методов
    function getDb() {
        if (dbInstance) return dbInstance;
        try {
            // Импортируем Firestore из глобального контекста, если он уже подключен
            // Или используем стандартные методы инициализации.
            const app = window.firebaseApp || window.FR_APP; 
            if (window.firebaseDb) {
                dbInstance = window.firebaseDb;
            } else if (window.getFirestore && app) {
                dbInstance = window.getFirestore(app);
            }
        } catch (e) {
            console.error('[SpaceAuth] Ошибка инициализации DB:', e);
        }
        return dbInstance;
    }

    // Позволяет внешним скриптам передать инстанс базы данных напрямую
    function setDb(db) {
        dbInstance = db;
    }

    // ── Вход в систему ──────────────────────────────────────────────
    function login(uid) {
        const session = { uid, ts: Date.now() };
        try {
            localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        } catch (e) {
            console.error('[SpaceAuth] Ошибка записи сессии:', e);
        }
        return session;
    }

    // ─── Чтение сессии с валидацией TTL ─────────────────────────────
    function readSession() {
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            if (!raw) return null;
            const session = JSON.parse(raw);
            if (!session || !session.id) return null;
            
            // Проверка TTL (время жизни сессии)
            if (Date.now() - session.ts > SESSION_TTL_MS) {
                clearSession();
                return null;
            }
            return session;
        } catch (e) {
            return null;
        }
    }

    // ─── Выход / Очистка сессии ─────────────────────────────────────
    function clearSession() {
        [SESSION_KEY, OWNER_BACKUP_KEY, 'space_last_cabinet'].forEach(k => {
            try {
                localStorage.removeItem(k);
            } catch (e) {}
        });
    }

    // ─── Сохранить сессию owner перед "Войти как монтажёр" ──────────
    function saveOwnerSession() {
        try {
            const current = localStorage.getItem(SESSION_KEY);
            if (current) localStorage.setItem(OWNER_BACKUP_KEY, current);
        } catch (e) {}
    }

    // ─── Восстановить сессию owner ──────────────────────────────────
    function restoreOwnerSession() {
        try {
            const rawBackup = localStorage.getItem(OWNER_BACKUP_KEY);
            if (!rawBackup) return null;
            const backup = JSON.parse(rawBackup);
            if (backup && backup.uid) {
                localStorage.setItem(SESSION_KEY, rawBackup);
                localStorage.removeItem(OWNER_BACKUP_KEY);
                return backup;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    function hasOwnerBackup() {
        try {
            return !!localStorage.getItem(OWNER_BACKUP_KEY);
        } catch (e) {
            return false;
        }
    }

    // ─── Получение ссылки на кабинет по роли ────────────────────────
    function getCabinetUrl(role) {
        if (role === 'owner') return 'space_control.html';
        if (role === 'editor') return 'space_team.html';
        try {
            const last = localStorage.getItem('space_last_cabinet');
            if (last === 'space_team.html' || last === 'space_control.html') return last;
        } catch (e) {}
        return 'space_team.html';
    }

    function rememberCabinet(fileName) {
        try {
            localStorage.setItem('space_last_cabinet', fileName);
        } catch (e) {}
    }

    // ─── Безопасный асинхронный запрос к Firestore ──────────────────
    // Проверяет существование пользователя, его статус активности (active) и возвращает роль.
    async function verifyUserWithFirestore(uid) {
        const db = getDb();
        if (!db) {
            throw new Error('База данных не инициализирована. Повторите попытку.');
        }

        // По канонам Firebase SDK: импортируем doc и getDoc, либо используем глобальные
        const docRef = window.doc(db, ...USER_COLLECTION_PATH, uid);
        const docSnap = await window.getDoc(docRef);

        if (!docSnap.exists()) {
            throw new Error('Аккаунт пользователя не зарегистрирован в системе SPACE.');
        }

        const userData = docSnap.data();
        if (userData.active !== true) {
            throw new Error('Данный аккаунт заблокирован или деактивирован.');
        }

        return {
            id: uid,
            role: userData.role, // 'owner' или 'editor'
            name: userData.name || userData.login || 'Пользователь SPACE',
            active: userData.active
        };
    }

    // ─── API: requireAuth (Используется на страницах) ────────────────
    async function requireAuth() {
        const session = readSession();
        if (!session) {
            clearSession();
            return null;
        }
        try {
            // Запрашиваем актуальные данные из Firestore
            const user = await verifyUserWithFirestore(session.uid);
            return user;
        } catch (e) {
            console.warn('[SpaceAuth] Сбой проверки сессии:', e.message);
            // Если аккаунт заблокирован или удален — сбрасываем локальную сессию
            if (e.message.includes('заблокирован') || e.message.includes('не зарегистрирован')) {
                clearSession();
            }
            throw e;
        }
    }

    // ─── API: requireRole (Проверка на соответствие роли) ────────────
    async function requireRole(allowedRole) {
        const user = await requireAuth();
        if (!user) return null;
        if (user.role !== allowedRole) {
            throw new Error(`Доступ запрещен. Требуется роль: ${allowedRole}`);
        }
        return user;
    }

    // ─── Промис с тайм-аутом ─────────────────────────────────────────
    function withTimeout(promise, ms, message) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(message || 'Превышено время ожидания соединения')),
                ms
            );
            promise.then(
                (val) => { clearTimeout(timer); resolve(val); },
                (err) => { clearTimeout(timer); reject(err); }
            );
        });
    }

    // ─── Навигация между модулями ───────────────────────────────────
    function navigateWithSession(targetFile, uid, extraParams) {
        login(uid);
        const params = new URLSearchParams(extraParams || {});
        const qs = params.toString();
        window.location.href = targetFile + (qs ? '?' + qs : '');
    }

    window.SpaceAuth = {
        SESSION_KEY,
        OWNER_BACKUP_KEY,
        SESSION_TTL_MS,
        setDb,
        login,
        readSession,
        clearSession,
        saveOwnerSession,
        restoreOwnerSession,
        hasOwnerBackup,
        getCabinetUrl,
        rememberCabinet,
        withTimeout,
        requireAuth,
        requireRole,
        navigateWithSession
    };
})();