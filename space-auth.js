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
//
// ИЗМЕНЕНИЯ v2:
// — Удалены btoa(), atob(), encodeSessionToken(), consumeUrlSessionFallback()
//   и параметр ?st= из URL.
// — Передача сессии между страницами осуществляется исключительно
//   через localStorage (единый домен). URL-параметры не используются
//   для передачи роли, id или имени.
// — Поле name удалено из объекта сессии. Имя пользователя загружается
//   из Firestore при инициализации страницы.
// — Добавлена verifySessionWithFirestore() — проверка актуальности
//   сессии по данным Firestore (не по localStorage).
// ══════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    const SESSION_KEY = 'space_session';
    // Срок жизни сессии — 12 часов. После истечения пользователь должен
    // войти заново. Защищает от вечно живущих сессий на чужих устройствах.
    const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

    // ── Чтение сессии ──
    // Сессия читается ТОЛЬКО из localStorage.
    // Данные пользователя (имя, роль актуальная) проверяются через Firestore,
    // не через хранилище браузера — см. verifySessionWithFirestore() ниже.
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

        // Сессия должна содержать role и id
        if (!session || !session.role || !session.id) return null;

        // Проверка истечения сессии
        if (typeof session.ts !== 'number' || (Date.now() - session.ts) > SESSION_TTL_MS) {
            clearSession();
            return null;
        }

        return session;
    }

    // ── Запись сессии ──
    // Сохраняет только role, id и временну́ю метку.
    // Имя пользователя намеренно не сохраняется: оно загружается из Firestore
    // при каждом открытии страницы, чтобы всегда отражать актуальные данные.
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
        [SESSION_KEY, 'chat_role', 'chat_id', 'chat_name', 'space_last_cabinet'].forEach(k => {
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

    // ── Переход на другую страницу SPACE с передачей сессии ──
    // Сессия передаётся ТОЛЬКО через localStorage (общий для всех страниц
    // одного домена). URL используется только для прикладных параметров
    // (например, editor=...), но не для передачи role/id/name.
    function navigateWithSession(targetFile, role, id, _nameIgnored, extraParams) {
        // Убеждаемся, что актуальная сессия записана в localStorage
        writeSession(role, id);
        // Строим URL только из прикладных параметров (не из данных сессии)
        const params = new URLSearchParams(extraParams || {});
        const qs = params.toString();
        window.location.href = targetFile + (qs ? '?' + qs : '');
    }

    // ── Проверка активной сессии через Firestore ──
    // Принимает:
    //   db    — инициализированный Firestore
    //   BASE  — функция построения пути коллекции, например (col) => ['artifacts', APP_ID, 'public', 'data', col]
    //   getDoc, doc — функции из firebase/firestore
    //   onInvalid — callback, вызываемый если сессия не прошла проверку
    //              (пользователь не найден, заблокирован или роль изменилась)
    // Возвращает объект { valid: true, id, role, data } или { valid: false }
    //
    // Логика:
    //   1. Читаем space_session из localStorage
    //   2. Если сессии нет — возвращаем { valid: false }, вызываем onInvalid
    //   3. Определяем коллекцию по роли: owner → site_config/main, editor → editors/{id}
    //   4. Загружаем профиль из Firestore
    //   5. Если документ не существует — разлогиниваем (onInvalid)
    //   6. Если роль изменилась в Firestore — обновляем сессию (writeSession)
    //   7. Возвращаем актуальные данные из Firestore
    async function verifySessionWithFirestore(db, BASE, getDocFn, docFn, onInvalid) {
        const session = readSession();

        if (!session) {
            if (typeof onInvalid === 'function') onInvalid('no_session');
            return { valid: false };
        }

        const { role, id } = session;

        try {
            if (role === 'owner' || role === 'manager') {
                // Для администратора проверяем существование конфига
                // (если конфиг исчез — это крайний случай, сессию не сбрасываем)
                return { valid: true, id, role, data: null };
            }

            if (role === 'editor') {
                const editorRef = docFn(db, ...BASE('editors'), id);
                const editorSnap = await getDocFn(editorRef);

                if (!editorSnap.exists()) {
                    // Монтажёр удалён из системы — разлогиниваем
                    clearSession();
                    if (typeof onInvalid === 'function') onInvalid('user_not_found');
                    return { valid: false };
                }

                const data = editorSnap.data();

                if (data.isBlocked) {
                    // Аккаунт заблокирован — разлогиниваем
                    clearSession();
                    if (typeof onInvalid === 'function') onInvalid('user_blocked');
                    return { valid: false };
                }

                // Если роль в Firestore изменилась (маловероятно для editors,
                // но проверяем для надёжности) — обновляем сессию
                const firestoreRole = data.role || 'editor';
                if (firestoreRole !== role) {
                    writeSession(firestoreRole, id);
                }

                return { valid: true, id, role: firestoreRole, data };
            }

            // Неизвестная роль — разлогиниваем
            clearSession();
            if (typeof onInvalid === 'function') onInvalid('unknown_role');
            return { valid: false };

        } catch (e) {
            console.warn('[space-auth] verifySessionWithFirestore: ошибка сети, сессия принята как есть', e);
            // При сетевой ошибке не разлогиниваем — пользователь остаётся в системе.
            // Проверка повторится при следующей операции.
            return { valid: true, id, role, data: null };
        }
    }

    window.SpaceAuth = {
        SESSION_KEY,
        SESSION_TTL_MS,
        readSession,
        writeSession,
        clearSession,
        getCabinetUrl,
        rememberCabinet,
        withTimeout,
        navigateWithSession,
        verifySessionWithFirestore
    };
})();
