import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
    getFirestore, initializeFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
    collection, getDocs, query, where, orderBy, onSnapshot, limit
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// ─── FIREBASE CONFIG ───
let FB_CONFIG = {
    apiKey: "AIzaSyBYkJnr5fi9EE6BRITTbyQulPwz1BeSP_s",
    authDomain: "space-video-agency.firebaseapp.com",
    projectId: "space-video-agency",
    storageBucket: "space-video-agency.firebasestorage.app",
    messagingSenderId: "591140214223",
    appId: "1:591140214223:web:7bc45a81f66a7181f8eeba"
};

const APP_ID = 'space-video-agency';
const BASE = (col) => ['artifacts', APP_ID, 'public', 'data', col];

// Единая система авторизации SPACE — все функции сессии вынесены в
// общий модуль space-auth.js, подключённый в <head>. Это устраняет
// расхождения логики между chat.html / space_team.html / space_control.html.
const { withTimeout, readSession: readSpaceSession, writeSession: writeSpaceSession,
        clearSession: destroySpaceSession,
        rememberCabinet, navigateWithSession } = window.SpaceAuth;

// Подсказка для chat.html: запоминаем, из какого личного кабинета пришёл
// пользователь, чтобы кнопка "Войти в личный кабинет" в чате вела на
// правильный файл, а не на несуществующую/чужую страницу.
try { rememberCabinet('space_control.html'); } catch(e) {}

const app = initializeApp(FB_CONFIG);
const auth = getAuth(app);
// ВАЖНО: используем автоопределение длинного поллинга вместо WebChannel-стриминга.
// На многих мобильных сетях/операторских прокси стандартное соединение Firestore
// зависает без ошибки (вечный "Подключение к SPACE..."). Long-polling решает это.
const db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false
});

// Сессия теперь хранится в Firestore (см. комментарий в общем модуле
// SpaceAuth) — передаём ему ссылку на db и нужные функции Firestore.
window.SpaceAuth.init(db, { doc, getDoc, setDoc, deleteDoc }, APP_ID);

// Начальное состояние сессии заполняется асинхронно внутри checkSession()
// (вызывается из window.onload), поскольку чтение сессии теперь требует
// обращения к Firestore.
let currentRole = null;
let currentUserId = null;
let currentUserName = null;

let _editors = [];
let _projects = [];
let _submissions = [];
let _notifications = [];
let _editRequests = [];
let _globalChecklist = ["Проверить цветокоррекцию", "Проверить звук", "Проверить субтитры", "Проверить орфографию", "Проверить настройки экспорта"];

let isListenersInitialized = false;
function initRealtimeListeners() {
    if (isListenersInitialized) return;
    isListenersInitialized = true;

    // 1. Editors real-time snapshot
    onSnapshot(collection(db, ...BASE('editors')), (snap) => {
        _editors = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderActiveTabContent();
        updateSidebarAnalytics();
    });

    // 2. Projects real-time snapshot
    onSnapshot(collection(db, ...BASE('projects')), (snap) => {
        _projects = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderActiveTabContent();
        updateSidebarAnalytics();
    });

    // 3. Submissions real-time snapshot
    onSnapshot(collection(db, ...BASE('submissions')), (snap) => {
        _submissions = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderActiveTabContent();
        updateAdminBadges();
    });

    // 4. Edit Requests real-time snapshot
    onSnapshot(collection(db, ...BASE('edit_requests')), (snap) => {
        _editRequests = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderActiveTabContent();
        updateAdminBadges();
    });

    // 5. Notifications real-time snapshot
    onSnapshot(collection(db, ...BASE('notifications')), (snap) => {
        _notifications = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderNotifications();
    });

    // 6. Site Config checklist load
    onSnapshot(doc(db, ...BASE('site_config'), 'main'), (docSnap) => {
        if (docSnap.exists()) {
            const d = docSnap.data();
            if (d.checklist) {
                _globalChecklist = d.checklist;
            }
        }
    });
}

async function checkSession() {
    const session = await readSpaceSession();
    if (session && session.role === 'owner') {
        currentRole = session.role;
        currentUserId = session.id;
        currentUserName = session.name;
        // Возврат в чат после auth-gate
        const _rtParams = new URLSearchParams(window.location.search);
        const _returnTo = _rtParams.get('returnTo');
        if (_returnTo === 'chat.html') {
            const _et = _rtParams.get('editor');
            navigateWithSession('chat.html', _et ? { editor: _et } : {});
            return;
        }
        document.getElementById('screen-login').classList.add('hidden');
        document.getElementById('screen-dashboard').classList.remove('hidden');
        renderSegmentTabs();
        initRealtimeListeners();
    } else {
        document.getElementById('screen-login').classList.remove('hidden');
        document.getElementById('screen-dashboard').classList.add('hidden');
    }
}

// Custom Confirmation Trigger instead of browser-native blockages
window.customConfirm = function(title, message, callback) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    
    const modal = document.getElementById('custom-confirm-modal');
    modal.classList.remove('hidden');
    
    const onCancel = () => {
        modal.classList.add('hidden');
        cleanup();
    };
    const onOk = () => {
        modal.classList.add('hidden');
        cleanup();
        callback();
    };
    const cleanup = () => {
        document.getElementById('confirm-cancel-btn').removeEventListener('click', onCancel);
        document.getElementById('confirm-ok-btn').removeEventListener('click', onOk);
    };
    
    document.getElementById('confirm-cancel-btn').addEventListener('click', onCancel);
    document.getElementById('confirm-ok-btn').addEventListener('click', onOk);
};

window.addExtraServiceRow = function(name = '', price = '') {
    const container = document.getElementById('p-extra-services-container');
    if (!container) return;
    const rowId = 'es-row-' + Date.now() + Math.random().toString(36).substr(2, 5);
    const row = document.createElement('div');
    row.className = "flex gap-2 items-center";
    row.id = rowId;

    row.innerHTML = `
        <input type="text" class="es-service-name flex-1 bg-black/40 border border-white/5 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-indigo-500/30" placeholder="Название услуги" value="${escapeHtml(name)}">
        <input type="number" class="es-price-input w-24 bg-black/40 border border-white/5 rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-indigo-500/30" placeholder="Цена ₽" value="${price || ''}" oninput="recalculateExtraSalaryTotal()">
        <button type="button" onclick="document.getElementById('${rowId}').remove(); recalculateExtraSalaryTotal();" class="pressable w-8 h-8 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/20 flex items-center justify-center flex-shrink-0 transition-all"><i class="fas fa-trash text-[10px]"></i></button>
    `;
    container.appendChild(row);
};

window.recalculateExtraSalaryTotal = function() {
    const prices = document.querySelectorAll('.es-price-input');
    let sum = 0;
    prices.forEach(p => { sum += parseFloat(p.value) || 0; });
    document.getElementById('p-editor-extra-salary').value = sum;
};

// Client extra services row generator inside the Project Modal
window.addClientExtraServiceRow = function(name = '', price = '') {
    const container = document.getElementById('p-client-extra-services-container');
    if (!container) return;
    const rowId = 'ces-row-' + Date.now() + Math.random().toString(36).substr(2, 5);
    const row = document.createElement('div');
    row.className = "flex gap-2 items-center";
    row.id = rowId;

    row.innerHTML = `
        <input type="text" class="ces-service-name flex-1 bg-black/40 border border-white/5 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-indigo-500/30" placeholder="Название услуги" value="${escapeHtml(name)}">
        <input type="number" class="ces-price-input w-24 bg-black/40 border border-white/5 rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-indigo-500/30" placeholder="Цена ₽" value="${price || ''}" oninput="recalculateClientExtraSalaryTotal()">
        <button type="button" onclick="document.getElementById('${rowId}').remove(); recalculateClientExtraSalaryTotal();" class="pressable w-8 h-8 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/20 flex items-center justify-center flex-shrink-0 transition-all"><i class="fas fa-trash text-[10px]"></i></button>
    `;
    container.appendChild(row);
};

window.recalculateClientExtraSalaryTotal = function() {
    const prices = document.querySelectorAll('.ces-price-input');
    let sum = 0;
    prices.forEach(p => { sum += parseFloat(p.value) || 0; });
    document.getElementById('p-client-extra-salary').value = sum;
};

// Penalty (штраф) row generator inside the Project Modal — Editor salary section
window.addPenaltyRow = function(name = '', value = '', type = 'rub') {
    const container = document.getElementById('p-penalties-container');
    if (!container) return;
    const rowId = 'pen-row-' + Date.now() + Math.random().toString(36).substr(2, 5);
    const row = document.createElement('div');
    row.className = "flex gap-2 items-center";
    row.id = rowId;

    row.innerHTML = `
        <input type="text" class="pen-name flex-1 bg-black/40 border border-white/5 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-rose-500/30" placeholder="За что штраф" value="${escapeHtml(name)}" oninput="recalculatePenaltyTotal()">
        <input type="number" class="pen-value w-20 bg-black/40 border border-white/5 rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-rose-500/30" placeholder="0" value="${value || ''}" oninput="recalculatePenaltyTotal()">
        <select class="pen-type w-16 bg-black/40 border border-white/5 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-rose-500/30" onchange="recalculatePenaltyTotal()">
            <option value="rub" ${type === 'rub' ? 'selected' : ''}>₽</option>
            <option value="percent" ${type === 'percent' ? 'selected' : ''}>%</option>
        </select>
        <button type="button" onclick="document.getElementById('${rowId}').remove(); recalculatePenaltyTotal();" class="pressable w-8 h-8 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/20 flex items-center justify-center flex-shrink-0 transition-all"><i class="fas fa-trash text-[10px]"></i></button>
    `;
    container.appendChild(row);
    recalculatePenaltyTotal();
};

window.recalculatePenaltyTotal = function() {
    const container = document.getElementById('p-penalties-container');
    if (!container) return;
    const base = parseFloat(document.getElementById('p-editor-salary')?.value) || 0;
    let sum = 0;
    Array.from(container.children).forEach(row => {
        const valInput = row.querySelector('.pen-value');
        const typeSelect = row.querySelector('.pen-type');
        if (!valInput) return;
        const val = parseFloat(valInput.value) || 0;
        if (typeSelect && typeSelect.value === 'percent') {
            sum += base * (val / 100);
        } else {
            sum += val;
        }
    });
    const totalEl = document.getElementById('p-editor-penalty-total');
    if (totalEl) totalEl.value = sum;
};

const stageLabels = {
    brief: "ТЗ & Бриф",
    edit: "Черновик",
    effects: "Звук & FX",
    color: "Цвет",
    done: "Сдача"
};

let activeTab = 'dashboard';
let selectedDashboardEditorId = 'all';

window.getEditorRating = function(editorId) {
    const completedProjects = _projects.filter(p => p.editorId === editorId && p.stage === 'done' && typeof p.rating === 'number' && p.rating > 0);
    if (completedProjects.length === 0) return '0.0';
    const sum = completedProjects.reduce((acc, p) => acc + p.rating, 0);
    return (sum / completedProjects.length).toFixed(1);
};

window.getEditorPayout = function(p) {
    const base = parseFloat(p.editorSalary) || 0;
    let extra = parseFloat(p.editorExtraSalary) || 0;
    if (p.editorExtraServices && Array.isArray(p.editorExtraServices)) {
        extra = p.editorExtraServices.reduce((sum, item) => sum + (parseFloat(item.price) || 0), 0);
    }
    const bVal = parseFloat(p.editorBonusValue) || 0;
    let bonus = 0;
    if (p.editorBonusType === 'percent') {
        bonus = base * (bVal / 100);
    } else {
        bonus = bVal;
    }
    let penalty = 0;
    if (p.editorPenalties && Array.isArray(p.editorPenalties)) {
        penalty = p.editorPenalties.reduce((sum, item) => {
            const val = parseFloat(item.value) || 0;
            return sum + (item.type === 'percent' ? base * (val / 100) : val);
        }, 0);
    }
    return base + extra + bonus - penalty;
};

window.getProjectIncome = function(p) {
    let base = parseFloat(p.baseSalary) || parseFloat(p.basePrice) || 0;
    let extra = 0;
    if (p.clientExtraServices && Array.isArray(p.clientExtraServices)) {
        extra = p.clientExtraServices.reduce((sum, item) => sum + (parseFloat(item.price) || 0), 0);
    } else {
        extra = parseFloat(p.extraSalary) || 0;
    }
    return base + extra;
};

let deferredPrompt;

function setupPWA() {
    if (window.location.protocol === 'file:' || window.location.host.includes('usercontent.goog') || window.location.host.includes('googleusercontent.com')) {
        return;
    }

    const manifestObj = {
        "name": "SPACE CONTROL",
        "short_name": "SPACE",
        "start_url": ".",
        "display": "standalone",
        "background_color": "#030208",
        "theme_color": "#030208",
        "icons": [{ "src": "1000002719.png", "sizes": "512x512", "type": "image/png" }]
    };
    const blob = new Blob([JSON.stringify(manifestObj)], {type: 'application/json'});
    const manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    manifestLink.href = URL.createObjectURL(blob);
    document.head.appendChild(manifestLink);

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        const installSection = document.getElementById('profile-pwa-install-section');
        if (installSection) installSection.classList.remove('hidden');
        
        // Исправлено: PWA-баннер отображается корректно и на десктопе (ПК)
        const banner = document.getElementById('pwa-install-banner');
        if (banner) {
            banner.classList.remove('hidden');
            setTimeout(() => {
                banner.classList.remove('translate-y-10', 'opacity-0');
            }, 100);
        }
    });
}

