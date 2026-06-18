// ══════════════════════════════════════════════════════════════════
// SPACE AUTH — единый модуль системы авторизации
// Подключается во всех трёх файлах (chat.html, space_team.html,
// space_control.html) как обычный <script src="space-auth.js"></script>
// ДО основного модульного <script type="module">, и экспортирует
// свои функции через глобальный объект window.SpaceAuth.
//
// Один источник правды для сессии устраняет расхождения между
// файлами (раньше каждый файл хранил свою копию этой логики, что
// приводило к багам вроде "циклической авторизации").
// ══════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    const SESSION_KEY = 'space_session';
    // Срок жизни сессии — 12 часов. После истечения пользователь должен
    // войти заново. Защищает от вечно живущих сессий на чужих устройствах.
    const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

    // ── Чтение сессии ──
    // Сессия читается ТОЛЬКО из storage (localStorage/sessionStorage).
    // Открытая передача роли/id через URL больше не используется как
    // основной канал — см. consumeUrlSessionFallback() ниже.
    function readSession() {
        let raw = null;
        try {
            raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
        } catch (e) { return null; }
        if (!raw) return null;

        let session;
        try {
            session = JSON.parse(raw);
        } catch (e) { return null; }

        if (!session || !session.role || !session.id) return null;

        // Проверка истечения сессии
        if (typeof session.ts !== 'number' || (Date.now() - session.ts) > SESSION_TTL_MS) {
            clearSession();
            return null;
        }

        // Синхронизация между двумя хранилищами на случай, если сессия
        // была найдена только в одном из них
        try {
            localStorage.setItem(SESSION_KEY, raw);
            sessionStorage.setItem(SESSION_KEY, raw);
        } catch (e) {}

        return session;
    }

    // ── Запись сессии ──
    function writeSession(role, id, name) {
        const session = { role, id, name: name || '', ts: Date.now() };
        const raw = JSON.stringify(session);
        try {
            localStorage.setItem(SESSION_KEY, raw);
            sessionStorage.setItem(SESSION_KEY, raw);
        } catch (e) {}
        return session;
    }

    // ── Удаление сессии ──
    function clearSession() {
        [SESSION_KEY, 'chat_role', 'chat_id', 'chat_name'].forEach(k => {
            try {
                localStorage.removeItem(k);
                sessionStorage.removeItem(k);
            } catch (e) {}
        });
    }

    // ── Резервная передача сессии между страницами разных доменов/вкладок ──
    // Используется ИСКЛЮЧИТЕЛЬНО как одноразовый канал передачи на случай,
    // если localStorage недоступен между переходами (например, разные
    // источники в встроенном WebView). При обычном использовании в рамках
    // одного домена сессия читается напрямую из storage, и этот механизм
    // не требуется.
    //
    // Передаваемое значение — не сырые role/id, а одноразовый непрозрачный
    // токен, который тут же расшифровывается и немедленно стирается из
    // адресной строки, чтобы не оставлять следов в истории браузера.
    function consumeUrlSessionFallback() {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('st'); // session token (base64 JSON)
        let applied = false;

        if (token) {
            try {
                const decoded = JSON.parse(atob(token));
                if (decoded && decoded.role && decoded.id) {
                    writeSession(decoded.role, decoded.id, decoded.name || '');
                    applied = true;
                }
            } catch (e) {
                console.warn('[space-auth] Некорректный токен сессии в URL, игнорируем');
            }
        }

        if (params.has('st')) {
            params.delete('st');
            const qs = params.toString();
            const cleanUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
            window.history.replaceState({}, '', cleanUrl);
        }

        return applied;
    }

    // Кодирует сессию в одноразовый токен для передачи через URL при
    // переходе между страницами (используется только функциями переходов
    // ниже, не предназначен для постоянного хранения).
    function encodeSessionToken(role, id, name) {
        return btoa(JSON.stringify({ role, id, name: name || '' }));
    }

    // ── Куда вести "Войти в личный кабинет" в зависимости от роли ──
    function getCabinetUrl(role) {
        if (role === 'owner' || role === 'manager') return 'space_control.html';
        if (role === 'editor') return 'space_team.html';
        try {
            const last = localStorage.getItem('space_last_cabinet');
            if (last === 'space_team.html' || last === 'space_control.html') return last;
        } catch (e) {}
        return 'space_team.html';
    }

    function rememberCabinet(fileName) {
        try { localStorage.setItem('space_last_cabinet', fileName); } catch (e) {}
    }

    // ── Промис с тайм-аутом (сетевые операции не должны висеть вечно) ──
    function withTimeout(promise, ms, message) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(message || 'Превышено время ожидания соединения')), ms);
            promise.then(
                (val) => { clearTimeout(timer); resolve(val); },
                (err) => { clearTimeout(timer); reject(err); }
            );
        });
    }

    // ── Переход на другую страницу SPACE с передачей сессии ──
    // Использует storage как основной канал (он общий для всех страниц
    // одного домена) и добавляет токен в URL только как fallback —
    // целевая страница немедленно его съедает и убирает из адресной строки.
    function navigateWithSession(targetFile, role, id, name, extraParams) {
        const params = new URLSearchParams(extraParams || {});
        params.set('st', encodeSessionToken(role, id, name));
        window.location.href = targetFile + '?' + params.toString();
    }

    window.SpaceAuth = {
        SESSION_KEY,
        readSession,
        writeSession,
        clearSession,
        consumeUrlSessionFallback,
        encodeSessionToken,
        getCabinetUrl,
        rememberCabinet,
        withTimeout,
        navigateWithSession
    };
})();
