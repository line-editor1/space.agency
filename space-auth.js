// ══════════════════════════════════════════════════════════════════
// SPACE AUTH v4 — Firebase Authentication Email/Password
//
// Архитектура:
//   - Вход через Firebase Auth (signInWithEmailAndPassword / createUserWithEmailAndPassword)
//   - Роль, имя, статус active хранятся в Firestore: users/{uid}
//   - В localStorage НЕ хранится ни роль, ни id, ни имя
//   - Сессия живёт в Firebase Auth (persistence = LOCAL по умолчанию)
//   - space-auth.js подключается как обычный <script> до type="module"
//     и предоставляет вспомогательные функции через window.SpaceAuth
//   - Весь Firestore-доступ делается внутри type="module" в каждом файле
//     (space-auth.js не имеет доступа к Firestore напрямую)
//
// Коллекции Firestore:
//   users/{uid}       — роль, active, editorDocId (для editor)
//   editors/{docId}   — профиль монтажёра (имя, логин, salary и т.д.)
//
// Роли: 'owner' | 'editor'
// Строка 'owner' в notifications.userId — сохраняется как маркер роли,
// не как Firebase UID, для обратной совместимости.
// ══════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    // Единственный localStorage-ключ — для подсказки «в какой ЛК вернуться»
    // из чата. Не содержит role/id/name.
    const CABINET_KEY      = 'space_last_cabinet';
    const OWNER_IMPERSONATE_KEY = 'space_impersonate_editor'; // editorDocId при loginAsEditor

    function rememberCabinet(fileName) {
        try { localStorage.setItem(CABINET_KEY, fileName); } catch (e) {}
    }

    function getCabinetUrl(role) {
        if (role === 'owner')  return 'space_control.html';
        if (role === 'editor') return 'space_team.html';
        try {
            const last = localStorage.getItem(CABINET_KEY);
            if (last === 'space_team.html' || last === 'space_control.html') return last;
        } catch (e) {}
        return 'space_team.html';
    }

    // Сохранить editorDocId когда owner входит «как монтажёр»
    function saveImpersonation(editorDocId) {
        try { localStorage.setItem(OWNER_IMPERSONATE_KEY, editorDocId); } catch (e) {}
    }

    // Прочитать и очистить impersonation
    function consumeImpersonation() {
        try {
            const val = localStorage.getItem(OWNER_IMPERSONATE_KEY);
            localStorage.removeItem(OWNER_IMPERSONATE_KEY);
            return val || null;
        } catch (e) { return null; }
    }

    function hasImpersonation() {
        try { return !!localStorage.getItem(OWNER_IMPERSONATE_KEY); } catch (e) { return false; }
    }

    // Промис с тайм-аутом — сетевые операции не должны висеть вечно
    function withTimeout(promise, ms, message) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(message || 'Превышено время ожидания соединения')),
                ms
            );
            promise.then(
                val => { clearTimeout(timer); resolve(val); },
                err => { clearTimeout(timer); reject(err); }
            );
        });
    }

    window.SpaceAuth = {
        CABINET_KEY,
        OWNER_IMPERSONATE_KEY,
        rememberCabinet,
        getCabinetUrl,
        saveImpersonation,
        consumeImpersonation,
        hasImpersonation,
        withTimeout
    };
})();