window.dismissPwaInstall = function() {
    const banner = document.getElementById('pwa-install-banner');
    if (banner) {
        banner.classList.add('transform', 'translate-y-10', 'opacity-0');
        setTimeout(() => banner.classList.add('hidden'), 500);
    }
};

window.triggerPwaInstall = async function() {
    if (!deferredPrompt) { return; }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    dismissPwaInstall();
};

window.openChatLink = function(editorId) {
    if (editorId) { localStorage.setItem('target_editor_id', editorId); }
    else { localStorage.removeItem('target_editor_id'); }

    const extra = {};
    if (editorId) extra.editor = editorId;

    navigateWithSession('chat.html', extra);
};

// "Войти от имени монтажёра" — доступно только уже аутентифицированному
// администратору (owner). Создаём новую сессию монтажёра в Firestore и
// переходим в его кабинет — localStorage общий для всех страниц домена,
// поэтому никакой передачи роли/id через URL не требуется.
window.loginAsEditor = async function(id) {
    if (currentRole !== 'owner') {
        showToast('Недостаточно прав для этого действия', 'error');
        return;
    }
    const ed = _editors.find(e => e.id === id);
    const edName = ed ? (ed.name || ed.login || '') : '';
    try {
        await writeSpaceSession('editor', id, edName);
        navigateWithSession('space_team.html');
    } catch (e) {
        console.error('Не удалось создать сессию монтажёра:', e);
        showToast('Не удалось войти в кабинет монтажёра', 'error');
    }
};

async function ensureAuth() {
    return new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(auth, user => {
            unsubscribe();
            if (user) {
                resolve(user);
            } else {
                signInAnonymously(auth)
                    .then(cred => resolve(cred.user))
                    .catch(err => {
                        console.error("Firebase Anonymous Auth error:", err);
                        resolve(null); // Разрешаем поток без вечного зависания страницы
                    });
            }
        }, error => {
            console.error("onAuthStateChanged error:", error);
            resolve(null);
        });
    });
}

async function triggerLoader(welcomeName) {
    const loader = document.getElementById('screen-loader');
    const bar = document.getElementById('loader-progress-bar');
    const textStatus = document.getElementById('loader-status-text');
    
    loader.classList.remove('pointer-events-none');
    loader.classList.add('opacity-100');
    
    const steps = [
        { progress: '30%', text: 'Авторизация доступа...' },
        { progress: '70%', text: 'Загрузка рабочей среды...' },
        { progress: '100%', text: 'Система SPACE активна!' }
    ];

    for (let i = 0; i < steps.length; i++) {
        await new Promise(r => setTimeout(r, 250));
        bar.style.width = steps[i].progress;
        textStatus.textContent = steps[i].text;
    }
    
    await new Promise(r => setTimeout(r, 200));
    loader.classList.remove('opacity-100');
    loader.classList.add('opacity-0', 'pointer-events-none');
}

window.executeLogin = async function() {
    try {
        const login = document.getElementById('login-input').value.trim();
        const pass = document.getElementById('pass-input').value;
        if (!login || !pass) { showToast('Заполните данные', 'error'); return; }

        if (typeof CryptoJS === 'undefined') {
            showToast('Идет загрузка компонентов шифрования. Повторите попытку через секунду.', 'error');
            return;
        }

        const hash = CryptoJS.SHA256(pass).toString();
        const submitBtn = document.getElementById('login-submit-btn');

        if (submitBtn) { submitBtn.disabled = true; }
        showToast('Подключение к SPACE...', 'info');

        await withTimeout(ensureAuth(), 12000, 'Не удалось установить соединение');
        const configRef = doc(db, ...BASE('site_config'), 'main');
        const configSnap = await withTimeout(getDoc(configRef), 12000, 'Сервер не отвечает');

        const hasCredentials = configSnap.exists() && configSnap.data().ownerLogin && configSnap.data().adminPassHash;

        if (!hasCredentials) {
            await withTimeout(
                setDoc(configRef, { ownerLogin: login, adminPassHash: hash }, { merge: true }),
                12000,
                'Не удалось сохранить учётные данные'
            );
            await triggerLoader('Администратор');
            await setSession('owner', 'owner', 'Администратор SPACE');
            showToast('Учётные данные администратора заданы', 'success');
            return;
        }

        const expectedLogin = configSnap.data().ownerLogin;
        const expectedHash = configSnap.data().adminPassHash;

        if (login === expectedLogin && hash === expectedHash) {
            await triggerLoader('Администратор');
            await setSession('owner', 'owner', 'Администратор SPACE');
        } else {
            showToast('Неверные учетные данные администратора', 'error');
        }
    } catch(e) {
        console.error("Login sequence crash:", e);
        showToast('Произошла ошибка при попытке войти. Подробности в консоли.', 'error');
    } finally {
        const submitBtn = document.getElementById('login-submit-btn');
        if (submitBtn) { submitBtn.disabled = false; }
    }
};

async function setSession(role, id, name) {
    const s = await writeSpaceSession(role, id, name);
    currentRole = s.role;
    currentUserId = s.id;
    currentUserName = s.name;

    // Возврат в чат после auth-gate
    const _rtParams = new URLSearchParams(window.location.search);
    const _returnTo = _rtParams.get('returnTo');
    if (_returnTo === 'chat.html') {
        const _et = _rtParams.get('editor');
        navigateWithSession('chat.html', _et ? { editor: _et } : {});
        return;
    }
    document.getElementById('screen-login').classList.add('hidden');
    document.getElementById('screen-dashboard').classList.remove('hidden');
    renderSegmentTabs();
    initRealtimeListeners();
}

window.logout = async function() {
    try { await destroySpaceSession(); } catch (e) { console.warn('Не удалось удалить сессию на сервере:', e); }
    currentRole = null; currentUserId = null; currentUserName = null;
    document.getElementById('screen-dashboard').classList.add('hidden');
    document.getElementById('screen-login').classList.remove('hidden');
};

function updateActiveTabHeader(tabName) {
    const tabsData = {
        dashboard: { icon: 'fa-chart-pie text-indigo-400', text: 'Главная' },
        projects: { icon: 'fa-video text-blue-400', text: 'Проекты' },
        clients: { icon: 'fa-id-card-clip text-pink-400', text: 'Клиенты' },
        editors: { icon: 'fa-scissors text-amber-400', text: 'Монтажёры' },
        submissions: { icon: 'fa-circle-check text-emerald-400', text: 'Приёмка' },
        requests: { icon: 'fa-code-pull-request text-purple-400', text: 'Запросы' },
        archive: { icon: 'fa-box-archive text-slate-400', text: 'Архив' },
        finances: { icon: 'fa-wallet text-cyan-400', text: 'Финансы' }
    };
    const current = tabsData[tabName] || tabsData['dashboard'];
    
    const mobileMiddle = document.getElementById('mobile-header-title-bubble');
    if (mobileMiddle) {
        mobileMiddle.innerHTML = `
            <div class="w-6 h-6 rounded-full flex items-center justify-center bg-white/[0.04] shrink-0">
                <i class="fas ${current.icon} text-[10px]"></i>
            </div>
            <span class="text-xs font-bold text-white font-space truncate">${current.text}</span>
        `;
    }

    const desktopMiddle = document.getElementById('desktop-header-title-bubble');
    if (desktopMiddle) {
        desktopMiddle.innerHTML = `
            <i class="fas ${current.icon} text-xs"></i>
            <span class="text-white uppercase tracking-wider text-[10px]">${current.text}</span>
        `;
    }
}

window.switchTab = function(tabName) {
    activeTab = tabName;
    
    // Desktop navigation updating
    document.querySelectorAll('#dashboard-tabs-container .tab-segment').forEach(btn => {
        btn.classList.toggle('active', btn.id === 'tab-' + tabName);
        btn.classList.toggle('text-white', btn.id === 'tab-' + tabName);
        btn.classList.toggle('text-slate-400', btn.id !== 'tab-' + tabName);
    });

    // Mobile navigation updating
    document.querySelectorAll('#mobile-tabs-container .tab-segment').forEach(btn => {
        btn.classList.toggle('active', btn.id === 'm-tab-' + tabName);
        btn.classList.toggle('text-white', btn.id === 'm-tab-' + tabName);
        btn.classList.toggle('text-slate-400', btn.id !== 'm-tab-' + tabName);
    });

    updateActiveTabHeader(tabName);
    renderActiveTabContent();
};

window.toggleMobileMenu = function(open) {
    const el = document.getElementById('mobile-menu-overlay');
    if (!el) return;
    if (open) {
        el.classList.remove('-translate-x-full');
    } else {
        el.classList.add('-translate-x-full');
    }
};

function renderSegmentTabs() {
    const container = document.getElementById('dashboard-tabs-container');
    const mobileContainer = document.getElementById('mobile-tabs-container');
    
    const tabsHTML = `
        <button onclick="switchTab('dashboard')" id="tab-dashboard" class="tab-segment shrink-0 py-3 px-4 text-[10px] sm:text-xs font-bold font-space rounded-xl text-slate-400 hover:text-white transition-all flex items-center gap-2 w-full justify-start">
            <i class="fas fa-chart-pie text-sm text-indigo-400"></i>
            <span>Главная</span>
        </button>
        <button onclick="switchTab('projects')" id="tab-projects" class="tab-segment shrink-0 py-3 px-4 text-[10px] sm:text-xs font-bold font-space rounded-xl text-slate-400 hover:text-white transition-all flex items-center gap-2 w-full justify-start">
            <i class="fas fa-video text-sm text-blue-400"></i>
            <span>Проекты</span>
        </button>
        <button onclick="switchTab('clients')" id="tab-clients" class="tab-segment shrink-0 py-3 px-4 text-[10px] sm:text-xs font-bold font-space rounded-xl text-slate-400 hover:text-white transition-all flex items-center gap-2 w-full justify-start">
            <i class="fas fa-id-card-clip text-sm text-pink-400"></i>
            <span>Клиенты / Проекты</span>
        </button>
        <button onclick="switchTab('editors')" id="tab-editors" class="tab-segment shrink-0 py-3 px-4 text-[10px] sm:text-xs font-bold font-space rounded-xl text-slate-400 hover:text-white transition-all flex items-center gap-2 w-full justify-start">
            <i class="fas fa-scissors text-sm text-amber-400"></i>
            <span>Монтажёры</span>
        </button>
        <button onclick="switchTab('submissions')" id="tab-submissions" class="tab-segment shrink-0 py-3 px-4 text-[10px] sm:text-xs font-bold font-space rounded-xl text-slate-400 hover:text-white transition-all flex items-center gap-2 w-full justify-start relative">
            <i class="fas fa-circle-check text-sm text-emerald-400"></i>
            <span>Приёмка</span>
            <span id="badge-subs" class="hidden absolute top-2 right-2 w-2 h-2 bg-indigo-500 rounded-full status-led"></span>
        </button>
        <button onclick="switchTab('requests')" id="tab-requests" class="tab-segment shrink-0 py-3 px-4 text-[10px] sm:text-xs font-bold font-space rounded-xl text-slate-400 hover:text-white transition-all flex items-center gap-2 w-full justify-start relative">
            <i class="fas fa-code-pull-request text-sm text-purple-400"></i>
            <span>Запросы</span>
            <span id="badge-reqs" class="hidden absolute top-2 right-2 w-2 h-2 bg-indigo-500 rounded-full status-led"></span>
        </button>
        <button onclick="switchTab('archive')" id="tab-archive" class="tab-segment shrink-0 py-3 px-4 text-[10px] sm:text-xs font-bold font-space rounded-xl text-slate-400 hover:text-white transition-all flex items-center gap-2 w-full justify-start">
            <i class="fas fa-box-archive text-sm text-slate-400"></i>
            <span>Архив</span>
        </button>
        <button onclick="switchTab('finances')" id="tab-finances" class="tab-segment shrink-0 py-3 px-4 text-[10px] sm:text-xs font-bold font-space rounded-xl text-slate-400 hover:text-white transition-all flex items-center gap-2 w-full justify-start">
            <i class="fas fa-wallet text-sm text-cyan-400"></i>
            <span>Финансы</span>
        </button>
    `;
    container.innerHTML = tabsHTML;

    // Build Mobile menu layout
    const mobileTabsHTML = `
        <button onclick="switchTab('dashboard'); toggleMobileMenu(false);" id="m-tab-dashboard" class="tab-segment py-4 px-3 text-xs font-bold font-space rounded-2xl text-slate-400 hover:text-white transition-all flex flex-col items-center justify-center gap-2 bg-white/[0.02] border border-white/[0.04]">
            <i class="fas fa-chart-pie text-lg text-indigo-400"></i>
            <span>Главная</span>
        </button>
        <button onclick="switchTab('projects'); toggleMobileMenu(false);" id="m-tab-projects" class="tab-segment py-4 px-3 text-xs font-bold font-space rounded-2xl text-slate-400 hover:text-white transition-all flex flex-col items-center justify-center gap-2 bg-white/[0.02] border border-white/[0.04]">
            <i class="fas fa-video text-lg text-blue-400"></i>
            <span>Проекты</span>
        </button>
        <button onclick="switchTab('clients'); toggleMobileMenu(false);" id="m-tab-clients" class="tab-segment py-4 px-3 text-xs font-bold font-space rounded-2xl text-slate-400 hover:text-white transition-all flex flex-col items-center justify-center gap-2 bg-white/[0.02] border border-white/[0.04]">
            <i class="fas fa-id-card-clip text-lg text-pink-400"></i>
            <span>Клиенты</span>
        </button>
        <button onclick="switchTab('editors'); toggleMobileMenu(false);" id="m-tab-editors" class="tab-segment py-4 px-3 text-xs font-bold font-space rounded-2xl text-slate-400 hover:text-white transition-all flex flex-col items-center justify-center gap-2 bg-white/[0.02] border border-white/[0.04]">
            <i class="fas fa-scissors text-lg text-amber-400"></i>
            <span>Монтажёры</span>
        </button>
        <button onclick="switchTab('submissions'); toggleMobileMenu(false);" id="m-tab-submissions" class="tab-segment py-4 px-3 text-xs font-bold font-space rounded-2xl text-slate-400 hover:text-white transition-all flex flex-col items-center justify-center gap-2 bg-white/[0.02] border border-white/[0.04] relative">
            <i class="fas fa-circle-check text-lg text-emerald-400"></i>
            <span>Приёмка</span>
            <span id="badge-subs-mobile" class="hidden absolute top-3 right-3 w-2 h-2 bg-indigo-500 rounded-full status-led"></span>
        </button>
        <button onclick="switchTab('requests'); toggleMobileMenu(false);" id="m-tab-requests" class="tab-segment py-4 px-3 text-xs font-bold font-space rounded-2xl text-slate-400 hover:text-white transition-all flex flex-col items-center justify-center gap-2 bg-white/[0.02] border border-white/[0.04] relative">
            <i class="fas fa-code-pull-request text-lg text-purple-400"></i>
            <span>Запросы</span>
            <span id="badge-reqs-mobile" class="hidden absolute top-3 right-3 w-2 h-2 bg-indigo-500 rounded-full status-led"></span>
        </button>
        <button onclick="switchTab('archive'); toggleMobileMenu(false);" id="m-tab-archive" class="tab-segment py-4 px-3 text-xs font-bold font-space rounded-2xl text-slate-400 hover:text-white transition-all flex flex-col items-center justify-center gap-2 bg-white/[0.02] border border-white/[0.04]">
            <i class="fas fa-box-archive text-lg text-slate-400"></i>
            <span>Архив</span>
        </button>
        <button onclick="switchTab('finances'); toggleMobileMenu(false);" id="m-tab-finances" class="tab-segment py-4 px-3 text-xs font-bold font-space rounded-2xl text-slate-400 hover:text-white transition-all flex flex-col items-center justify-center gap-2 bg-white/[0.02] border border-white/[0.04]">
            <i class="fas fa-wallet text-lg text-cyan-400"></i>
            <span>Финансы</span>
        </button>
    `;
    mobileContainer.innerHTML = mobileTabsHTML;

    switchTab(activeTab);
}

