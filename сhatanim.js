/**
 * SPACE — Модуль премиальных микроанимаций (Apple & Telegram style)
 * * Данный файл является дополняющим и подключается к основному файлу space_chat_special (1).html.
 * Он автоматически внедряет CSS-эффекты, перехватывает события интерфейса и добавляет:
 * 1. Telegram-style распад (взрыв на пиксели-частицы) при удалении сообщений.
 * 2. Apple-style пружинящее появление новых сообщений (Spring physics).
 * 3. Тактильную упругую деформацию поля ввода при отправке.
 * 4. Желейный микро-bounce реакций при установке и подпрыгивание при повторном клике.
 * 5. Telegram-style плавную волну анимированных точек набора текста.
 * 6. Плавное всплывание кнопки «Вниз» с эффектом размытия (backdrop-blur).
 */

(function () {
    'use strict';

    // ─── 1. ДИНАМИЧЕСКОЕ ВНЕДРЕНИЕ СТИЛЕЙ (CSS) ───
    const styleId = 'space-premium-animations-styles';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            /* Apple-style физика появления сообщений (Spring Effect) */
            .msg-row {
                opacity: 0;
                transform: translateY(16px) scale(0.96);
                animation: appleSpringIn 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) forwards !important;
                will-change: transform, opacity;
            }
            
            @keyframes appleSpringIn {
                to {
                    opacity: 1;
                    transform: translateY(0) scale(1);
                }
            }

            /* Премиальный Hover для пузырей сообщений */
            .bubble {
                transition: transform 0.15s cubic-bezier(0.2, 0.8, 0.2, 1), background-color 0.15s ease !important;
            }
            .bubble:hover {
                transform: translateY(-0.5px);
            }
            .bubble:active {
                transform: scale(0.985);
            }

            /* Желейная упругая анимация для реакций (Bounce & Bubble In) */
            .reaction-badge {
                animation: reactionBubbleIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) both !important;
                transition: transform 0.15s cubic-bezier(0.2, 0.8, 0.2, 1), background-color 0.15s ease !important;
            }
            .reaction-badge:hover {
                transform: scale(1.1) translateY(-1px);
            }
            .reaction-badge:active {
                transform: scale(0.95);
            }

            @keyframes reactionBubbleIn {
                0% { transform: scale(0.4); opacity: 0; }
                50% { transform: scale(1.15); }
                100% { transform: scale(1); opacity: 1; }
            }

            /* Анимация тактильного отклика при клике на активную реакцию */
            .reaction-badge-bounce {
                animation: reactionTactileBounce 0.32s cubic-bezier(0.36, 0.07, 0.19, 0.97) both !important;
            }

            @keyframes reactionTactileBounce {
                0%, 100% { transform: scale(1); }
                30% { transform: scale(0.8) translateY(-2px); }
                60% { transform: scale(1.22) translateY(-4px); }
                80% { transform: scale(0.95) translateY(1px); }
            }

            /* Тройные точки набора текста Telegram Style (Волновой эффект) */
            #typing-indicator .animate-bounce {
                animation: none !important; /* Отключаем стандартный прыжок */
            }
            .premium-typing-dot {
                width: 5px;
                height: 5px;
                background-color: #94a3b8;
                border-radius: 50%;
                display: inline-block;
                animation: tgTypingWave 1.4s infinite ease-in-out both;
                margin: 0 1.5px;
            }
            .premium-typing-dot:nth-child(1) { animation-delay: -0.32s; }
            .premium-typing-dot:nth-child(2) { animation-delay: -0.16s; }
            .premium-typing-dot:nth-child(3) { animation-delay: 0s; }

            @keyframes tgTypingWave {
                0%, 80%, 100% { transform: scale(0.5); opacity: 0.35; }
                40% { transform: scale(1.15); opacity: 1; }
            }

            /* Кнопка скролла Apple-style со сдвигом и размытием */
            #scroll-btn {
                backdrop-filter: blur(12px) !important;
                -webkit-backdrop-filter: blur(12px) !important;
                background: rgba(99, 102, 241, 0.8) !important;
                border: 1px solid rgba(255, 255, 255, 0.08) !important;
                transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1) !important;
                transform: translateY(20px) scale(0.8) !important;
                opacity: 0;
            }
            #scroll-btn:not(.hidden) {
                display: flex !important;
                opacity: 1 !important;
                transform: translateY(0) scale(1) !important;
            }
            #scroll-btn:hover {
                background: rgba(99, 102, 241, 0.95) !important;
                transform: translateY(-2px) scale(1.05) !important;
            }
            #scroll-btn:active {
                transform: translateY(1px) scale(0.95) !important;
            }

            /* Контейнер Canvas для частиц распада */
            #space-particle-canvas {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 9999;
            }
        `;
        document.head.appendChild(style);
    }

    // ─── 2. ИНИЦИАЛИЗАЦИЯ ИНСТРУМЕНТОВ ЭФФЕКТОВ ───
    let canvas, ctx;
    const activeParticles = [];

    // Создаем Canvas слой для отрисовки эффекта взрыва пикселей из Telegram
    function initCanvas() {
        if (document.getElementById('space-particle-canvas')) return;
        canvas = document.createElement('canvas');
        canvas.id = 'space-particle-canvas';
        const mainArea = document.getElementById('main');
        if (mainArea) {
            mainArea.appendChild(canvas);
            ctx = canvas.getContext('2d');
            resizeCanvas();
            window.addEventListener('resize', resizeCanvas);
            requestAnimationFrame(updateParticles);
        }
    }

    function resizeCanvas() {
        if (!canvas) return;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;
    }

    // Класс частицы для физической симуляции распада
    class Particle {
        constructor(x, y, color) {
            this.x = x;
            this.y = y;
            this.color = color;
            this.size = Math.random() * 3 + 1.5;
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 4 + 1.5;
            this.vx = Math.cos(angle) * speed;
            this.vy = Math.sin(angle) * speed - 1.5; // Смещение вектора взрыва вверх
            this.alpha = 1;
            this.decay = Math.random() * 0.02 + 0.02;
            this.gravity = 0.06;
        }

        update() {
            this.x += this.vx;
            this.vy += this.gravity;
            this.y += this.vy;
            this.alpha -= this.decay;
        }

        draw() {
            ctx.save();
            ctx.globalAlpha = this.alpha;
            ctx.fillStyle = this.color;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    function updateParticles() {
        if (!canvas) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        for (let i = activeParticles.length - 1; i >= 0; i--) {
            const p = activeParticles[i];
            p.update();
            if (p.alpha <= 0) {
                activeParticles.splice(i, 1);
            } else {
                p.draw();
            }
        }
        requestAnimationFrame(updateParticles);
    }

    // Триггер запуска взрыва на пиксели (Telegram disintegrate effect)
    function triggerDisintegration(element, hexColor) {
        if (!canvas) initCanvas();
        const elementRect = element.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        
        // Перевод координат элемента относительно Canvas
        const relX = elementRect.left - canvasRect.left;
        const relY = elementRect.top - canvasRect.top;

        const density = 60; // Плотность потока взрывающихся пикселей
        for (let i = 0; i < density; i++) {
            const px = relX + Math.random() * elementRect.width;
            const py = relY + Math.random() * elementRect.height;
            activeParticles.push(new Particle(px, py, hexColor));
        }
    }

    // ─── 3. ИНТЕГРАЦИЯ И ДЕКОРИРОВАНИЕ ДЕЙСТВИЙ ИНТЕРФЕЙСА ───

    // Анимация отправки: Пружинистое сжатие текстового поля при отправке
    const hookSendAnimation = () => {
        const sendBtn = document.getElementById('send-btn');
        const inputArea = document.getElementById('input-area');
        if (sendBtn && inputArea) {
            sendBtn.addEventListener('click', () => {
                inputArea.style.transform = 'scale(0.98) translateY(2px)';
                setTimeout(() => {
                    inputArea.style.transform = 'scale(1) translateY(0)';
                }, 120);
            });
        }
    };

    // Перехватываем деструктивное действие (Удаление сообщения)
    const hookDeleteAction = () => {
        // Декорируем глобальную функцию ctxDelete
        const originalCtxDelete = window.ctxDelete;
        if (typeof originalCtxDelete === 'function') {
            window.ctxDelete = async function() {
                const msgId = window._ctxMsgId; // Используем контекстный ID сообщения
                if (msgId) {
                    const row = document.querySelector(`[data-msgid="${msgId}"]`);
                    if (row) {
                        const bubble = row.querySelector('.bubble');
                        const isMine = row.classList.contains('mine');
                        const color = isMine ? '#232235' : '#12111E'; // Оптимальные цвета под темы

                        // Запускаем распад частиц
                        triggerDisintegration(bubble, color);

                        // Мягко растворяем и сжимаем строку сообщения в DOM перед очисткой Firebase
                        row.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
                        row.style.opacity = '0';
                        row.style.transform = 'scale(0.85) translateY(-10px)';
                        row.style.maxHeight = '0px';
                        row.style.marginBottom = '0px';
                        row.style.paddingTop = '0px';
                        row.style.paddingBottom = '0px';
                    }
                }
                // Даем анимации проиграться перед вызовом оригинального удаления в бэкенд
                setTimeout(() => {
                    originalCtxDelete();
                }, 200);
            };
        }
    };

    // Перехватываем клик по реакциям для микро-bounce отклика
    const setupReactionBounceListener = () => {
        document.addEventListener('click', function(e) {
            const badge = e.target.closest('.reaction-badge');
            if (badge) {
                // Если реакция уже активна, добавляем упругий тактильный подпрыг
                if (badge.classList.contains('active')) {
                    badge.classList.remove('reaction-badge-bounce');
                    void badge.offsetWidth; // Сброс анимации (reflow)
                    badge.classList.add('reaction-badge-bounce');
                    
                    // Удаляем класс после завершения
                    setTimeout(() => {
                        badge.classList.remove('reaction-badge-bounce');
                    }, 350);
                }
            }
        });
    };

    // Перевод точек индикатора набора текста в премиальную плавную волну
    const setupPremiumTypingIndicator = () => {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) {
            const observer = new MutationObserver(() => {
                if (!indicator.classList.contains('hidden')) {
                    const dotWrap = indicator.querySelector('.flex.gap-1');
                    if (dotWrap && !dotWrap.querySelector('.premium-typing-dot')) {
                        dotWrap.innerHTML = `
                            <span class="premium-typing-dot"></span>
                            <span class="premium-typing-dot"></span>
                            <span class="premium-typing-dot"></span>
                        `;
                    }
                }
            });
            observer.observe(indicator, { attributes: true, attributeFilter: ['class'] });
        }
    };

    // Плавный запуск при монтировании скрипта к DOM
    function init() {
        initCanvas();
        hookSendAnimation();
        hookDeleteAction();
        setupReactionBounceListener();
        setupPremiumTypingIndicator();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();