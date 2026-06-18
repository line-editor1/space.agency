// ══════════════════════════════════════════════════════════════════
// SPACE AUTH — единый модуль системы авторизации
// Подключается во всех трёх файлах (chat.html, space_team.html,
// space_control.html).
// Внимание: Сессия хранится ТОЛЬКО в localStorage. 
// Никаких передач данных через URL и использования btoa().
// ══════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    const SESSION_KEY = 'space_session';
    const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

    // ── Чтение сессии ──
    function readSession() {
        let raw = null;
        try {
            raw = localStorage.getItem(SESSION_KEY);
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

        return session;
    }

    // ── Запись сессии ──
    // Сохраняем только УНИКАЛЬНЫЙ ID (editorId или adminId) и роль. Никаких имен.
    function writeSession(role, id) {
        const session = { role, id, ts: Date.now() };
        const raw = JSON.stringify(session);
        try {
            localStorage.setItem(SESSION_KEY, raw);
        } catch (e) {}
        return session;
    }

    // ── Удаление сессии ──
    function clearSession() {
        [SESSION_KEY, 'space_last_cabinet'].forEach(k => {
            try {
                localStorage.removeItem(k);
            } catch (e) {}
        });
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

    // ── Переход на другую страницу SPACE с сохранением сессии ──
    // Больше не используется параметр st в URL. Данные пишутся напрямую в localStorage.
    function navigateWithSession(targetFile, role, id, name, extraParams) {
        writeSession(role, id);
        const params = new URLSearchParams(extraParams || {});
        const qs = params.toString();
        window.location.href = targetFile + (qs ? '?' + qs : '');
    }

    window.SpaceAuth = {
        SESSION_KEY,
        readSession,
        writeSession,
        clearSession,
        getCabinetUrl,
        rememberCabinet,
        withTimeout,
        navigateWithSession
    };
})();