function renderActiveTabContent() {
    if (activeTab === 'dashboard') renderAdminDashboard();
    else if (activeTab === 'projects') renderAdminProjects();
    else if (activeTab === 'clients') renderAdminClients();
    else if (activeTab === 'editors') renderAdminEditors();
    else if (activeTab === 'submissions') renderAdminSubmissions();
    else if (activeTab === 'requests') renderAdminRequests();
    else if (activeTab === 'archive') renderAdminArchive();
    else if (activeTab === 'finances') renderAdminFinances();
}

window.deleteProject = async function(id) {
    customConfirm('Удаление проекта', 'Вы уверены, что хотите удалить этот проект? Это действие необратимо.', async () => {
        try {
            await ensureAuth();
            await deleteDoc(doc(db, ...BASE('projects'), id));
            showToast('Проект удален', 'success');
        } catch (e) {
            showToast('Ошибка удаления проекта', 'error');
        }
    });
};

window.filterAdminDashboardByEditor = function(val) {
    selectedDashboardEditorId = val;
    renderAdminDashboard();
};

function updateSidebarAnalytics() {
    const container = document.getElementById('consolidated-analytics-grid');
    const mobileContainer = document.getElementById('mobile-analytics-grid');
    if (!container && !mobileContainer) return;

    const active = _projects.filter(p => p.stage !== 'done').length;
    const closed = _projects.filter(p => p.stage === 'done').length;
    
    let totalIncome = 0;
    let totalPayout = 0;
    _projects.forEach(p => {
        if (p.stage === 'done') {
            totalIncome += getProjectIncome(p);
            totalPayout += getEditorPayout(p);
        }
    });
    const profit = totalIncome - totalPayout;

    const html = `
        <div class="bg-white/[0.02] border border-white/[0.04] p-3 rounded-2xl">
            <span class="block text-[8px] text-slate-500 uppercase tracking-widest">Проекты в работе</span>
            <span class="text-sm font-bold text-white font-space font-mono mt-1 block">${active}</span>
        </div>
        <div class="bg-white/[0.02] border border-white/[0.04] p-3 rounded-2xl">
            <span class="block text-[8px] text-slate-500 uppercase tracking-widest">Завершено</span>
            <span class="text-sm font-bold text-emerald-400 font-space font-mono mt-1 block">${closed}</span>
        </div>
        <div class="bg-indigo-500/5 border border-indigo-500/10 p-3 rounded-2xl col-span-2 md:col-span-1">
            <span class="block text-[8px] text-indigo-300 uppercase tracking-widest">Чистая Прибыль</span>
            <span class="text-sm font-bold text-emerald-400 font-space font-mono mt-1 block">${formatMoney(profit)}</span>
        </div>
    `;

    if (container) container.innerHTML = html;
    if (mobileContainer) mobileContainer.innerHTML = html;
}

function renderAdminDashboard() {
    const vp = document.getElementById('dashboard-viewport');
    
    let activeP = _projects.filter(p => p.stage !== 'done').length;
    let reviewP = _projects.filter(p => p.progress === 99).length;
    let totalIncome = 0;
    let totalPayout = 0;

    _projects.forEach(p => {
        if (p.stage === 'done') {
            totalPayout += getEditorPayout(p); 
            totalIncome += getProjectIncome(p); 
        }
    });

    let profit = totalIncome - totalPayout;

    vp.innerHTML = `
        <div class="fade-in-up space-y-6">
            <div class="flex items-center justify-between">
                <h3 class="text-xs font-space font-bold text-slate-400 uppercase tracking-widest"><i class="fas fa-satellite mr-2 text-indigo-400 animate-pulse"></i> Мониторинг агентства</h3>
                <span class="text-[10px] text-slate-500 font-mono">Система работает стабильно</span>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
                <div class="glass-card premium-border p-6 rounded-3xl flex flex-col justify-between">
                    <span class="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Активные контракты</span>
                    <div class="text-4xl font-black font-space text-white mt-3">${activeP}</div>
                    <div class="text-[10px] text-amber-400 mt-2 font-bold"><i class="fas fa-exclamation-circle mr-1"></i> ${reviewP} на проверке</div>
                </div>
                
                <div class="glass-card premium-border p-6 rounded-3xl flex flex-col justify-between">
                    <span class="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Фонд выплат штату</span>
                    <div class="text-3xl font-black font-mono text-rose-400 mt-3">${formatMoney(totalPayout)}</div>
                    <div class="text-[10px] text-emerald-400 mt-2 font-bold"><i class="fas fa-calendar-check mr-1"></i> Завершённые</div>
                </div>

                <div class="glass-card premium-border p-6 rounded-3xl bg-gradient-to-br from-indigo-950/20 to-transparent flex flex-col justify-between">
                    <span class="text-[10px] text-indigo-300 font-bold uppercase tracking-wider">Чистая прибыль</span>
                    <div class="text-4xl font-black font-mono text-emerald-400 mt-3">${formatMoney(profit)}</div>
                    <div class="text-[10px] text-emerald-500 mt-2 font-bold"><i class="fas fa-chart-line mr-1"></i> Чистая прибыль</div>
                </div>
            </div>

            <div class="mt-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-t border-white/[0.04] pt-6">
                <div class="space-y-1">
                    <h3 class="text-xs font-space font-bold text-slate-400 uppercase tracking-widest">Проекты на сборке</h3>
                    <p class="text-[10px] text-slate-500">Последние назначенные задачи</p>
                </div>
                
                <div class="flex items-center gap-2 bg-black/40 border border-white/5 px-3 py-1.5 rounded-xl text-xs">
                    <span class="text-[9px] text-slate-500 uppercase tracking-wider font-bold">Монтажёр:</span>
                    <select id="admin-dashboard-editor-filter" onchange="filterAdminDashboardByEditor(this.value)" class="bg-[#030208] border border-white/5 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-indigo-500/30 cursor-pointer">
                        <option value="all">Показать всех</option>
                        ${_editors.map(e => `<option value="${e.id}" ${selectedDashboardEditorId === e.id ? 'selected' : ''}>${escapeHtml(e.name || e.login)}</option>`).join('')}
                    </select>
                </div>
            </div>

            <div id="admin-mini-projects" class="grid grid-cols-1 md:grid-cols-2 gap-5 mt-4"></div>
        </div>
    `;

    const miniList = document.getElementById('admin-mini-projects');
    let recent = _projects.sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));
    if (selectedDashboardEditorId !== 'all') {
        recent = recent.filter(p => p.editorId === selectedDashboardEditorId);
    }
    
    const slicedRecent = recent.slice(0, 4);
    if (slicedRecent.length === 0) {
        miniList.className = "block";
        miniList.innerHTML = `
            <div class="glass-card premium-border p-10 rounded-3xl text-center space-y-3">
                <i class="fas fa-box-open text-slate-500 text-2xl"></i>
                <h4 class="text-sm font-bold font-space text-slate-300">Список проектов пуст</h4>
            </div>
        `;
    } else {
        miniList.className = "grid grid-cols-1 md:grid-cols-2 gap-5 mt-4";
        miniList.innerHTML = slicedRecent.map(p => generateProjectCardHTML(p)).join('');
    }
}

function renderAdminProjects() {
    const list = document.getElementById('dashboard-viewport');
    list.innerHTML = `
        <div class="fade-in-up space-y-6">
            <div class="flex items-center justify-between">
                <h3 class="text-xs font-space font-bold text-slate-400 uppercase tracking-widest">Список активных проектов</h3>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
                ${_projects.filter(p=>p.stage !== 'done').map(p => generateProjectCardHTML(p)).join('') || `
                    <div class="glass-card premium-border p-10 rounded-3xl text-center text-xs text-slate-500 col-span-2">
                        Активных проектов не найдено. Чтобы создать, воспользуйтесь формой во вкладке "Клиенты".
                    </div>
                `}
            </div>
        </div>
    `;
}

function renderAdminArchive() {
    const list = document.getElementById('dashboard-viewport');
    const doneProjects = _projects.filter(p => p.stage === 'done');
    list.innerHTML = `
        <div class="fade-in-up space-y-6">
            <div class="flex items-center justify-between">
                <h3 class="text-xs font-space font-bold text-slate-400 uppercase tracking-widest"><i class="fas fa-archive text-indigo-400 mr-2"></i> Архив проектов</h3>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
                ${doneProjects.map(p => generateProjectCardHTML(p)).join('') || `
                    <div class="glass-card premium-border p-10 rounded-3xl text-center text-xs text-slate-500 col-span-2">
                        Нет завершённых проектов
                    </div>
                `}
            </div>
        </div>
    `;
}

// Открытие модалки детализации финансов
window.openFinanceDetails = function(id) {
    const p = _projects.find(proj => proj.id === id);
    if (!p) return;

    document.getElementById('finance-details-title').textContent = p.projectName || 'Отчет';
    document.getElementById('finance-details-project').textContent = p.clientName || 'Клиент';

    const clientBase = parseFloat(p.baseSalary) || parseFloat(p.basePrice) || 0;
    document.getElementById('f-client-base').textContent = formatMoney(clientBase);

    // Отрисовка списка дополнительных услуг клиента
    const clientAddonsList = document.getElementById('f-client-addons-list');
    clientAddonsList.innerHTML = '';
    let clientAddonsSum = 0;
    if (p.clientExtraServices && Array.isArray(p.clientExtraServices)) {
        p.clientExtraServices.forEach(item => {
            clientAddonsSum += parseFloat(item.price) || 0;
            const row = document.createElement('div');
            row.className = "flex justify-between text-xs text-slate-400 pl-2 border-l border-indigo-500/20";
            row.innerHTML = `<span>+ ${escapeHtml(item.name)}:</span><span class="font-mono text-white">${formatMoney(item.price)}</span>`;
            clientAddonsList.appendChild(row);
        });
    } else {
        const extraIncome = parseFloat(p.extraSalary) || 0;
        if (extraIncome > 0) {
            clientAddonsSum = extraIncome;
            const row = document.createElement('div');
            row.className = "flex justify-between text-xs text-slate-400 pl-2 border-l border-indigo-500/20";
            row.innerHTML = `<span>+ Дополнительные платежи:</span><span class="font-mono text-white">${formatMoney(extraIncome)}</span>`;
            clientAddonsList.appendChild(row);
        }
    }
    
    if (clientAddonsList.children.length === 0) {
        clientAddonsList.innerHTML = '<span class="text-[10px] text-slate-600 italic">Дополнительные услуги не заказывались</span>';
    }

    const clientTotal = clientBase + clientAddonsSum;
    document.getElementById('f-client-total').textContent = formatMoney(clientTotal);

    // Данные монтажёра
    const editor = _editors.find(e => e.id === p.editorId);
    document.getElementById('f-editor-name').textContent = editor ? (editor.name || editor.login) : 'Не назначен';

    const editorBase = parseFloat(p.editorSalary) || 0;
    document.getElementById('f-editor-base').textContent = formatMoney(editorBase);

    // Расчет бонуса монтажёра
    const bonusValue = parseFloat(p.editorBonusValue) || 0;
    let bonusAmount = 0;
    let bonusLabel = 'нет';
    if (bonusValue > 0) {
        if (p.editorBonusType === 'percent') {
            bonusAmount = editorBase * (bonusValue / 100);
            bonusLabel = `${p.editorBonusName || 'Бонус'}: ${bonusValue}%`;
        } else {
            bonusAmount = bonusValue;
            bonusLabel = p.editorBonusName || 'Фикс';
        }
    }
    document.getElementById('f-editor-bonus-desc').textContent = bonusLabel;
    document.getElementById('f-editor-bonus-val').textContent = formatMoney(bonusAmount);

    // Дополнительные услуги монтажёра
    const editorAddonsList = document.getElementById('f-editor-addons-list');
    editorAddonsList.innerHTML = '';
    let editorAddonsSum = 0;
    if (p.editorExtraServices && Array.isArray(p.editorExtraServices)) {
        p.editorExtraServices.forEach(item => {
            editorAddonsSum += parseFloat(item.price) || 0;
            const row = document.createElement('div');
            row.className = "flex justify-between text-xs text-slate-400 pl-2 border-l border-emerald-500/20";
            row.innerHTML = `<span>+ ${escapeHtml(item.name)}:</span><span class="font-mono text-white">${formatMoney(item.price)}</span>`;
            editorAddonsList.appendChild(row);
        });
    } else {
        const extraSalary = parseFloat(p.editorExtraSalary) || 0;
        if (extraSalary > 0) {
            editorAddonsSum = extraSalary;
            const row = document.createElement('div');
            row.className = "flex justify-between text-xs text-slate-400 pl-2 border-l border-emerald-500/20";
            row.innerHTML = `<span>+ Согласованные доплаты:</span><span class="font-mono text-white">${formatMoney(extraSalary)}</span>`;
            editorAddonsList.appendChild(row);
        }
    }

    if (editorAddonsList.children.length === 0) {
        editorAddonsList.innerHTML = '<span class="text-[10px] text-slate-600 italic">Дополнительные работы отсутствуют</span>';
    }

    // Штрафы монтажёра
    const editorPenaltiesList = document.getElementById('f-editor-penalties-list');
    editorPenaltiesList.innerHTML = '';
    let editorPenaltiesSum = 0;
    if (p.editorPenalties && Array.isArray(p.editorPenalties)) {
        p.editorPenalties.forEach(item => {
            const val = parseFloat(item.value) || 0;
            const amount = item.type === 'percent' ? editorBase * (val / 100) : val;
            editorPenaltiesSum += amount;
            const row = document.createElement('div');
            row.className = "flex justify-between text-xs text-rose-400 pl-2 border-l border-rose-500/20";
            const label = item.type === 'percent' ? `${escapeHtml(item.name)} (${val}%)` : escapeHtml(item.name);
            row.innerHTML = `<span>− ${label}:</span><span class="font-mono text-rose-400">−${formatMoney(amount)}</span>`;
            editorPenaltiesList.appendChild(row);
        });
    }
    if (editorPenaltiesList.children.length === 0) {
        editorPenaltiesList.innerHTML = '<span class="text-[10px] text-slate-600 italic">Штрафов нет</span>';
    }

    const editorTotal = editorBase + bonusAmount + editorAddonsSum - editorPenaltiesSum;
    document.getElementById('f-editor-total').textContent = formatMoney(editorTotal);

    const netProfit = clientTotal - editorTotal;
    document.getElementById('f-project-profit').textContent = formatMoney(netProfit);

    openModal('modal-finance-details');
};

function renderAdminFinances() {
    const list = document.getElementById('dashboard-viewport');
    const doneProjects = _projects.filter(p => p.stage === 'done');

    let totalIncome = 0;
    let totalPayout = 0;
    doneProjects.forEach(p => {
        totalIncome += getProjectIncome(p);
        totalPayout += getEditorPayout(p);
    });
    let totalProfit = totalIncome - totalPayout;

    list.innerHTML = `
        <div class="fade-in-up space-y-6">
            <h3 class="text-xs font-space font-bold text-slate-400 uppercase tracking-widest"><i class="fas fa-wallet text-indigo-400 mr-2"></i> Финансы</h3>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
                <div class="glass-card premium-border p-6 rounded-3xl text-center shadow-lg">
                    <span class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Общий Доход</span>
                    <div class="text-2xl font-bold text-white mt-2 font-mono">${formatMoney(totalIncome)}</div>
                </div>
                <div class="glass-card premium-border p-6 rounded-3xl text-center shadow-lg">
                    <span class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Фонд Выплат</span>
                    <div class="text-2xl font-bold text-rose-400 mt-2 font-mono">${formatMoney(totalPayout)}</div>
                </div>
                <div class="glass-card premium-border p-6 rounded-3xl text-center bg-indigo-500/10 shadow-lg">
                    <span class="text-[10px] text-indigo-300 font-bold uppercase tracking-widest">Чистая Прибыль</span>
                    <div class="text-2xl font-bold text-emerald-400 mt-2 font-mono">${formatMoney(totalProfit)}</div>
                </div>
            </div>

            <div class="space-y-3 mt-4">
                ${doneProjects.map(p => {
                    const inc = getProjectIncome(p);
                    const pay = getEditorPayout(p);
                    const prof = inc - pay;
                    return `
                        <div class="glass-card premium-border p-4 sm:p-5 rounded-2xl flex flex-col sm:flex-row justify-between items-start sm:items-center text-xs gap-4">
                            <div>
                                <div class="font-bold text-white font-space text-sm">${escapeHtml(p.projectName)}</div>
                                <div class="text-[9px] text-slate-500 mt-1 uppercase tracking-wide">Сдан: ${new Date(p.updatedAt || p.createdAt).toLocaleDateString('ru')}</div>
                            </div>
                            <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 w-full sm:w-auto">
                                <button onclick="openFinanceDetails('${p.id}')" class="pressable px-4 py-2 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20 text-[10px] font-bold uppercase rounded-xl transition duration-200"><i class="fas fa-list-alt mr-1"></i> Детали</button>
                                <div class="flex gap-4 sm:gap-6 w-full sm:w-auto text-right font-mono bg-black/20 p-3 sm:p-0 rounded-xl sm:bg-transparent">
                                    <div class="flex-1 sm:flex-none"><span class="block text-[8px] text-slate-500 uppercase tracking-widest">Доход</span><span class="text-emerald-400">${formatMoney(inc)}</span></div>
                                    <div class="flex-1 sm:flex-none"><span class="block text-[8px] text-slate-500 uppercase tracking-widest">Монтажёру</span><span class="text-rose-400">${formatMoney(pay)}</span></div>
                                    <div class="flex-1 sm:flex-none"><span class="block text-[8px] text-slate-500 uppercase tracking-widest">Чистая Прибыль</span><span class="text-indigo-400 font-bold">${formatMoney(prof)}</span></div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('') || `<div class="text-center py-10 text-slate-500 text-xs">Нет данных для расчетов</div>`}
            </div>
        </div>
    `;
}

function renderAdminEditors() {
    const list = document.getElementById('dashboard-viewport');
    list.innerHTML = `
        <div class="fade-in-up space-y-6">
            <div class="flex items-center justify-between">
                <h3 class="text-xs font-space font-bold text-slate-400 uppercase tracking-widest"><i class="fas fa-scissors text-indigo-400 mr-2"></i> Управление Монтажёрами</h3>
                <button onclick="openCreateEditorModal()" class="pressable px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-bold text-xs font-space text-white transition-all"><i class="fas fa-plus mr-1"></i> Добавить</button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
                ${_editors.map(e => {
                    const isOnline = (new Date() - new Date(e.lastLogin||0)) < 86400000;
                    return `
                        <div class="glass-card premium-border p-5 rounded-3xl flex flex-col gap-4 relative shadow-lg">
                            <div class="flex items-center gap-3">
                                <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center text-lg font-bold text-white relative shadow-inner border border-white/5">
                                    ${(e.name || e.login)[0].toUpperCase()}
                                    ${isOnline ? '<div class="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-emerald-500 rounded-full border-2 border-[#030208]"></div>' : ''}
                                </div>
                                <div>
                                    <h4 class="text-sm font-bold text-white font-space truncate">${escapeHtml(e.name || e.login)}</h4>
                                    <p class="text-[10px] text-slate-400 mt-0.5 font-mono">@${escapeHtml(e.login)}</p>
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-2 text-[10px] text-center font-space">
                                <div class="bg-black/30 border border-white/5 rounded-xl p-2.5"><span class="block text-slate-500 mb-1 uppercase">Рейтинг</span><span class="text-amber-400 font-bold text-xs"><i class="fas fa-star text-[10px] mr-0.5"></i> ${getEditorRating(e.id)}</span></div>
                                <div class="bg-black/30 border border-white/5 rounded-xl p-2.5"><span class="block text-slate-500 mb-1 uppercase">Сдано</span><span class="text-emerald-400 font-bold text-xs font-mono">${_projects.filter(p=>p.editorId===e.id && p.stage==='done').length}</span></div>
                            </div>
                            <div class="flex flex-col gap-2 mt-2 pt-2 border-t border-white/[0.04]">
                                <button onclick="loginAsEditor('${e.id}')" class="pressable w-full py-2.5 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 text-[10px] font-bold uppercase tracking-wider transition-all"><i class="fas fa-sign-in-alt mr-1.5"></i> Войти в кабинет</button>
                                <div class="flex gap-2">
                                    <button onclick="openChatLink('${e.id}')" class="pressable flex-1 py-2.5 rounded-xl bg-white/[0.02] hover:bg-white/[0.06] border border-white/[0.04] text-slate-300 text-[10px] font-bold uppercase tracking-wider transition-all"><i class="fas fa-comment-alt mr-1"></i> Чат</button>
                                    <button onclick="openManageEditorModal('${e.id}')" class="pressable flex-1 py-2.5 rounded-xl bg-white/[0.02] hover:bg-white/[0.06] border border-white/[0.04] text-slate-300 text-[10px] font-bold uppercase tracking-wider transition-all"><i class="fas fa-cog mr-1"></i> Настройки</button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function generateProjectCardHTML(p) {
    const editor = _editors.find(e => e.id === p.editorId);
    const budgetVal = getProjectIncome(p);
    let dlHtml = renderDeadlineCountdown(p.createdAt, p.deadline);
    const timeSpent = p.timeSpent || 0;

    return `
        <div class="glass-card premium-border p-6 rounded-3xl flex flex-col justify-between relative overflow-hidden group transition-all duration-300 hover:translate-y-[-2px]">
            <div class="flex justify-between items-start mb-4">
                <div class="min-w-0 pr-3">
                    <h4 class="text-sm font-bold font-space text-white truncate group-hover:text-indigo-400 transition-colors duration-300">${escapeHtml(p.projectName)}</h4>
                    <p class="text-[10px] text-slate-500 mt-1 truncate">${escapeHtml(p.clientName)}</p>
                </div>
                <div class="text-right flex-shrink-0 flex items-center gap-2">
                    ${p.stage === 'done' ? `<button onclick="deleteProject('${p.id}')" class="text-red-400 hover:text-red-300 w-7 h-7 flex items-center justify-center bg-red-500/10 rounded-lg transition-colors border border-red-500/20" title="Удалить проект"><i class="fas fa-trash-alt text-[11px]"></i></button>` : ''}
                    ${dlHtml}
                </div>
            </div>

            <div class="grid grid-cols-2 gap-3.5 text-[10px] bg-black/30 p-3.5 rounded-2xl border border-white/[0.02] mb-4">
                <div><span class="text-slate-500 block mb-0.5">Бюджет проекта:</span><span class="text-emerald-400 font-bold font-mono text-xs">${formatMoney(budgetVal)}</span></div>
                <div><span class="text-slate-500 block mb-0.5">Затрачено времени:</span><span class="text-white font-bold font-mono text-xs">${formatSeconds(timeSpent)}</span></div>
                <div class="col-span-2 border-t border-white/[0.04] pt-2 mt-1"><span class="text-slate-500">Ответственный: </span><span class="text-indigo-300 font-bold font-space">${editor?.name || 'В ожидании'}</span></div>
            </div>

            <div>
                <div class="flex justify-between items-center mb-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">
                    <span>Степень готовности</span>
                    <span class="font-mono text-slate-300">${p.progress}%</span>
                </div>
                <div class="w-full bg-white/[0.03] h-[3px] rounded-full overflow-hidden">
                    <div class="bg-gradient-to-r from-indigo-500 to-purple-500 h-full rounded-full transition-all duration-500" style="width: ${p.progress}%"></div>
                </div>
            </div>

            <div class="flex gap-2 mt-4 pt-4 border-t border-white/[0.04]">
                <button onclick="openChatLink('${p.editorId}')" class="pressable flex-1 py-2.5 rounded-xl bg-white/[0.02] border border-white/[0.04] text-indigo-400 hover:bg-white/[0.06] text-[10px] font-bold transition-all"><i class="fas fa-comment-alt mr-1"></i> Чат</button>
                <button onclick="openEditProjectModal('${p.id}')" class="pressable flex-1 py-2.5 rounded-xl bg-white/[0.02] border border-white/[0.04] text-slate-300 hover:bg-white/[0.06] text-[10px] font-bold transition-all"><i class="fas fa-edit mr-1"></i> Свойства</button>
            </div>
        </div>
    `;
}

function renderDeadlineCountdown(createdAt, deadline) {
    if (!deadline) return `<span class="text-[9px] text-slate-500 border border-slate-800 rounded-xl px-2 py-0.5 font-bold uppercase">Без дедлайна</span>`;
    
    const dl = new Date(deadline);
    const now = new Date();
    const diffMs = dl - now;
    
    if (diffMs < 0) return `<span class="text-[9px] bg-red-500/10 text-red-400 border border-red-500/20 px-2.5 py-0.5 rounded-xl font-bold uppercase">Истёк</span>`;

    let colorClass = "text-emerald-400 border-emerald-500/20 bg-emerald-500/10";
    if (createdAt) {
        const start = new Date(createdAt);
        const totalMs = dl - start;
        if (totalMs > 0) {
            const perc = (diffMs / totalMs) * 100;
            if (perc < 20) colorClass = "text-rose-400 border-rose-500/20 bg-rose-500/10 animate-pulse";
            else if (perc < 50) colorClass = "text-amber-400 border-amber-500/20 bg-amber-500/10";
        }
    }

    const days = Math.floor(diffMs / 86400000);
    const hours = Math.floor((diffMs % 86400000) / 3600000);
    
    let text = `${days}д ${hours}ч`;
    if (days === 0) {
        const mins = Math.floor((diffMs % 3600000) / 60000);
        text = `${hours}ч ${mins}м`;
    }

    return `<span class="text-[9px] border px-2.5 py-0.5 rounded-xl font-bold font-space uppercase ${colorClass}"><i class="far fa-clock"></i> ${text}</span>`;
}

function renderAdminSubmissions() {
    const list = document.getElementById('dashboard-viewport');
    const pending = _submissions.filter(s => s.status === 'pending');
    
    list.innerHTML = `
        <div class="fade-in-up space-y-6">
            <h3 class="text-xs font-space font-bold text-slate-400 uppercase tracking-widest">Проверка сданных проектов</h3>
            <div class="space-y-5">
                ${pending.map(s => {
                    return `
                        <div class="glass-card premium-border p-6 rounded-3xl flex flex-col gap-4 border-l-4 border-indigo-500 relative">
                            <div class="absolute top-6 right-6 text-[10px] text-slate-500 font-mono">${new Date(s.createdAt).toLocaleDateString('ru')}</div>
                            <div>
                                <h4 class="text-sm font-bold font-space text-white truncate pr-20">${s.projectName}</h4>
                                <p class="text-[10px] text-slate-400 mt-1">Ответственный монтажёр: <span class="text-indigo-300 font-bold font-space">${s.editorName}</span></p>
                            </div>
                            
                            <div class="bg-black/30 p-4 rounded-2xl border border-white/[0.03] text-xs space-y-3">
                                <div><span class="text-[9px] text-slate-500 uppercase tracking-wider block mb-1">Финальная ссылка на видео</span><a href="${s.submissionUrl}" target="_blank" class="text-indigo-400 font-bold hover:underline break-all flex items-center gap-1.5"><i class="fas fa-external-link-alt text-[10px]"></i> Открыть в новой вкладке</a></div>
                                ${s.comment ? `<div><span class="text-[9px] text-slate-500 uppercase tracking-wider block mb-1">Комментарий монтажёра</span><p class="text-slate-300 italic font-light">${escapeHtml(s.comment)}</p></div>` : ''}
                            </div>

                            <button data-comment="${escapeHtml(s.comment || '')}" onclick="openReviewModal('${s.id}', '${s.projectId}', '${s.editorId}', this)" class="pressable w-full py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white transition-all shadow-lg mt-1">Перейти к проверке</button>
                        </div>
                    `;
                }).join('') || `
                    <div class="glass-card premium-border p-10 rounded-3xl text-center text-xs text-slate-500">
                        Очередь проверки пуста. Все материалы утверждены.
                    </div>
                `}
            </div>
        </div>
    `;
    updateAdminBadges();
}

function renderAdminRequests() {
    const list = document.getElementById('dashboard-viewport');
    const pending = _editRequests.filter(r => r.status === 'pending');
    
    list.innerHTML = `
        <div class="fade-in-up space-y-6">
            <div class="flex items-center justify-between">
                <h3 class="text-xs font-space font-bold text-slate-400 uppercase tracking-widest">Запросы изменений от монтажёров</h3>
                <span class="text-[10px] text-slate-500 font-mono">${pending.length} на рассмотрении</span>
            </div>

            <div class="space-y-4">
                ${pending.map(r => {
                    const orig = _projects.find(p => p.id === r.projectId);
                    const origStageLabel = stageLabels[orig?.stage] || orig?.stage || '—';
                    const reqStageLabel = stageLabels[r.stage] || r.stage || '—';
                    
                    return `
                        <div class="glass-card premium-border p-5 rounded-3xl flex flex-col gap-4 border-l-4 border-indigo-500">
                            <div class="flex justify-between items-start">
                                <div>
                                    <h4 class="text-sm font-bold font-space text-indigo-400">${escapeHtml(r.projectName)}</h4>
                                    <p class="text-[10px] text-slate-400 mt-1">Отправитель: <span class="text-white font-bold font-space">${escapeHtml(r.editorName)}</span></p>
                                </div>
                                <span class="text-[9px] text-slate-500 font-mono">${new Date(r.createdAt).toLocaleString('ru')}</span>
                            </div>

                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs bg-black/40 p-4 rounded-2xl border border-white/[0.02]">
                                <div>
                                    <span class="text-[10px] text-slate-500 uppercase block mb-2">Текущая версия проекта</span>
                                    <div class="space-y-1 text-slate-400 text-[11px]">
                                        <p>Стадия: <span class="text-slate-300 font-bold">${escapeHtml(origStageLabel)}</span></p>
                                        <p>Прогресс: <span class="text-slate-300 font-bold">${orig?.progress || 0}%</span></p>
                                        <p>Заметки: <span class="text-slate-300">${escapeHtml(orig?.notes || 'нет')}</span></p>
                                    </div>
                                </div>
                                <div class="border-t md:border-t-0 md:border-l border-white/[0.04] pt-4 md:pt-0 md:pl-4">
                                    <span class="text-[10px] text-slate-500 uppercase block mb-2">Предложенные изменения</span>
                                    <div class="space-y-1 text-indigo-300 text-[11px]">
                                        <p>Стадия: <span class="font-bold">${escapeHtml(reqStageLabel)}</span></p>
                                        <p>Прогресс: <span class="font-bold">${r.progress}%</span></p>
                                        <p>Заметки: <span class="text-indigo-200">${escapeHtml(r.notes || 'нет')}</span></p>
                                    </div>
                                </div>
                            </div>
                            
                            <div class="flex gap-2 mt-2">
                                <button onclick="rejectEditRequest('${r.id}')" class="pressable flex-1 py-2.5 rounded-xl border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 text-[10px] font-bold text-red-400 transition-all">Отклонить</button>
                                <button onclick="approveEditRequest('${r.id}', '${r.projectId}')" class="pressable flex-1 py-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/10 hover:bg-emerald-500/20 text-[10px] font-bold text-emerald-400 transition-all">Одобрить</button>
                            </div>
                        </div>
                    `;
                }).join('') || `
                    <div class="glass-card premium-border p-10 rounded-3xl text-center text-xs text-slate-500">
                        Нет запросов на изменения
                    </div>
                `}
            </div>
        </div>
    `;
    updateAdminBadges();
}

window.updateAdminBadges = function() {
    const subsBadge = document.getElementById('badge-subs');
    const reqsBadge = document.getElementById('badge-reqs');
    const subsBadgeMobile = document.getElementById('nav-notif-badge-mobile');
    const reqsBadgeMobile = document.getElementById('nav-notif-badge-mobile');

    const subsPending = _submissions.filter(s => s.status === 'pending').length === 0;
    const reqsPending = _editRequests.filter(r => r.status === 'pending').length === 0;

    if (subsBadge) subsBadge.classList.toggle('hidden', subsPending);
    if (reqsBadge) reqsBadge.classList.toggle('hidden', reqsPending);
    if (subsBadgeMobile) subsBadgeMobile.classList.toggle('hidden', subsPending);
    if (reqsBadgeMobile) reqsBadgeMobile.classList.toggle('hidden', reqsPending);
};

window.addCrmExtraServiceRow = function(name = '', price = '') {
    const container = document.getElementById('crm-extra-services-container');
    if (!container) return;
    const rowId = 'crm-es-row-' + Date.now() + Math.random().toString(36).substr(2, 5);
    const row = document.createElement('div');
    row.className = "flex gap-2 items-center";
    row.id = rowId;
    row.innerHTML = `
        <input type="text" class="crm-es-name flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-indigo-500/40" placeholder="Название услуги" value="${escapeHtml(name)}">
        <input type="number" class="crm-es-price w-24 bg-white/[0.04] border border-white/[0.06] rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-indigo-500/40" placeholder="Цена ₽" value="${price || ''}">
        <button type="button" onclick="document.getElementById('${rowId}').remove()" class="pressable w-8 h-8 rounded-xl bg-red-500/10 text-red-400 flex items-center justify-center transition-all"><i class="fas fa-trash text-[10px]"></i></button>
    `;
    container.appendChild(row);
};

window.addCrmEditorExtraServiceRow = function(name = '', price = '') {
    const container = document.getElementById('crm-editor-extra-services-container');
    if (!container) return;
    const rowId = 'crm-ees-row-' + Date.now() + Math.random().toString(36).substr(2, 5);
    const row = document.createElement('div');
    row.className = "flex gap-2 items-center";
    row.id = rowId;
    row.innerHTML = `
        <input type="text" class="crm-ees-name flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-indigo-500/40" placeholder="Название услуги" value="${escapeHtml(name)}">
        <input type="number" class="crm-ees-price w-24 bg-white/[0.04] border border-white/[0.06] rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-indigo-500/40" placeholder="Цена ₽" value="${price || ''}">
        <button type="button" onclick="document.getElementById('${rowId}').remove()" class="pressable w-8 h-8 rounded-xl bg-red-500/10 text-red-400 flex items-center justify-center transition-all"><i class="fas fa-trash text-[10px]"></i></button>
    `;
    container.appendChild(row);
};

function renderAdminClients() {
    const vp = document.getElementById('dashboard-viewport');
    const editorsOptions = _editors.map(e =>
        `<option value="${e.id}" class="bg-slate-900 text-white">${escapeHtml(e.name || e.login)}</option>`
    ).join('');

    vp.innerHTML = `
        <div class="fade-in-up space-y-6">
            <div class="relative overflow-hidden rounded-3xl border border-white/[0.05] p-6" style="background: linear-gradient(135deg, rgba(99,102,241,0.07) 0%, rgba(139,92,246,0.04) 100%);">
                <div class="absolute top-0 right-0 w-40 h-40 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none"></div>
                <div class="relative z-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <div>
                        <p class="text-[10px] text-indigo-400 uppercase tracking-[0.2em] font-space font-bold mb-1">CRM — Личные кабинеты</p>
                        <h3 class="text-xl font-space font-black text-white mb-1">Управление клиентами</h3>
                        <p class="text-slate-400 text-xs">Создавайте кабинеты, назначайте монтажёров и отслеживайте проекты</p>
                    </div>
                    <div class="flex items-center gap-2 px-4 py-2 bg-indigo-500/10 border border-indigo-500/30 rounded-full">
                        <span class="text-indigo-400 text-xs font-bold font-space">${_projects.length} проектов</span>
                    </div>
                </div>
            </div>

            <div>
                <p class="text-[10px] text-slate-500 uppercase tracking-[0.2em] font-space font-bold mb-3 flex items-center gap-2">
                    <i class="fas fa-list text-indigo-400"></i> Активные кабинеты клиентов
                </p>
                <div class="rounded-2xl border border-white/[0.04] overflow-hidden" style="background:rgba(255,255,255,0.015)">
                    <div class="space-y-0 max-h-[420px] overflow-y-auto" id="crm-clients-list">
                        ${renderCrmClientsList(_projects)}
                    </div>
                </div>
            </div>

            <!-- CRM ИНИЦИАЛИЗАЦИЯ И РЕГУЛИРОВКА ХАРАКТЕРИСТИК (ВЕРТИКАЛЬНАЯ СЕТКА) -->
            <div class="flex flex-col gap-6 w-full">
                <!-- Блок 1: Кабинет Клиента -->
                <div class="rounded-3xl border border-indigo-500/15 p-6 space-y-4" style="background: linear-gradient(135deg, rgba(99,102,241,0.06) 0%, rgba(139,92,246,0.03) 100%);">
                    <div class="flex items-center gap-3 border-b border-white/[0.05] pb-4">
                        <div class="w-8 h-8 rounded-xl flex items-center justify-center bg-indigo-500/15 border border-indigo-500/25">
                            <i class="fas fa-user-plus text-indigo-400 text-xs"></i>
                        </div>
                        <div>
                            <p class="text-sm font-bold text-white font-space">1. Кабинет Клиента</p>
                            <p class="text-[10px] text-slate-500">Регистрация и доступ заказчика</p>
                        </div>
                    </div>

                    <div class="space-y-3.5">
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Код доступа клиента</label>
                            <input type="text" id="crm-new-code" placeholder="client777" class="w-full bg-white/[0.04] border border-indigo-500/20 text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/50 font-mono font-bold transition">
                        </div>
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Имя клиента</label>
                            <input type="text" id="crm-new-name" placeholder="Алексей" class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 transition">
                        </div>
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Дедлайн</label>
                            <input type="date" id="crm-new-deadline" class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 transition">
                        </div>
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Название проекта</label>
                            <input type="text" id="crm-new-project" placeholder="Продуктовый ролик" class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 transition">
                        </div>
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Категория монтажа</label>
                            <input type="text" id="crm-new-category" placeholder="VIP / Базовый" class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 transition">
                        </div>
                        <div class="bg-black/20 p-4 rounded-xl border border-white/[0.04] space-y-3">
                            <div>
                                <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Базовая ставка (клиент) (₽)</label>
                                <input type="number" id="crm-new-base-price" placeholder="3000" class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 font-mono transition">
                            </div>
                            <div>
                                <div class="flex items-center justify-between mb-2">
                                    <label class="block text-[10px] text-slate-500 uppercase tracking-widest font-space">Доп. услуги клиента</label>
                                    <button type="button" onclick="addCrmExtraServiceRow()" class="text-[9px] text-indigo-400 hover:text-indigo-300 font-bold px-2 py-1 bg-indigo-500/10 rounded-lg"><i class="fas fa-plus"></i> Добавить</button>
                                </div>
                                <div id="crm-extra-services-container" class="space-y-2"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Блок 2: Характеристики ролика -->
                <div class="rounded-3xl border border-blue-500/15 p-6 space-y-4" style="background: linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(99,102,241,0.03) 100%);">
                    <div class="flex items-center gap-3 border-b border-white/[0.05] pb-4">
                        <div class="w-8 h-8 rounded-xl flex items-center justify-center bg-blue-500/15 border border-blue-500/25">
                            <i class="fas fa-sliders text-blue-400 text-xs"></i>
                        </div>
                        <div>
                            <p class="text-sm font-bold text-white font-space">2. Характеристики Ролика</p>
                            <p class="text-[10px] text-slate-500">Техническое ТЗ готового видео</p>
                        </div>
                    </div>

                    <div class="space-y-3.5">
                        <div class="grid grid-cols-2 gap-3">
                            <div>
                                <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Format ролика</label>
                                <select id="crm-video-format" class="w-full bg-white/[0.02] border border-white/[0.06] text-white text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-indigo-500/40 transition">
                                    <option value="9:16" class="bg-slate-900 text-white">Вертикальный (9:16)</option>
                                    <option value="16:9" class="bg-slate-900 text-white">Горизонтальный (16:9)</option>
                                    <option value="1:1" class="bg-slate-900 text-white">Квадратный (1:1)</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Разрешение</label>
                                <select id="crm-video-resolution" class="w-full bg-white/[0.02] border border-white/[0.06] text-white text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-indigo-500/40 transition">
                                    <option value="1080p" class="bg-slate-900 text-white">FullHD (1080p)</option>
                                    <option value="4K" class="bg-slate-900 text-white">4K UHD</option>
                                    <option value="2K" class="bg-slate-900 text-white">2K QHD</option>
                                </select>
                            </div>
                        </div>

                        <div class="grid grid-cols-2 gap-3">
                            <div>
                                <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Хронометраж</label>
                                <input type="text" id="crm-video-duration" placeholder="до 60 сек" class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-indigo-500/40 transition">
                            </div>
                            <div>
                                <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Субтитры</label>
                                <select id="crm-video-subtitles" class="w-full bg-white/[0.02] border border-white/[0.06] text-white text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-indigo-500/40 transition">
                                    <option value="yes_animated" class="bg-slate-900 text-white">Да (с анимацией)</option>
                                    <option value="yes_simple" class="bg-slate-900 text-white">Да (простые)</option>
                                    <option value="no" class="bg-slate-900 text-white">Не требуются</option>
                                </select>
                            </div>
                        </div>

                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Целевая платформа</label>
                            <input type="text" id="crm-video-platform" placeholder="YouTube, Instagram, TikTok" class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 transition">
                        </div>

                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Музыкальное сопровождение</label>
                            <input type="text" id="crm-video-music" placeholder="Динамичная без АП, трендовые звуки" class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 transition">
                        </div>

                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space"><i class="fas fa-link text-indigo-400 mr-1"></i> Ссылка на референс</label>
                            <input type="url" id="crm-video-reference" placeholder="https://..." class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 transition">
                        </div>

                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space"><i class="fas fa-folder-open text-indigo-400 mr-1"></i> Ссылка на исходники</label>
                            <input type="url" id="crm-video-sources" placeholder="https://disk.yandex.ru/..." class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 transition">
                        </div>
                    </div>
                </div>

                <!-- Блок 3: Проект для Монтажёра -->
                <div class="rounded-3xl border border-purple-500/15 p-6 space-y-4" style="background: linear-gradient(135deg, rgba(139,92,246,0.06) 0%, rgba(99,102,241,0.03) 100%);">
                    <div class="flex items-center gap-3 border-b border-white/[0.05] pb-4">
                        <div class="w-8 h-8 rounded-xl flex items-center justify-center bg-purple-500/15 border border-purple-500/25">
                            <i class="fas fa-cut text-purple-400 text-xs"></i>
                        </div>
                        <div>
                            <p class="text-sm font-bold text-white font-space">3. Проект Монтажёра</p>
                            <p class="text-[10px] text-slate-500">Назначение штата и расчеты</p>
                        </div>
                    </div>

                    <div class="space-y-3.5">
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Назначить монтажёра</label>
                            <select id="crm-new-editor" class="w-full text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/50 transition cursor-pointer bg-white/[0.02] border border-white/[0.06]">
                                <option value="" class="bg-slate-900 text-slate-400">— не назначен —</option>
                                ${editorsOptions}
                            </select>
                        </div>
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Базовая ставка монтажёра (₽)</label>
                            <input type="number" id="crm-new-editor-salary" placeholder="2000" class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 font-mono transition">
                        </div>
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space flex items-center justify-between">
                                Прогресс монтажа (%)
                                <span id="crm-new-progress-display" class="text-xs font-bold text-indigo-400">10%</span>
                            </label>
                            <input type="range" id="crm-new-progress" min="0" max="100" value="10" class="w-full accent-indigo-600 my-2" oninput="document.getElementById('crm-new-progress-display').textContent=this.value+'%'">
                        </div>
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Начальная стадия готовности</label>
                            <select id="crm-new-stage" class="w-full bg-white/[0.02] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 transition">
                                <option value="brief" selected>ТЗ & Бриф</option>
                                <option value="edit">Черновик</option>
                                <option value="effects">Звук & FX</option>
                                <option value="color">Цвет</option>
                                <option value="done">Сдача</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space"><i class="fas fa-link text-indigo-400 mr-1"></i> Ссылка на ТЗ</label>
                            <input type="url" id="crm-new-tk-link" placeholder="https://docs.google.com/..." class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500/40 transition">
                        </div>
                        <div>
                            <label class="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 font-space">Бриф / Комментарий к проекту</label>
                            <textarea id="crm-new-notes" maxlength="800" placeholder="Кабинет клиента настроен. Ожидаем материалы." class="w-full bg-white/[0.04] border border-white/[0.06] text-white text-xs rounded-xl p-3 resize-none h-20 focus:outline-none focus:border-indigo-500/40 transition"></textarea>
                            <div class="text-right text-[9px] text-slate-500 mt-1" id="crm-new-notes-counter">0 / 800</div>
                        </div>
                        <div class="bg-black/20 p-4 rounded-xl border border-white/[0.04] space-y-3">
                            <div class="flex items-center justify-between mb-2">
                                <label class="block text-[10px] text-slate-500 uppercase tracking-widest font-space">Доп. услуги монтажёра</label>
                                <button type="button" onclick="addCrmEditorExtraServiceRow()" class="text-[9px] text-purple-400 hover:text-purple-300 font-bold px-2 py-1 bg-purple-500/10 rounded-lg"><i class="fas fa-plus"></i> Добавить</button>
                            </div>
                            <div id="crm-editor-extra-services-container" class="space-y-2"></div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pt-4">
                <button onclick="crmCreateClientProject()" class="pressable w-full py-4 font-bold rounded-2xl text-xs font-space uppercase tracking-wider transition-all duration-300 flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600/30 to-purple-600/30 hover:from-indigo-600/40 hover:to-purple-600/40 text-white border border-indigo-500/30 shadow-[0_0_20px_rgba(99,102,241,0.2)]">
                    <i class="fas fa-satellite-dish"></i> Собрать проект и инициализировать кабинет
                </button>
            </div>
        </div>
    `;
}

function renderCrmClientsList(projects) {
    if (!projects || projects.length === 0) {
        return `<div class="p-8 text-center text-xs text-slate-500 font-space">Кабинеты клиентов не созданы.</div>`;
    }
    const stageMap = { brief: 'ТЗ & Бриф', edit: 'Черновик', effects: 'Звук & FX', color: 'Цвет', done: 'Сдача' };
    const stageColor = { brief: 'text-slate-400', edit: 'text-blue-400', effects: 'text-purple-400', color: 'text-amber-400', done: 'text-emerald-400' };

    return projects.map(p => {
        const editor = _editors.find(e => e.id === p.editorId);
        const stageLbl = stageMap[p.stage] || p.stage || '—';
        const stageClr = stageColor[p.stage] || 'text-slate-400';
        const budget = getProjectIncome(p);
        const deadlineStr = p.deadline ? new Date(p.deadline).toLocaleDateString('ru-RU') : 'Не задан';

        return `
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border-b border-white/[0.03] last:border-0 hover:bg-white/[0.015] transition-colors group">
                <div class="flex items-start gap-4 min-w-0 flex-1">
                    <div class="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 font-black text-sm font-space text-white bg-gradient-to-br from-indigo-500/20 to-purple-500/10 border border-indigo-500/20">
                        ${escapeHtml((p.clientName || '?')[0].toUpperCase())}
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2 mb-0.5">
                            <span class="text-sm font-bold text-white font-space truncate">${escapeHtml(p.clientName || 'Без имени')}</span>
                            <span class="text-[9px] px-2 py-0.5 rounded-full font-bold ${stageClr} bg-white/[0.02] border border-white/[0.04]">${stageLbl}</span>
                        </div>
                        <p class="text-[10px] text-slate-500 truncate">${escapeHtml(p.projectName || '—')}</p>
                        <div class="flex flex-wrap gap-3 mt-1.5 text-[9px] text-slate-600 font-space">
                            <span><i class="fas fa-user-circle mr-1 text-indigo-500/60"></i>${editor ? escapeHtml(editor.name || editor.login) : 'Не назначен'}</span>
                            <span><i class="far fa-clock mr-1"></i>${deadlineStr}</span>
                            ${budget ? `<span><i class="fas fa-ruble-sign mr-1 text-emerald-500/60"></i>${formatMoney(budget)}</span>` : ''}
                        </div>
                    </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <!-- Исправлено: Добавлена возможность редактировать ЛК клиента прямо в разделе CRM -->
                    <button onclick="openEditProjectModal('${p.id}')" class="pressable opacity-0 md:group-hover:opacity-100 w-7 h-7 rounded-lg flex items-center justify-center text-indigo-400 hover:bg-indigo-500/10 transition-all duration-200" title="Редактировать">
                        <i class="fas fa-edit text-[10px]"></i>
                    </button>
                    <button onclick="crmDeleteClientProject('${p.id}')" class="pressable opacity-0 md:group-hover:opacity-100 w-7 h-7 rounded-lg flex items-center justify-center text-red-400 hover:bg-red-500/10 transition-all duration-200" title="Удалить">
                        <i class="fas fa-trash text-[10px]"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

window.crmCreateClientProject = async function() {
    const rawCode   = (document.getElementById('crm-new-code')?.value || '').trim();
    const name      = (document.getElementById('crm-new-name')?.value || '').trim();
    const project   = (document.getElementById('crm-new-project')?.value || '').trim();
    const category  = (document.getElementById('crm-new-category')?.value || '').trim();
    const deadline  = document.getElementById('crm-new-deadline')?.value || '';
    const basePrice = parseFloat(document.getElementById('crm-new-base-price')?.value) || 0;
    
    // Video Characteristics values
    const videoFormat     = document.getElementById('crm-video-format')?.value || '9:16';
    const videoResolution = document.getElementById('crm-video-resolution')?.value || '1080p';
    const videoDuration   = document.getElementById('crm-video-duration')?.value.trim() || '';
    const videoSubtitles  = document.getElementById('crm-video-subtitles')?.value || 'yes_animated';
    const videoPlatform   = document.getElementById('crm-video-platform')?.value.trim() || '';
    const videoMusic      = document.getElementById('crm-video-music')?.value.trim() || '';
    const videoReference  = document.getElementById('crm-video-reference')?.value.trim() || '';
    const videoSources    = document.getElementById('crm-video-sources')?.value.trim() || '';

    // Монтажёр
    const editorId  = document.getElementById('crm-new-editor')?.value || '';
    const editorName = editorId ? (_editors.find(e => e.id === editorId)?.name || '') : '';
    const editorSalary = parseFloat(document.getElementById('crm-new-editor-salary')?.value) || 0;
    const notes = document.getElementById('crm-new-notes')?.value.trim() || 'Кабинет клиента настроен. Ожидаем материалы.';
    const progress = parseInt(document.getElementById('crm-new-progress')?.value) || 10;
    const stage = document.getElementById('crm-new-stage')?.value || 'brief';
    const tkLink = document.getElementById('crm-new-tk-link')?.value.trim() || '';

    // Сбор доп. услуг клиента
    const clientExtraServices = [];
    document.querySelectorAll('#crm-extra-services-container > div').forEach(row => {
        const n = row.querySelector('.crm-es-name').value.trim();
        const p = parseFloat(row.querySelector('.crm-es-price').value) || 0;
        if (n) clientExtraServices.push({ name: n, price: p });
    });

    // Сбор доп. услуг монтажёра
    const editorExtraServices = [];
    document.querySelectorAll('#crm-editor-extra-services-container > div').forEach(row => {
        const n = row.querySelector('.crm-ees-name').value.trim();
        const p = parseFloat(row.querySelector('.crm-ees-price').value) || 0;
        if (n) editorExtraServices.push({ name: n, price: p });
    });

    if (!rawCode || !name || !project) {
        showToast('Заполните обязательные поля (Код, Имя, Проект)', 'error');
        return;
    }

    const editorExtraSalary = editorExtraServices.reduce((sum, item) => sum + item.price, 0);

    const data = {
        clientName: name,
        projectName: project,
        clientCategory: category,
        deadline: deadline,
        baseSalary: basePrice,
        basePrice: basePrice,
        clientExtraServices: clientExtraServices,
        
        // Video Specs
        videoFormat,
        videoResolution,
        videoDuration,
        videoSubtitles,
        videoPlatform,
        videoMusic,
        videoReference,
        videoSources,

        // Монтажер
        editorId: editorId,
        editorName: editorName,
        editorSalary: editorSalary,
        editorExtraServices: editorExtraServices,
        editorExtraSalary: editorExtraSalary,
        editorBonusName: '',
        editorBonusType: 'rub',
        editorBonusValue: 0,
        
        stage: stage,
        progress: progress,
        tkLink: tkLink,
        notes: notes,
        addons: [],
        accessCode: rawCode.toLowerCase(),
        createdAt: new Date().toISOString()
    };

    try {
        await ensureAuth();
        await addDoc(collection(db, ...BASE('projects')), data);
        showToast('Проект и личный кабинет успешно созданы!', 'success');
        
        // Сброс полей
        ['crm-new-code','crm-new-name','crm-new-project','crm-new-category','crm-new-base-price','crm-new-deadline', 'crm-new-editor-salary', 'crm-new-notes', 'crm-new-tk-link', 'crm-video-duration', 'crm-video-platform', 'crm-video-music', 'crm-video-reference', 'crm-video-sources'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        const containerClient = document.getElementById('crm-extra-services-container');
        if (containerClient) containerClient.innerHTML = '';
        const containerEditor = document.getElementById('crm-editor-extra-services-container');
        if (containerEditor) containerEditor.innerHTML = '';
        
        const sel = document.getElementById('crm-new-editor');
        if (sel) sel.value = '';
    } catch(e) { showToast('Ошибка: ' + e.message, 'error'); }
};

window.crmDeleteClientProject = async function(id) {
    customConfirm('Удаление проекта клиента', 'Вы уверены, что хотите удалить проект клиента?', async () => {
        try {
            await ensureAuth();
            await deleteDoc(doc(db, ...BASE('projects'), id));
            showToast('Проект удалён', 'info');
        } catch(e) { showToast('Ошибка удаления', 'error'); }
    });
};

window.rejectEditRequest = async function(id) {
    try {
        await ensureAuth();
        const reqSnap = await getDoc(doc(db, ...BASE('edit_requests'), id));
        if (!reqSnap.exists()) return;
        const rData = reqSnap.data();

        await updateDoc(doc(db, ...BASE('edit_requests'), id), { status: 'rejected' });
        sendNotification(rData.editorId, 'Запрос изменений отклонен', `Администратор отклонил изменения в проекте "${rData.projectName}".`);
        showToast('Запрос отклонён', 'info');
    } catch(e) { showToast('Ошибка синхронизации', 'error'); }
};

window.approveEditRequest = async function(reqId, projectId) {
    try {
        await ensureAuth();
        const reqDoc = await getDoc(doc(db, ...BASE('edit_requests'), reqId));
        if(!reqDoc.exists()) return;
        const data = reqDoc.data();
        
        await updateDoc(doc(db, ...BASE('projects'), projectId), {
            progress: data.progress,
            stage: data.stage,
            notes: data.notes,
            updatedAt: new Date().toISOString()
        });
        
        await updateDoc(doc(db, ...BASE('edit_requests'), reqId), { status: 'approved' });
        sendNotification(data.editorId, 'Запрос изменений утвержден', `Ваши изменения по проекту "${data.projectName}" успешно утверждены.`);
        showToast('Изменения внесены в проект', 'success');
    } catch(e) { showToast('Ошибка при одобрении', 'error'); }
};

window.openModal = function(id) {
    const m = document.getElementById(id);
    if(m) {
        m.classList.remove('hidden');
        m.style.opacity = '0';
        setTimeout(() => {
            m.style.opacity = '1';
            m.style.transition = 'opacity 0.25s ease-out';
        }, 10);
    }
};

window.closeModal = function(id) {
    const m = document.getElementById(id);
    if(m) {
        m.style.opacity = '0';
        setTimeout(() => { m.classList.add('hidden'); }, 250);
    }
};

window.showToast = function(msg, type='info') {
    const container = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type === 'success' ? 'border-emerald-500/30 text-emerald-400' : type === 'error' ? 'border-rose-500/30 text-red-400' : 'border-indigo-500/30 text-indigo-400'}`;
    t.innerHTML = `<i class="fas ${type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info'} mr-2.5"></i>${msg}`;
    container.appendChild(t);
    setTimeout(() => { 
        t.style.opacity = '0'; 
        t.style.transform = 'translateY(-14px) scale(0.95)'; 
        t.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)'; 
        setTimeout(() => t.remove(), 250); 
    }, 3500);
};

window.formatMoney = function(num) {
    return new Intl.NumberFormat('ru-RU').format(num) + ' ₽';
};

window.formatSeconds = function(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const pad = (n) => n < 10 ? '0' + n : n;
    return `${pad(m)}:${pad(s)}`;
};

window.escapeHtml = function(str) {
    if(!str) return '';
    return str.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
};

window.openCreateEditorModal = function() {
    document.getElementById('e-name').value = '';
    document.getElementById('e-login').value = '';
    document.getElementById('e-pass').value = '';
    openModal('modal-editor');
};

window.createEditor = async function() {
    const name = document.getElementById('e-name').value.trim();
    const login = document.getElementById('e-login').value.trim();
    const pass = document.getElementById('e-pass').value;
    if(!name || !login || !pass) { showToast('Заполните все поля', 'error'); return; }
    try {
        await ensureAuth();
        const hash = CryptoJS.SHA256(pass).toString();
        await addDoc(collection(db, ...BASE('editors')), {
            name, login, passwordHash: hash, isBlocked: false, createdAt: new Date().toISOString()
        });
        showToast('Монтажер успешно добавлен!', 'success');
        closeModal('modal-editor');
    } catch(e) { showToast('Ошибка создания', 'error'); }
};

window.toggleBlockEditor = async function() {
    const id = document.getElementById('manage-editor-id').value;
    const ed = _editors.find(e => e.id === id);
    if(!ed) return;
    try {
        await ensureAuth();
        await updateDoc(doc(db, ...BASE('editors'), id), { isBlocked: !ed.isBlocked });
        showToast(ed.isBlocked ? 'Монтажер разблокирован' : 'Монтажер заблокирован', 'success');
        closeModal('modal-manage-editor');
    } catch(e) { showToast('Ошибка изменения статуса', 'error'); }
};

window.deleteEditorConfirm = async function() {
    const id = document.getElementById('manage-editor-id').value;
    customConfirm('Удаление аккаунта', 'Вы уверены, что хотите полностью удалить аккаунт монтажера?', async () => {
        try {
            await ensureAuth();
            await deleteDoc(doc(db, ...BASE('editors'), id));
            showToast('Аккаунт удален', 'success');
            closeModal('modal-manage-editor');
        } catch(e) { showToast('Ошибка удаления', 'error'); }
    });
};

window.saveEditorManagement = async function() {
    const id = document.getElementById('manage-editor-id').value;
    const newPass = document.getElementById('manage-new-pass').value;
    const newLogin = document.getElementById('manage-new-login').value.trim();

    try {
        await ensureAuth();
        const updateData = {};
        const newName = document.getElementById('manage-new-name').value.trim();
        if(newPass) updateData.passwordHash = CryptoJS.SHA256(newPass).toString();
        if(newLogin) updateData.login = newLogin;
        if(newName) updateData.name = newName;
        
        if(Object.keys(updateData).length > 0) {
            await updateDoc(doc(db, ...BASE('editors'), id), updateData);
            showToast('Данные монтажера обновлены', 'success');
        } else {
            showToast('Изменений не обнаружено', 'info');
        }
        closeModal('modal-manage-editor');
    } catch(e) { showToast('Ошибка сохранения', 'error'); }
};

window.openManageEditorModal = function(id) {
    const e = _editors.find(ed => ed.id === id);
    if (!e) return;

    document.getElementById('manage-editor-id').value = id;
    document.getElementById('manage-editor-title').textContent = e.name || e.login;
    document.getElementById('manage-editor-login-label').textContent = `@${e.login}`;
    
    document.getElementById('m-stat-closed').textContent = _projects.filter(p => p.editorId === id && p.stage === 'done').length;
    document.getElementById('m-stat-rating').textContent = window.getEditorRating(id);
    document.getElementById('manage-new-name').value = e.name || '';
    document.getElementById('manage-new-login').value = e.login || '';
    document.getElementById('manage-new-pass').value = '';

    const blockBtn = document.getElementById('btn-block-editor');
    blockBtn.innerHTML = e.isBlocked ? 'Разблокировать' : 'Заблокировать';

    openModal('modal-manage-editor');
};

window.openEditProjectModal = function(id) {
    const p = _projects.find(proj => proj.id === id);
    if (!p) return;
    
    document.getElementById('form-project-id').value = id;
    document.getElementById('project-modal-title').textContent = 'Редактировать проект';
    document.getElementById('p-name').value = p.projectName || '';
    document.getElementById('p-client').value = p.clientName || '';
    document.getElementById('p-access-code').value = p.accessCode || '';
    document.getElementById('p-client-category').value = p.clientCategory || '';
    document.getElementById('p-tk-link').value = p.tkLink || '';

    // Populating video characteristics
    document.getElementById('p-video-format').value = p.videoFormat || '9:16';
    document.getElementById('p-video-resolution').value = p.videoResolution || '1080p';
    document.getElementById('p-video-duration').value = p.videoDuration || '';
    document.getElementById('p-video-subtitles').value = p.videoSubtitles || 'yes_animated';
    document.getElementById('p-video-platform').value = p.videoPlatform || '';
    document.getElementById('p-video-music').value = p.videoMusic || '';
    document.getElementById('p-video-reference').value = p.videoReference || '';
    document.getElementById('p-video-sources').value = p.videoSources || '';

    if(p.deadline) {
        const d = new Date(p.deadline); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        document.getElementById('p-deadline').value = d.toISOString().slice(0,16);
    }
    document.getElementById('p-base-salary').value = p.baseSalary || '';
    
    // Client extra services render inside the Project Modal
    const clientExtraContainer = document.getElementById('p-client-extra-services-container');
    clientExtraContainer.innerHTML = '';
    if (p.clientExtraServices && Array.isArray(p.clientExtraServices)) {
        p.clientExtraServices.forEach(item => {
            addClientExtraServiceRow(item.name, item.price);
        });
    } else if (p.extraSalary) {
        addClientExtraServiceRow('Дополнительные услуги', p.extraSalary);
    }
    document.getElementById('p-client-extra-salary').value = p.extraSalary || 0;

    document.getElementById('p-editor-salary').value = p.editorSalary || '';
    
    const container = document.getElementById('p-extra-services-container');
    container.innerHTML = '';
    if (p.editorExtraServices && Array.isArray(p.editorExtraServices)) {
        p.editorExtraServices.forEach(item => {
            addExtraServiceRow(item.name, item.price);
        });
    } else if (p.editorExtraSalary) {
        addExtraServiceRow('Дополнительные услуги', p.editorExtraSalary);
    }
    document.getElementById('p-editor-extra-salary').value = p.editorExtraSalary || 0;
    
    document.getElementById('p-editor-bonus-name').value = p.editorBonusName || '';
    document.getElementById('p-editor-bonus-type').value = p.editorBonusType || 'rub';
    document.getElementById('p-editor-bonus-value').value = p.editorBonusValue || '';

    const penaltiesContainer = document.getElementById('p-penalties-container');
    penaltiesContainer.innerHTML = '';
    if (p.editorPenalties && Array.isArray(p.editorPenalties)) {
        p.editorPenalties.forEach(item => {
            addPenaltyRow(item.name, item.value, item.type);
        });
    } else {
        recalculatePenaltyTotal();
    }

    document.getElementById('p-notes').value = p.notes || '';
    document.getElementById('p-progress').value = p.progress || 0;
    document.getElementById('p-stage').value = p.stage || 'brief';
    document.getElementById('p-progress-display').textContent = `${p.progress}%`;
    
    const sel = document.getElementById('p-editor-id');
    sel.innerHTML = _editors.map(e => `<option value="${e.id}" ${e.id === p.editorId ? 'selected' : ''}>${e.name || e.login}</option>`).join('');
    
    openModal('modal-project');
    
    setTimeout(() => {
        const notesEl = document.getElementById('p-notes');
        if (notesEl) {
            const counter = document.getElementById('p-notes-counter');
            if (counter) counter.textContent = `${notesEl.value.length} / 800`;
        }
    }, 50);
};

window.saveProject = async function() {
    const id = document.getElementById('form-project-id').value;
    const editorId = document.getElementById('p-editor-id').value;
    
    // Client extra services list build
    const clientExtraServices = [];
    const clientRows = document.querySelectorAll('#p-client-extra-services-container > div');
    clientRows.forEach(row => {
        const nameInput = row.querySelector('.ces-service-name');
        const priceInput = row.querySelector('.ces-price-input');
        if (!nameInput || !priceInput) return;
        const name = nameInput.value.trim();
        const price = parseFloat(priceInput.value) || 0;
        if(name) {
            clientExtraServices.push({ name, price });
        }
    });

    // Editor extra services list build
    const extraServices = [];
    const rows = document.querySelectorAll('#p-extra-services-container > div');
    rows.forEach(row => {
        const nameInput = row.querySelector('.es-service-name');
        const priceInput = row.querySelector('.es-price-input');
        if (!nameInput || !priceInput) return;
        const name = nameInput.value.trim();
        const price = parseFloat(priceInput.value) || 0;
        if(name) {
            extraServices.push({ name, price });
        }
    });

    // Editor penalties list build
    const editorPenalties = [];
    const penaltyRows = document.querySelectorAll('#p-penalties-container > div');
    penaltyRows.forEach(row => {
        const nameInput = row.querySelector('.pen-name');
        const valueInput = row.querySelector('.pen-value');
        const typeSelect = row.querySelector('.pen-type');
        if (!nameInput || !valueInput) return;
        const name = nameInput.value.trim();
        const value = parseFloat(valueInput.value) || 0;
        const type = typeSelect ? typeSelect.value : 'rub';
        if (name && value > 0) {
            editorPenalties.push({ name, value, type });
        }
    });

    const clientExtraSum = clientExtraServices.reduce((sum, item) => sum + item.price, 0);

    const projData = {
        projectName: document.getElementById('p-name').value.trim(),
        clientName: document.getElementById('p-client').value.trim(),
        accessCode: document.getElementById('p-access-code').value.trim().toLowerCase(),
        clientCategory: document.getElementById('p-client-category').value.trim(),
        tkLink: document.getElementById('p-tk-link').value.trim(),
        editorId: editorId,
        deadline: new Date(document.getElementById('p-deadline').value).toISOString(),
        
        // Video Specs Sync
        videoFormat: document.getElementById('p-video-format').value,
        videoResolution: document.getElementById('p-video-resolution').value,
        videoDuration: document.getElementById('p-video-duration').value.trim(),
        videoSubtitles: document.getElementById('p-video-subtitles').value,
        videoPlatform: document.getElementById('p-video-platform').value.trim(),
        videoMusic: document.getElementById('p-video-music').value.trim(),
        videoReference: document.getElementById('p-video-reference').value.trim(),
        videoSources: document.getElementById('p-video-sources').value.trim(),

        // Client Money
        baseSalary: parseInt(document.getElementById('p-base-salary').value) || 0,
        basePrice: parseInt(document.getElementById('p-base-salary').value) || 0,
        clientExtraServices: clientExtraServices,
        extraSalary: clientExtraSum,
        
        // Editor Money
        editorSalary: parseInt(document.getElementById('p-editor-salary').value) || 0,
        editorExtraServices: extraServices,
        editorExtraSalary: parseFloat(document.getElementById('p-editor-extra-salary').value) || 0,
        editorBonusName: document.getElementById('p-editor-bonus-name').value.trim(),
        editorBonusType: document.getElementById('p-editor-bonus-type').value,
        editorBonusValue: parseInt(document.getElementById('p-editor-bonus-value').value) || 0,
        editorPenalties: editorPenalties,

        notes: document.getElementById('p-notes').value.trim(),
        progress: parseInt(document.getElementById('p-progress').value) || 0,
        stage: document.getElementById('p-stage').value,
        updatedAt: new Date().toISOString()
    };
    
    try {
        await ensureAuth();
        if (id) {
            await updateDoc(doc(db, ...BASE('projects'), id), projData);
            showToast('Информация обновлена в базе', 'success');
        } else {
            projData.createdAt = new Date().toISOString();
            projData.timeSpent = 0;
            projData.timerStatus = 'stopped';
            await addDoc(collection(db, ...BASE('projects')), projData);
            sendNotification(editorId, 'Новый проект', `Вам назначен новый проект: "${projData.projectName}"`);
            showToast('Новый проект успешно создан', 'success');
        }
        closeModal('modal-project');
    } catch(e) { showToast('Сбой синхронизации проекта', 'error'); }
};

window.openReviewModal = function(subId, projId, edId, btnEl) {
    const edComment = btnEl ? btnEl.getAttribute('data-comment') : '';
    document.getElementById('review-submission-id').value = subId;
    document.getElementById('review-project-id').value = projId;
    document.getElementById('review-editor-id').value = edId;
    document.getElementById('review-editor-comment').textContent = edComment || 'Комментарии отсутствуют';
    document.getElementById('review-admin-reply').value = '';
    setReviewRating(0);
    openModal('modal-review-submission');
    
    setTimeout(() => {
        const replyEl = document.getElementById('review-admin-reply');
        if (replyEl) {
            const counter = document.getElementById('review-admin-reply-counter');
            if (counter) counter.textContent = `${replyEl.value.length} / 800`;
        }
    }, 50);
};

window.setReviewRating = function(val) {
    document.getElementById('review-rating-val').value = val;
    const stars = document.querySelectorAll('#admin-star-rating i');
    stars.forEach((s, idx) => {
        if (idx < val) {
            s.className = 'fas fa-star text-xl text-amber-400 cursor-pointer hover:scale-110 transition';
        } else {
            s.className = 'far fa-star text-xl text-slate-700 cursor-pointer hover:scale-110 transition';
        }
    });
};

window.submitReview = async function(isApproved) {
    const subId = document.getElementById('review-submission-id').value;
    const projId = document.getElementById('review-project-id').value;
    const edId = document.getElementById('review-editor-id').value;
    const rating = parseInt(document.getElementById('review-rating-val').value) || 0;
    const reply = document.getElementById('review-admin-reply').value.trim();
    
    if (isApproved && rating === 0) { showToast('Установите оценку качества проекта', 'error'); return; }
    if (!isApproved && !reply) { showToast('Укажите замечания для доработки', 'error'); return; }

    try {
        await ensureAuth();
        const subRef = doc(db, ...BASE('submissions'), subId);
        const projRef = doc(db, ...BASE('projects'), projId);
        const projName = _projects.find(p => p.id === projId)?.projectName;

        if (isApproved) {
            await updateDoc(subRef, { status: 'approved', adminReply: reply, rating, resolvedAt: new Date().toISOString() });
            await updateDoc(projRef, { progress: 100, stage: 'done', rating });
            sendNotification(edId, 'Проект принят!', `Ваша работа по проекту "${projName}" успешно принята. Выплата зачислена.`);
            showToast('Проект принят и архивирован', 'success');
        } else {
            await updateDoc(subRef, { status: 'rejected', adminReply: reply, resolvedAt: new Date().toISOString() });
            await updateDoc(projRef, { progress: 80, stage: 'edit' });
            sendNotification(edId, 'Корректировки проекта', `Проект "${projName}" отправлен на доработку. Замечания: ${reply}`);
            showToast('Возвращено в доработку', 'info');
        }
        closeModal('modal-review-submission');
    } catch(e) { showToast('Ошибка фиксации статуса', 'error'); }
};

window.toggleNotifications = function() {
    const dropdown = document.getElementById('notifications-dropdown');
    if (!dropdown) return;
    const isHidden = dropdown.classList.contains('hidden');
    
    if (isHidden) {
        dropdown.classList.remove('hidden');
        setTimeout(() => { dropdown.classList.remove('opacity-0', 'scale-95'); }, 50);
        markAllNotificationsRead(); // Автоматически помечаем как прочитанные
    } else {
        dropdown.classList.add('opacity-0', 'scale-95');
        setTimeout(() => { dropdown.classList.add('hidden'); }, 200);
    }
};

async function sendNotification(userId, title, text) {
    try {
        await addDoc(collection(db, ...BASE('notifications')), {
            userId, title, text, read: false, createdAt: new Date().toISOString()
        });
    } catch(e) { console.error('Notif error', e); }
}

function renderNotifications() {
    const list = document.getElementById('notifications-list');
    const badge = document.getElementById('nav-notif-badge');
    const badgeMobile = document.getElementById('nav-notif-badge-mobile');
    if (!list) return;
    
    const myNotifs = _notifications.filter(n => n.userId === 'owner')
                                   .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    const unread = myNotifs.filter(n => !n.read).length;
    
    if (unread > 0) {
        if (badge) { badge.classList.remove('hidden'); badge.classList.add('animate-pulse'); }
        if (badgeMobile) { badgeMobile.classList.remove('hidden'); badgeMobile.classList.add('animate-pulse'); }
    } else {
        if (badge) badge.classList.add('hidden');
        if (badgeMobile) badgeMobile.classList.add('hidden');
    }

    list.innerHTML = myNotifs.map(n => `
        <div class="p-4 hover:bg-white/[0.02] transition-colors duration-200 ${n.read ? 'opacity-50' : 'bg-indigo-955/10'}">
            <h5 class="text-[10px] font-bold text-indigo-300 font-space mb-1 uppercase tracking-wide">${escapeHtml(n.title)}</h5>
            <p class="text-[11px] text-slate-300 leading-relaxed">${escapeHtml(n.text)}</p>
            <span class="text-[8px] text-slate-600 mt-2 block font-mono">${new Date(n.createdAt).toLocaleString('ru')}</span>
        </div>
    `).join('') || '<div class="p-6 text-center text-xs text-slate-500 font-light font-space">Входящий поток пуст</div>';
}

window.markAllNotificationsRead = async function() {
    try {
        const myNotifs = _notifications.filter(n => n.userId === 'owner' && !n.read);
        for (const n of myNotifs) {
            await updateDoc(doc(db, ...BASE('notifications'), n.id), { read: true });
        }
    } catch(e) {}
};

window.deleteAllNotifications = async function() {
    try {
        const myNotifs = _notifications.filter(n => n.userId === 'owner');
        for (const n of myNotifs) {
            await deleteDoc(doc(db, ...BASE('notifications'), n.id));
        }
        showToast('Все уведомления удалены', 'success');
    } catch(e) {}
};

window.openAdminSettingsModal = function() {
    renderAdminChecklist();
    openModal('modal-admin-settings');
};

function renderAdminChecklist() {
    const c = document.getElementById('admin-checklist-items');
    c.innerHTML = _globalChecklist.map((item, idx) => `
        <div class="flex items-center justify-between bg-black/40 border border-white/5 p-3 rounded-xl group transition-all duration-200">
            <span class="text-xs text-slate-300 font-light">${item}</span>
            <button onclick="removeChecklistItem(${idx})" class="text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"><i class="fas fa-trash-can text-[10px]"></i></button>
        </div>
    `).join('');
}

window.addChecklistItem = async function() {
    const input = document.getElementById('new-checklist-item');
    const val = input.value.trim();
    if (!val) return;
    _globalChecklist.push(val);
    input.value = '';
    await saveChecklist();
    renderAdminChecklist();
};

window.removeChecklistItem = async function(idx) {
    _globalChecklist.splice(idx, 1);
    await saveChecklist();
    renderAdminChecklist();
};

async function saveChecklist() {
    try {
        await setDoc(doc(db, ...BASE('site_config'), 'main'), {
            checklist: _globalChecklist
        }, { merge: true });
        showToast('Чек-лист сохранен', 'success');
    } catch(e) {
        showToast('Ошибка сохранения чек-листа', 'error');
    }
}

window.updateAdminCredentials = async function() {
    const loginEl = document.getElementById('admin-login-input');
    const passEl = document.getElementById('admin-pass-input');
    const newLogin = loginEl.value.trim();
    const newPass = passEl.value;

    if (!newLogin && !newPass) {
        showToast('Заполните логин и/или пароль для изменения', 'error');
        return;
    }
    if (newPass && newPass.length < 6) {
        showToast('Пароль должен быть не короче 6 символов', 'error');
        return;
    }

    const update = {};
    if (newLogin) update.ownerLogin = newLogin;
    if (newPass) update.adminPassHash = CryptoJS.SHA256(newPass).toString();

    try {
        await setDoc(doc(db, ...BASE('site_config'), 'main'), update, { merge: true });
        loginEl.value = '';
        passEl.value = '';
        showToast('Доступ администратора обновлён', 'success');
    } catch(e) {
        showToast('Ошибка сохранения учётных данных', 'error');
    }
};

// Global textareas counter handler
document.addEventListener('input', (e) => {
    if (e.target && e.target.tagName === 'TEXTAREA' && e.target.hasAttribute('maxlength')) {
        const max = e.target.getAttribute('maxlength');
        const counter = document.getElementById(e.target.id + '-counter');
        if (counter) {
            counter.textContent = `${e.target.value.length} / ${max}`;
        }
    }
});

window.onload = function() {
    setupPWA();
    checkSession();
};