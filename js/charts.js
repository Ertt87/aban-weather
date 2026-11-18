import { MODEL_META, TIME_WINDOWS } from './config.js';
import { cToF, msToMph, formatSignedC } from './physics.js';

const CHART_PALETTE = {
    bg: '#060911',
    panel: '#0f172a',
    sky: '#38bdf8',
    amber: '#fbbf24',
    orange: '#fb923c',
    cyan: '#22d3ee',
    emerald: '#34d399',
    rose: '#fb7185',
    indigo: '#818cf8',
    violet: '#a78bfa',
    slateText: '#cbd5e1',
    mutedText: '#94a3b8',
    gridLine: 'rgba(148, 163, 184, 0.14)',
    axisLine: 'rgba(148, 163, 184, 0.28)'
};

const PHASE_COLORS = {
    snow: CHART_PALETTE.cyan,
    sleet: CHART_PALETTE.indigo,
    freezing_rain: CHART_PALETTE.rose,
    rain: CHART_PALETTE.emerald,
    dry: '#64748b'
};

const ZONE_META = {
    archive: { label: 'Архив', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.05)' },
    deterministic: { label: 'Точный 10д', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.045)' },
    extended_ensemble: { label: 'Ансамбль 11–16д', color: '#22d3ee', bg: 'rgba(34, 211, 238, 0.055)' },
    subseasonal: { label: 'Тренд 17–35д', color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.06)' }
};

const FALLBACK_MODEL_COLORS = ['#fb923c', '#a78bfa', '#34d399', '#f472b6', '#60a5fa', '#facc15'];

const containerBindings = new WeakMap();

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toNum(val, fallback = null) {
    if (val === null || val === undefined || val === '') return fallback;
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function getXCoordinate(index, count, w, padL, padR) {
    if (count <= 1) return (padL + (w - padR)) / 2;
    return padL + (index * (w - padL - padR)) / (count - 1);
}

function buildSegmentedPath(points) {
    const segments = [];
    let current = [];
    for (const pt of points) {
        if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
            if (current.length >= 2) segments.push(current);
            current = [];
            continue;
        }
        current.push(pt);
    }
    if (current.length >= 2) segments.push(current);

    return segments
        .map(seg => seg.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '))
        .join(' ');
}

function buildAreaPolygonPath(upperPts, lowerPts) {
    if (!Array.isArray(upperPts) || !Array.isArray(lowerPts) || upperPts.length < 2) return '';
    const segments = [];
    let curUpper = [];
    let curLower = [];

    for (let i = 0; i < upperPts.length; i++) {
        const u = upperPts[i];
        const l = lowerPts[i];
        if (u && l && Number.isFinite(u.x) && Number.isFinite(u.y) && Number.isFinite(l.x) && Number.isFinite(l.y)) {
            curUpper.push(u);
            curLower.push(l);
        } else {
            if (curUpper.length >= 2) {
                segments.push([curUpper, curLower]);
            }
            curUpper = [];
            curLower = [];
        }
    }
    if (curUpper.length >= 2) {
        segments.push([curUpper, curLower]);
    }

    return segments.map(([uSeg, lSeg]) => {
        const top = uSeg.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
        const bot = [...lSeg].reverse().map(p => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
        return `${top} ${bot} Z`;
    }).join(' ');
}

function tempVal(c, fOverride, unit = 'metric') {
    const numC = toNum(c);
    if (unit === 'imperial') {
        const numF = toNum(fOverride);
        if (numF !== null) return numF;
        return numC !== null ? cToF(numC) : null;
    }
    return numC;
}

function fmtTempCompact(c, fOverride, unit = 'metric') {
    const numC = toNum(c);
    if (unit === 'imperial') {
        const numF = toNum(fOverride) ?? (numC !== null ? cToF(numC) : null);
        return numF !== null ? `${Math.round(numF)}°` : '—';
    }
    if (numC === null) return '—';
    const formatted = String(formatSignedC(numC)).replace(/°C$/i, '°');
    return formatted.includes('°') ? formatted : `${formatted}°`;
}

function fmtTempFull(c, fOverride, unit = 'metric') {
    const numC = toNum(c);
    const numF = toNum(fOverride) ?? (numC !== null ? cToF(numC) : null);
    if (unit === 'imperial') {
        return numF !== null ? `${Math.round(numF)}°F` : '—';
    }
    if (numC === null) return '—';
    const raw = String(formatSignedC(numC));
    const cLabel = raw.includes('°C') ? raw : (raw.endsWith('°') ? `${raw}C` : `${raw}°C`);
    if (unit === 'dual' && numF !== null) {
        return `${cLabel} / ${Math.round(numF)}°F`;
    }
    return cLabel;
}

function windVal(ms, mphOverride, unit = 'metric') {
    const numMs = toNum(ms);
    if (unit === 'imperial') {
        const numMph = toNum(mphOverride);
        if (numMph !== null) return numMph;
        return numMs !== null ? msToMph(numMs) : null;
    }
    return numMs;
}

function resolvePrecipPhase(item) {
    const raw = String(
        item?.precipPhase ||
        item?.precipDayType ||
        item?.precipNightType ||
        ''
    ).toLowerCase().trim();

    if (raw === 'freezing_rain' || raw.includes('лед') || raw.includes('голол')) return 'freezing_rain';
    if (raw === 'sleet' || raw.includes('мокр')) return 'sleet';
    if (raw === 'snow' || raw.includes('снег')) return 'snow';
    if (raw === 'rain' || raw.includes('дожд')) return 'rain';
    if (raw === 'dry' || raw.includes('сух')) return 'dry';

    const t = toNum(item?.tempC ?? item?.maxC ?? item?.minC);
    if (t !== null && t <= 0.2) return 'snow';
    return 'rain';
}

function resolveDayZone(day) {
    if (day?.zone && ZONE_META[day.zone]) return day.zone;
    if (day?.isArchive) return 'archive';
    return 'deterministic';
}

function computeScaleBounds(values, pad = 2, fallbackMin = -5, fallbackMax = 5) {
    const valid = values.filter(v => Number.isFinite(v));
    if (!valid.length) return { min: fallbackMin, max: fallbackMax };
    let min = Math.min(...valid);
    let max = Math.max(...valid);
    if (max - min < 2) {
        const mid = (min + max) / 2;
        min = mid - 1.5;
        max = mid + 1.5;
    }
    return { min: min - pad, max: max + pad };
}

function renderEmptySvg(containerEl, message = 'Нет данных за выбранный период') {
    if (!containerEl) return '';
    const html = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 740 180" class="chart-svg-mobile" style="min-width:700px;height:180px" role="img" aria-label="${escapeHtml(message)}">
            <rect x="0" y="0" width="740" height="180" rx="12" fill="rgba(15,23,42,0.55)" stroke="rgba(148,163,184,0.14)"/>
            <text x="370" y="94" text-anchor="middle" fill="#94a3b8" font-size="14" font-family="JetBrains Mono, monospace">${escapeHtml(message)}</text>
        </svg>
    `;
    containerEl.innerHTML = html;
    return html;
}

function bindDayClickDelegation(containerEl, onSelectDay) {
    if (!containerEl || typeof containerEl.addEventListener !== 'function') return;

    let state = containerBindings.get(containerEl);
    if (!state) {
        state = {
            kind: 'day',
            onSelectDay: null,
            onSelectHour: null,
            slots: [],
            viewBoxW: 720,
            scrubActive: false,
            scrubPointerId: null,
            startX: 0,
            startY: 0,
            moved: false,
            suppressClickUntil: 0,
            lastNotifiedHour: null
        };
        containerBindings.set(containerEl, state);

        containerEl.addEventListener('click', (e) => {
            const cur = containerBindings.get(containerEl);
            if (!cur || typeof cur.onSelectDay !== 'function') return;
            const node = e.target?.closest?.('[data-day-id]');
            if (!node) return;
            const dayId = node.getAttribute('data-day-id');
            if (dayId) cur.onSelectDay(dayId);
        });

        containerEl.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const cur = containerBindings.get(containerEl);
            if (!cur || typeof cur.onSelectDay !== 'function') return;
            const node = e.target?.closest?.('[data-day-id]');
            if (!node) return;
            const dayId = node.getAttribute('data-day-id');
            if (dayId) {
                e.preventDefault();
                cur.onSelectDay(dayId);
            }
        });
    }

    state.onSelectDay = typeof onSelectDay === 'function' ? onSelectDay : null;
}

function resolveHourFromClientX(containerEl, state, clientX, targetEl) {
    const directAttr = targetEl?.closest?.('[data-hour]')?.getAttribute('data-hour');
    if (directAttr !== null && directAttr !== undefined && directAttr !== '') {
        const parsed = Number(directAttr);
        if (Number.isFinite(parsed)) return parsed;
    }
    const svg = containerEl.querySelector?.('svg');
    const rect = svg?.getBoundingClientRect?.();
    if (!rect || !rect.width || !state.slots?.length) return null;

    const svgX = ((clientX - rect.left) / rect.width) * state.viewBoxW;
    let bestHour = state.slots[0].hour;
    let bestDist = Infinity;
    for (const slot of state.slots) {
        const dist = Math.abs(slot.x - svgX);
        if (dist < bestDist) {
            bestDist = dist;
            bestHour = slot.hour;
        }
    }
    return bestHour;
}

function bindDiurnalScrubbing(containerEl, { onSelectHour, slots, viewBoxW }) {
    if (!containerEl || typeof containerEl.addEventListener !== 'function') return;

    let state = containerBindings.get(containerEl);
    if (!state) {
        state = {
            kind: 'diurnal',
            onSelectDay: null,
            onSelectHour: null,
            slots: [],
            viewBoxW,
            scrubActive: false,
            scrubPointerId: null,
            startX: 0,
            startY: 0,
            moved: false,
            suppressClickUntil: 0,
            lastNotifiedHour: null
        };
        containerBindings.set(containerEl, state);

        const notifyHour = (hour, force = false) => {
            if (hour === null || hour === undefined || typeof state.onSelectHour !== 'function') return;
            if (force || state.lastNotifiedHour !== hour) {
                state.lastNotifiedHour = hour;
                state.onSelectHour(hour);
            }
        };

        containerEl.addEventListener('pointerdown', (e) => {
            if (!state.slots?.length || typeof state.onSelectHour !== 'function') return;
            if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;

            const inScrubTrack = Boolean(e.target?.closest?.('[data-scrub-track="true"]'));
            const isTouch = e.pointerType === 'touch';

            // On touch, preserve native horizontal/vertical scrolling in the plot body;
            // continuous dragging activates on the dedicated scrub track rail.
            if (isTouch && !inScrubTrack) return;

            state.scrubActive = true;
            state.scrubPointerId = e.pointerId;
            state.startX = e.clientX ?? 0;
            state.startY = e.clientY ?? 0;
            state.moved = false;

            if (inScrubTrack) {
                try {
                    containerEl.setPointerCapture?.(e.pointerId);
                } catch {
                    // Ignore capture errors on synthetic events
                }
                const h = resolveHourFromClientX(containerEl, state, e.clientX ?? 0, null);
                if (h !== null) {
                    notifyHour(h);
                    state.suppressClickUntil = Date.now() + 250;
                }
            }
        });

        containerEl.addEventListener('pointermove', (e) => {
            if (!state.scrubActive) return;
            const dx = Math.abs((e.clientX ?? 0) - state.startX);
            const dy = Math.abs((e.clientY ?? 0) - state.startY);
            if (dx > 3 || dy > 3) state.moved = true;
            if (!state.moved && e.pointerType === 'mouse') return;

            const h = resolveHourFromClientX(containerEl, state, e.clientX ?? 0, null);
            if (h !== null) {
                notifyHour(h);
                state.suppressClickUntil = Date.now() + 250;
            }
        });

        const endScrub = (e) => {
            if (!state.scrubActive) return;
            try {
                if (state.scrubPointerId !== null) {
                    containerEl.releasePointerCapture?.(state.scrubPointerId);
                }
            } catch {
                // Ignore
            }
            if (!state.moved) {
                const h = resolveHourFromClientX(containerEl, state, e.clientX ?? 0, e.target);
                if (h !== null) {
                    notifyHour(h, true);
                    state.suppressClickUntil = Date.now() + 250;
                }
            }
            state.scrubActive = false;
            state.scrubPointerId = null;
        };

        containerEl.addEventListener('pointerup', endScrub);
        containerEl.addEventListener('pointercancel', endScrub);

        containerEl.addEventListener('click', (e) => {
            if (Date.now() < state.suppressClickUntil) return;
            if (!state.slots?.length || typeof state.onSelectHour !== 'function') return;
            const h = resolveHourFromClientX(containerEl, state, e.clientX ?? 0, e.target);
            if (h !== null) notifyHour(h, true);
        });

        containerEl.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const target = e.target?.closest?.('[data-hour]');
            if (!target || typeof state.onSelectHour !== 'function') return;
            const h = Number(target.getAttribute('data-hour'));
            if (Number.isFinite(h)) {
                e.preventDefault();
                notifyHour(h, true);
            }
        });
    }

    state.onSelectHour = typeof onSelectHour === 'function' ? onSelectHour : null;
    state.slots = slots;
    state.viewBoxW = viewBoxW;
}

// ============================================================================
// 1. WEATHER SVG ICON LIBRARY (12 CANONICAL STATES)
// ============================================================================
export function getWeatherSvg(iconType, sizeClass = 'w-10 h-10') {
    const safeClass = escapeHtml(sizeClass || 'w-10 h-10');
    const type = String(iconType || 'cloudy').toLowerCase().trim();

    switch (type) {
        case 'sunny':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <circle cx="32" cy="32" r="13" fill="#fbbf24" stroke="#f59e0b" stroke-width="2"/>
                <g stroke="#fbbf24" stroke-width="3" stroke-linecap="round">
                    <line x1="32" y1="8" x2="32" y2="13"/><line x1="32" y1="51" x2="32" y2="56"/>
                    <line x1="8" y1="32" x2="13" y2="32"/><line x1="51" y1="32" x2="56" y2="32"/>
                    <line x1="15" y1="15" x2="18.5" y2="18.5"/><line x1="45.5" y1="45.5" x2="49" y2="49"/>
                    <line x1="49" y1="15" x2="45.5" y2="18.5"/><line x1="18.5" y1="45.5" x2="15" y2="49"/>
                </g>
            </svg>`;

        case 'mostly-sunny':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <circle cx="25" cy="24" r="11" fill="#fbbf24" stroke="#f59e0b" stroke-width="1.5"/>
                <g stroke="#fbbf24" stroke-width="2.4" stroke-linecap="round">
                    <line x1="25" y1="7" x2="25" y2="10"/>
                    <line x1="8" y1="24" x2="11" y2="24"/>
                    <line x1="13" y1="12" x2="15.5" y2="14.5"/>
                    <line x1="37" y1="12" x2="34.5" y2="14.5"/>
                </g>
                <path d="M25 47H47C52 47 55 43.5 55 39C55 34.8 51.8 31.5 47.5 31C46.2 25.2 41 21 35 21C28.8 21 23.6 25.5 23 31.8C19 32.5 16 35.8 16 39.8C16 43.8 19.5 47 24 47H25Z" fill="#cbd5e1" fill-opacity="0.92" stroke="#e2e8f0" stroke-width="1.4"/>
            </svg>`;

        case 'partly-sunny':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <circle cx="23" cy="23" r="10" fill="#fbbf24"/>
                <path d="M22 46H46C51.5 46 55 42 55 37C55 32.5 51.5 29 47 28.5C45.5 21.5 39 17 32 17C24.5 17 18.5 22.5 18 30C13.5 30.8 10 34.5 10 39C10 43 13.5 46 18 46H22Z" fill="#94a3b8" fill-opacity="0.92" stroke="#cbd5e1" stroke-width="1.5"/>
            </svg>`;

        case 'cloudy':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M26 36H48C52.5 36 56 32.5 56 28.5C56 24.5 52.8 21.2 48.8 20.8C47.5 15 42.2 11 36 11C29.8 11 24.6 15.2 24 21.2C20.2 21.8 17.5 25 17.5 28.8C17.5 32.8 21 36 26 36Z" fill="#475569" stroke="#64748b" stroke-width="1.3"/>
                <path d="M18 48H45C50 48 54 44.2 54 39.5C54 35.2 50.5 31.6 46 31.1C44.5 24.2 38.5 19.5 31.5 19.5C24.2 19.5 18.5 24.8 18 32C13.5 32.8 10 36.2 10 40.5C10 44.8 13.5 48 18 48Z" fill="#64748b" stroke="#94a3b8" stroke-width="1.5"/>
            </svg>`;

        case 'rain-cloudy':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M18 41H44C49.5 41 53 37 53 32C53 27.5 49.5 24 45 23.5C43.5 16.5 37 12 30 12C22.5 12 16.5 17.5 16 25C11.5 25.8 8 29.5 8 34C8 38 11.5 41 16 41H18Z" fill="#64748b" stroke="#94a3b8" stroke-width="1.5"/>
                <g stroke="#34d399" stroke-width="2.8" stroke-linecap="round">
                    <line x1="22" y1="46" x2="19" y2="54"/>
                    <line x1="32" y1="46" x2="29" y2="54"/>
                    <line x1="42" y1="46" x2="39" y2="54"/>
                </g>
            </svg>`;

        case 'sleet':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M18 40H44C49.5 40 53 36 53 31C53 26.5 49.5 23 45 22.5C43.5 15.5 37 11 30 11C22.5 11 16.5 16.5 16 24C11.5 24.8 8 28.5 8 33C8 37 11.5 40 16 40H18Z" fill="#64748b" stroke="#94a3b8" stroke-width="1.5"/>
                <line x1="21" y1="45" x2="18.5" y2="52.5" stroke="#34d399" stroke-width="2.6" stroke-linecap="round"/>
                <circle cx="31" cy="49.5" r="2.8" fill="#818cf8" stroke="#c7d2fe" stroke-width="1"/>
                <line x1="41" y1="45" x2="38.5" y2="52.5" stroke="#38bdf8" stroke-width="2.6" stroke-linecap="round"/>
                <circle cx="46" cy="52" r="2.2" fill="#22d3ee"/>
            </svg>`;

        case 'freezing-rain':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M18 39H44C49.5 39 53 35 53 30C53 25.5 49.5 22 45 21.5C43.5 14.5 37 10 30 10C22.5 10 16.5 15.5 16 23C11.5 23.8 8 27.5 8 32C8 36 11.5 39 16 39H18Z" fill="#64748b" stroke="#fb7185" stroke-width="1.5"/>
                <g stroke="#fb7185" stroke-width="2.6" stroke-linecap="round">
                    <line x1="22" y1="43" x2="20" y2="49"/>
                    <line x1="32" y1="43" x2="30" y2="49"/>
                    <line x1="42" y1="43" x2="40" y2="49"/>
                </g>
                <line x1="14" y1="54" x2="50" y2="54" stroke="#22d3ee" stroke-width="2.5" stroke-linecap="round"/>
                <circle cx="20" cy="54" r="2" fill="#fb7185"/>
                <circle cx="30" cy="54" r="2" fill="#fb7185"/>
                <circle cx="40" cy="54" r="2" fill="#fb7185"/>
            </svg>`;

        case 'snow':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M18 41H44C49.5 41 53 37 53 32C53 27.5 49.5 24 45 23.5C43.5 16.5 37 12 30 12C22.5 12 16.5 17.5 16 25C11.5 25.8 8 29.5 8 34C8 38 11.5 41 16 41H18Z" fill="#94a3b8" stroke="#cbd5e1" stroke-width="1.5"/>
                <g stroke="#22d3ee" stroke-width="2" stroke-linecap="round">
                    <line x1="21" y1="47" x2="21" y2="53"/><line x1="18" y1="50" x2="24" y2="50"/>
                    <line x1="32" y1="49" x2="32" y2="55"/><line x1="29" y1="52" x2="35" y2="52"/>
                    <line x1="43" y1="47" x2="43" y2="53"/><line x1="40" y1="50" x2="46" y2="50"/>
                </g>
            </svg>`;

        case 'cloudy-snow':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M18 41H44C49.5 41 53 37 53 32C53 27.5 49.5 24 45 23.5C43.5 16.5 37 12 30 12C22.5 12 16.5 17.5 16 25C11.5 25.8 8 29.5 8 34C8 38 11.5 41 16 41H18Z" fill="#64748b" stroke="#94a3b8" stroke-width="1.5"/>
                <circle cx="20" cy="48" r="2.6" fill="#38bdf8"/>
                <circle cx="30" cy="53" r="2.8" fill="#22d3ee"/>
                <circle cx="40" cy="48" r="2.6" fill="#7dd3fc"/>
                <circle cx="47" cy="54" r="2.2" fill="#38bdf8"/>
            </svg>`;

        case 'clear-night':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M41 37C33.8 37 28 31.2 28 24C28 19.8 30 16 33 13.7C24.5 14.8 18 22 18 30.8C18 40.3 25.7 48 35.2 48C42.5 48 48.8 43.4 51.3 37C48.2 37 44.5 37 41 37Z" fill="#818cf8" stroke="#a5b4fc" stroke-width="1.5"/>
                <circle cx="46" cy="18" r="2" fill="#fde047"/>
                <circle cx="52" cy="27" r="1.4" fill="#e0e7ff"/>
            </svg>`;

        case 'partly-cloudy-night':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M29 27C25.5 27 22.7 24.2 22.7 20.7C22.7 18.6 23.7 16.7 25.2 15.6C21 16.1 17.8 19.7 17.8 24.1C17.8 28.8 21.6 32.6 26.3 32.6C29.9 32.6 33.1 30.3 34.3 27.1C32.8 27 31 27 29 27Z" fill="#818cf8" stroke="#a5b4fc" stroke-width="1.3"/>
                <circle cx="44" cy="17" r="1.6" fill="#fde047"/>
                <path d="M21 48H46C51 48 54.5 44.2 54.5 39.5C54.5 35.2 51 31.8 46.5 31.2C45 24.6 39 20 32.2 20C25 20 19.2 25.2 18.6 32.2C14.3 33 11 36.4 11 40.5C11 44.8 14.5 48 19 48H21Z" fill="#475569" fill-opacity="0.92" stroke="#94a3b8" stroke-width="1.5"/>
            </svg>`;

        case 'fog':
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M19 34H44C48.5 34 52 30.6 52 26.5C52 22.6 49 19.4 45 19C43.5 13 38 9 31.5 9C24.8 9 19.5 13.8 19 20.2C15 21 12 24.2 12 27.8C12 31.4 15.2 34 19 34Z" fill="#64748b" fill-opacity="0.82" stroke="#94a3b8" stroke-width="1.4"/>
                <g stroke-width="3" stroke-linecap="round">
                    <line x1="12" y1="41" x2="52" y2="41" stroke="#94a3b8"/>
                    <line x1="16" y1="47.5" x2="48" y2="47.5" stroke="#cbd5e1"/>
                    <line x1="11" y1="54" x2="45" y2="54" stroke="#64748b"/>
                </g>
            </svg>`;

        default:
            return `<svg xmlns="http://www.w3.org/2000/svg" class="${safeClass}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M20 46H45C50 46 53.5 42.5 53.5 38C53.5 34 50 30.5 46 30C44.5 23.5 38.5 19.5 32 19.5C25 19.5 19.5 24.5 19 31.5C14.5 32.2 11.5 35.5 11.5 39.5C11.5 43.2 15 46 20 46Z" fill="#64748b" stroke="#94a3b8" stroke-width="1.5"/>
            </svg>`;
    }
}

// ============================================================================
// 2. DIURNAL 24-HOUR CHART (WITH SCRUBBING & SUBSEASONAL RANGE FALLBACK)
// ============================================================================
function renderSubseasonalDailyRangeCard(containerEl, day, uiState) {
    const unit = uiState?.unit || 'metric';
    const w = 740;
    const h = 235;
    const padL = 70;
    const padR = 48;

    const maxV = tempVal(day?.maxC, day?.maxF, unit);
    const minV = tempVal(day?.minC, day?.minF, unit);
    const p10Max = tempVal(day?.maxP10C, null, unit) ?? maxV;
    const p25Max = tempVal(day?.maxP25C, null, unit) ?? maxV;
    const p75Max = tempVal(day?.maxP75C, null, unit) ?? maxV;
    const p90Max = tempVal(day?.maxP90C, null, unit) ?? maxV;
    const p10Min = tempVal(day?.minP10C, null, unit) ?? minV;
    const p25Min = tempVal(day?.minP25C, null, unit) ?? minV;
    const p75Min = tempVal(day?.minP75C, null, unit) ?? minV;
    const p90Min = tempVal(day?.minP90C, null, unit) ?? minV;
    const climMax = tempVal(day?.climMaxC, null, unit);
    const climMin = tempVal(day?.climMinC, null, unit);

    const bounds = computeScaleBounds([p10Min, p90Max, minV, maxV, climMin, climMax, unit === 'imperial' ? 32 : 0], 4);
    const mapX = v => padL + ((v - bounds.min) / (bounds.max - bounds.min || 1)) * (w - padL - padR);

    const zeroVal = unit === 'imperial' ? 32 : 0;
    const zeroX = mapX(zeroVal);
    const showZero = zeroX >= padL - 10 && zeroX <= w - padR + 10;

    const minP10X = mapX(p10Min ?? bounds.min);
    const minP90X = mapX(p90Min ?? bounds.min);
    const minP25X = mapX(p25Min ?? bounds.min);
    const minP75X = mapX(p75Min ?? bounds.min);
    const minMedX = mapX(minV ?? bounds.min);

    const maxP10X = mapX(p10Max ?? bounds.max);
    const maxP90X = mapX(p90Max ?? bounds.max);
    const maxP25X = mapX(p25Max ?? bounds.max);
    const maxP75X = mapX(p75Max ?? bounds.max);
    const maxMedX = mapX(maxV ?? bounds.max);

    const confPct = toNum(day?.confidencePct, 42);
    const title = `${day?.dayShort || ''} ${day?.dateStr || ''} • Субсезонный диапазон P25–P75 (без почасовой детализации)`;

    const html = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" class="diurnal-svg-mobile" style="min-width:680px;height:${h}px" role="img" aria-label="${escapeHtml(title)}">
            <rect x="0" y="0" width="${w}" height="${h}" rx="12" fill="rgba(15,23,42,0.55)"/>
            <text x="20" y="28" fill="#a78bfa" font-size="13" font-family="JetBrains Mono, monospace" font-weight="700">${escapeHtml(title)}</text>
            <text x="${w - 20}" y="28" text-anchor="end" fill="#94a3b8" font-size="12" font-family="JetBrains Mono, monospace">Уверенность: ${Math.round(confPct)}%</text>

            ${showZero ? `
                <line x1="${zeroX.toFixed(1)}" y1="46" x2="${zeroX.toFixed(1)}" y2="188" stroke="#fb7185" stroke-width="1.6" stroke-dasharray="4 4"/>
                <text x="${zeroX.toFixed(1)}" y="204" text-anchor="middle" fill="#fb7185" font-size="11.5" font-family="JetBrains Mono, monospace" font-weight="700">${unit === 'imperial' ? '32°F' : '0°C'}</text>
            ` : ''}

            <!-- Max T° Quantile Band -->
            <text x="20" y="84" fill="#fbbf24" font-size="12" font-family="JetBrains Mono, monospace" font-weight="700">День</text>
            <rect x="${Math.min(maxP10X, maxP90X).toFixed(1)}" y="68" width="${Math.max(6, Math.abs(maxP90X - maxP10X)).toFixed(1)}" height="22" rx="6" fill="rgba(251,191,36,0.16)" stroke="rgba(251,191,36,0.35)"/>
            <rect x="${Math.min(maxP25X, maxP75X).toFixed(1)}" y="71" width="${Math.max(4, Math.abs(maxP75X - maxP25X)).toFixed(1)}" height="16" rx="4" fill="rgba(251,191,36,0.42)"/>
            <circle cx="${maxMedX.toFixed(1)}" cy="79" r="6" fill="#0f172a" stroke="#fbbf24" stroke-width="2.6"/>
            <text x="${maxMedX.toFixed(1)}" y="60" text-anchor="middle" fill="#fde68a" font-size="13" font-family="JetBrains Mono, monospace" font-weight="700">Max ${escapeHtml(fmtTempFull(day?.maxC, day?.maxF, unit))}</text>
            <text x="${(Math.min(maxP25X, maxP75X) + Math.abs(maxP75X - maxP25X) / 2).toFixed(1)}" y="106" text-anchor="middle" fill="#cbd5e1" font-size="11" font-family="JetBrains Mono, monospace">P25–P75: ${escapeHtml(fmtTempCompact(day?.maxP25C, null, unit))} .. ${escapeHtml(fmtTempCompact(day?.maxP75C, null, unit))}</text>

            <!-- Min T° Quantile Band -->
            <text x="20" y="148" fill="#22d3ee" font-size="12" font-family="JetBrains Mono, monospace" font-weight="700">Ночь</text>
            <rect x="${Math.min(minP10X, minP90X).toFixed(1)}" y="132" width="${Math.max(6, Math.abs(minP90X - minP10X)).toFixed(1)}" height="22" rx="6" fill="rgba(34,211,238,0.16)" stroke="rgba(34,211,238,0.35)"/>
            <rect x="${Math.min(minP25X, minP75X).toFixed(1)}" y="135" width="${Math.max(4, Math.abs(minP75X - minP25X)).toFixed(1)}" height="16" rx="4" fill="rgba(34,211,238,0.42)"/>
            <circle cx="${minMedX.toFixed(1)}" cy="143" r="6" fill="#0f172a" stroke="#22d3ee" stroke-width="2.6"/>
            <text x="${minMedX.toFixed(1)}" y="124" text-anchor="middle" fill="#a5f3fc" font-size="13" font-family="JetBrains Mono, monospace" font-weight="700">Min ${escapeHtml(fmtTempFull(day?.minC, day?.minF, unit))}</text>
            <text x="${(Math.min(minP25X, minP75X) + Math.abs(minP75X - minP25X) / 2).toFixed(1)}" y="170" text-anchor="middle" fill="#cbd5e1" font-size="11" font-family="JetBrains Mono, monospace">P25–P75: ${escapeHtml(fmtTempCompact(day?.minP25C, null, unit))} .. ${escapeHtml(fmtTempCompact(day?.minP75C, null, unit))}</text>

            ${climMax !== null && climMin !== null ? `
                <text x="${w - 20}" y="220" text-anchor="end" fill="#94a3b8" font-size="11.5" font-family="JetBrains Mono, monospace">Климат. норма Абана (1991–2020): ${escapeHtml(fmtTempCompact(day?.climMinC, null, unit))} .. ${escapeHtml(fmtTempCompact(day?.climMaxC, null, unit))}</text>
            ` : ''}
        </svg>
    `;
    containerEl.innerHTML = html;
    return html;
}

export function renderDiurnalChart(containerEl, day, uiState = {}, onSelectHour = null) {
    if (!containerEl) return '';
    if (!day) return renderEmptySvg(containerEl, 'Выберите сутки для почасового профиля');

    const hours = Array.isArray(day.hours) ? day.hours : [];
    if (day.zone === 'subseasonal' && hours.length < 2) {
        return renderSubseasonalDailyRangeCard(containerEl, day, uiState);
    }
    if (!hours.length) {
        return renderSubseasonalDailyRangeCard(containerEl, day, uiState);
    }

    const unit = uiState?.unit || 'metric';
    const isImp = unit === 'imperial';
    const winKey = uiState?.timeWindow || 'full';
    const winCfg = TIME_WINDOWS?.[winKey] || TIME_WINDOWS?.full;

    const count = hours.length;
    const w = Math.max(760, count * 46 + 96);
    const h = 278;
    const padL = 52;
    const padR = 32;
    const padT = 38;
    const precipTrackH = 34;
    const padB = 50;
    const plotBottom = h - padB;
    const tempBottom = plotBottom - precipTrackH - 6;

    const allTemps = [];
    let maxPrecipMm = 0;
    for (const slot of hours) {
        const t = tempVal(slot.tempC, slot.tempF, unit);
        const f = tempVal(slot.feelsC, null, unit);
        const wb = tempVal(slot.wetBulbC, null, unit);
        if (t !== null) allTemps.push(t);
        if (f !== null) allTemps.push(f);
        if (wb !== null) allTemps.push(wb);
        const pm = toNum(slot.precipMm, 0);
        if (pm > maxPrecipMm) maxPrecipMm = pm;
    }

    const bounds = computeScaleBounds(allTemps, isImp ? 4 : 2.2, isImp ? 20 : -6, isImp ? 50 : 10);
    const getY = val => tempBottom - ((val - bounds.min) / (bounds.max - bounds.min || 1)) * (tempBottom - padT);

    const stepW = count > 1 ? (w - padL - padR) / (count - 1) : 48;
    const colW = Math.max(18, stepW);

    const selectedHour = toNum(uiState?.selectedHourSlot);
    let activeIdx = hours.findIndex(s => toNum(s.hour) === selectedHour);
    if (activeIdx === -1) activeIdx = Math.min(Math.floor(count / 2), count - 1);

    // Find extreme indices so their temp labels always show clearly
    let minIdx = 0;
    let maxIdx = 0;
    for (let i = 1; i < count; i++) {
        if ((toNum(hours[i].tempC, -999)) > (toNum(hours[maxIdx].tempC, -999))) maxIdx = i;
        if ((toNum(hours[i].tempC, 999)) < (toNum(hours[minIdx].tempC, 999))) minIdx = i;
    }

    const slots = hours.map((slot, i) => {
        const hr = toNum(slot.hour, i);
        const x = getXCoordinate(i, count, w, padL, padR);
        const t = tempVal(slot.tempC, slot.tempF, unit);
        const feels = tempVal(slot.feelsC, null, unit);
        const wb = tempVal(slot.wetBulbC, null, unit);
        const pMm = Math.max(0, toNum(slot.precipMm, 0));
        const pProb = clamp(toNum(slot.precipProb, 0), 0, 100);
        const phase = resolvePrecipPhase(slot);
        const active = typeof winCfg?.isHourActive === 'function' ? Boolean(winCfg.isHourActive(hr, day)) : true;

        return {
            index: i,
            hour: hr,
            hourStr: slot.hourStr || `${String(hr).padStart(2, '0')}:00`,
            x,
            yTemp: t !== null ? getY(t) : null,
            yFeels: feels !== null ? getY(feels) : null,
            yWetBulb: wb !== null ? getY(wb) : null,
            tempLabel: fmtTempCompact(slot.tempC, slot.tempF, unit),
            precipMm: pMm,
            precipProb: pProb,
            phaseColor: PHASE_COLORS[phase] || PHASE_COLORS.rain,
            active
        };
    });

    // Daylight shading via sunriseHour..sunsetHour
    const sr = toNum(day?.astronomy?.sunriseHour);
    const ss = toNum(day?.astronomy?.sunsetHour);
    let daylightBandSvg = '';
    if (sr !== null && ss !== null && ss > sr && count > 1) {
        const firstH = slots[0].hour;
        const lastH = slots[slots.length - 1].hour;
        const spanH = Math.max(1, lastH - firstH);
        const mapHourToX = hrVal => padL + clamp((hrVal - firstH) / spanH, 0, 1) * (w - padL - padR);
        const xSunStart = mapHourToX(sr);
        const xSunEnd = mapHourToX(ss);
        const bandW = Math.max(0, xSunEnd - xSunStart);
        daylightBandSvg = `
            <rect x="${padL - colW / 2}" y="${padT - 8}" width="${Math.max(0, xSunStart - (padL - colW / 2)).toFixed(1)}" height="${plotBottom - padT + 8}" fill="rgba(15, 23, 42, 0.45)"/>
            <rect x="${xSunStart.toFixed(1)}" y="${padT - 8}" width="${bandW.toFixed(1)}" height="${plotBottom - padT + 8}" fill="rgba(251, 191, 36, 0.05)"/>
            <rect x="${xSunEnd.toFixed(1)}" y="${padT - 8}" width="${Math.max(0, (w - padR + colW / 2) - xSunEnd).toFixed(1)}" height="${plotBottom - padT + 8}" fill="rgba(15, 23, 42, 0.45)"/>
            <line x1="${xSunStart.toFixed(1)}" y1="${padT - 8}" x2="${xSunStart.toFixed(1)}" y2="${plotBottom}" stroke="rgba(251,191,36,0.35)" stroke-dasharray="3 3" stroke-width="1.2"/>
            <line x1="${xSunEnd.toFixed(1)}" y1="${padT - 8}" x2="${xSunEnd.toFixed(1)}" y2="${plotBottom}" stroke="rgba(129,140,248,0.35)" stroke-dasharray="3 3" stroke-width="1.2"/>
            <text x="${(xSunStart + 4).toFixed(1)}" y="${padT + 4}" fill="#fbbf24" font-size="10" font-family="JetBrains Mono, monospace">☀ Восход</text>
            <text x="${(xSunEnd - 4).toFixed(1)}" y="${padT + 4}" text-anchor="end" fill="#a5b4fc" font-size="10" font-family="JetBrains Mono, monospace">☾ Закат</text>
        `;
    }

    const tempPts = slots.filter(s => s.yTemp !== null).map(s => ({ x: s.x, y: s.yTemp }));
    const tempPath = buildSegmentedPath(slots.map(s => (s.yTemp !== null ? { x: s.x, y: s.yTemp } : null)));
    const feelsPath = buildSegmentedPath(slots.map(s => (s.yFeels !== null ? { x: s.x, y: s.yFeels } : null)));
    const wetBulbPath = buildSegmentedPath(slots.map(s => (s.yWetBulb !== null ? { x: s.x, y: s.yWetBulb } : null)));

    const areaPath = tempPts.length >= 2
        ? `${buildSegmentedPath(tempPts)} L ${tempPts[tempPts.length - 1].x.toFixed(1)} ${tempBottom.toFixed(1)} L ${tempPts[0].x.toFixed(1)} ${tempBottom.toFixed(1)} Z`
        : '';

    const zeroThreshold = isImp ? 32 : 0;
    const zeroY = getY(zeroThreshold);
    const showZero = zeroY >= padT - 10 && zeroY <= tempBottom + 10;

    const precipScaleMax = Math.max(2.0, maxPrecipMm * 1.15);
    const barW = Math.min(18, Math.max(8, colW * 0.42));

    const selSlot = slots[activeIdx];

    const html = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" class="diurnal-svg-mobile" style="min-width:${w}px;height:${h}px;touch-action:pan-x pan-y;" role="img" aria-label="Почасовой профиль температуры и осадков">
            <defs>
                <linearGradient id="aban-diurnal-temp-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.34"/>
                    <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.02"/>
                </linearGradient>
            </defs>

            <!-- Inline legend -->
            <g font-size="10.5" font-family="JetBrains Mono, monospace">
                <line x1="${padL}" y1="15" x2="${padL + 16}" y2="15" stroke="#38bdf8" stroke-width="3" stroke-linecap="round"/>
                <text x="${padL + 21}" y="19" fill="#e2e8f0">T°</text>

                ${feelsPath ? `
                    <line x1="${padL + 50}" y1="15" x2="${padL + 66}" y2="15" stroke="#a5b4fc" stroke-width="2" stroke-dasharray="4 3"/>
                    <text x="${padL + 71}" y="19" fill="#c7d2fe">Ощущ.</text>
                ` : ''}

                ${wetBulbPath ? `
                    <line x1="${padL + 122}" y1="15" x2="${padL + 138}" y2="15" stroke="#22d3ee" stroke-width="1.8" stroke-dasharray="2 3"/>
                    <text x="${padL + 143}" y="19" fill="#67e8f9">Tw (мокрый термометр)</text>
                ` : ''}

                <text x="${w - padR}" y="19" text-anchor="end" fill="#94a3b8">Осадки (мм) внизу • Тяните ползунок часов</text>
            </g>

            <!-- Daylight / Night shading -->
            ${daylightBandSvg}

            <!-- Active timeWindow column highlights -->
            ${winKey !== 'full' ? slots.map(s => (s.active ? `
                <rect x="${(s.x - colW / 2).toFixed(1)}" y="${padT - 8}" width="${colW.toFixed(1)}" height="${(plotBottom - padT + 8).toFixed(1)}" fill="rgba(56, 189, 248, 0.11)"/>
            ` : '')).join('') : ''}

            <!-- Precipitation mini-track baseline -->
            <line x1="${padL - 10}" y1="${plotBottom}" x2="${w - padR + 10}" y2="${plotBottom}" stroke="rgba(148,163,184,0.22)" stroke-width="1"/>

            <!-- 0°C freezing line -->
            ${showZero ? `
                <line x1="${padL - 10}" y1="${zeroY.toFixed(1)}" x2="${w - padR + 10}" y2="${zeroY.toFixed(1)}" stroke="#fb7185" stroke-dasharray="5 4" stroke-width="1.7"/>
                <text x="${padL - 14}" y="${(zeroY + 4).toFixed(1)}" text-anchor="end" fill="#fb7185" font-size="11.5" font-family="JetBrains Mono, monospace" font-weight="700">${isImp ? '32°' : '0°'}</text>
            ` : ''}

            <!-- Curves -->
            ${areaPath ? `<path d="${areaPath}" fill="url(#aban-diurnal-temp-grad)"/>` : ''}
            ${wetBulbPath ? `<path d="${wetBulbPath}" fill="none" stroke="#22d3ee" stroke-opacity="0.65" stroke-width="1.6" stroke-dasharray="2 3" stroke-linecap="round"/>` : ''}
            ${feelsPath ? `<path d="${feelsPath}" fill="none" stroke="#a5b4fc" stroke-opacity="0.85" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round"/>` : ''}
            ${tempPath ? `<path d="${tempPath}" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : ''}

            <!-- Hourly precipitation mini-bars & interactive temperature nodes -->
            ${slots.map((s, i) => {
                const isPicked = s.hour === selSlot.hour;
                const showTempLabel = isPicked || i === minIdx || i === maxIdx || count <= 12 || i % 2 === 0;
                const barH = s.precipMm > 0
                    ? Math.max(4, (s.precipMm / precipScaleMax) * precipTrackH)
                    : (s.precipProb >= 15 ? 2.5 : 0);
                const barY = plotBottom - barH;
                const opacityAttr = s.active ? '1' : '0.32';

                return `
                <g class="cursor-pointer" data-hour="${s.hour}" tabindex="0" role="button" aria-label="Час ${escapeHtml(s.hourStr)}, температура ${escapeHtml(s.tempLabel)}" opacity="${opacityAttr}">
                    <rect x="${(s.x - colW / 2).toFixed(1)}" y="${padT - 8}" width="${colW.toFixed(1)}" height="${(plotBottom - padT + 8).toFixed(1)}" fill="transparent"/>

                    ${isPicked ? `<line x1="${s.x.toFixed(1)}" y1="${padT - 6}" x2="${s.x.toFixed(1)}" y2="${plotBottom}" stroke="#fbbf24" stroke-width="1.8" stroke-dasharray="3 3"/>` : ''}

                    ${barH > 0 ? `
                        <rect x="${(s.x - barW / 2).toFixed(1)}" y="${barY.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2.5" fill="${s.phaseColor}" fill-opacity="${s.precipMm > 0 ? '0.82' : '0.4'}"/>
                        ${s.precipMm >= 0.1 ? `<text x="${s.x.toFixed(1)}" y="${(barY - 3).toFixed(1)}" text-anchor="middle" fill="${s.phaseColor}" font-size="9.5" font-family="JetBrains Mono, monospace" font-weight="700">${s.precipMm.toFixed(1)}</text>` : ''}
                    ` : ''}

                    ${s.yTemp !== null ? `
                        <circle cx="${s.x.toFixed(1)}" cy="${s.yTemp.toFixed(1)}" r="${isPicked ? 7 : 4.2}" fill="${isPicked ? '#fbbf24' : '#0f172a'}" stroke="${isPicked ? '#0f172a' : '#38bdf8'}" stroke-width="2.4"/>
                        ${showTempLabel ? `<text x="${s.x.toFixed(1)}" y="${(s.yTemp - (isPicked ? 12 : 9)).toFixed(1)}" text-anchor="middle" fill="${isPicked ? '#fde047' : '#f1f5f9'}" font-size="${isPicked ? '13' : '11.5'}" font-family="JetBrains Mono, monospace" font-weight="700">${escapeHtml(s.tempLabel)}</text>` : ''}
                    ` : ''}
                </g>`;
            }).join('')}

            <!-- Dedicated touch-friendly hour scrubber rail -->
            <g data-scrub-track="true" style="touch-action:none;cursor:ew-resize;">
                <rect x="${(padL - colW / 2).toFixed(1)}" y="${(plotBottom + 2).toFixed(1)}" width="${(w - padL - padR + colW).toFixed(1)}" height="${(padB - 4).toFixed(1)}" rx="8" fill="rgba(15, 23, 42, 0.85)" stroke="rgba(56, 189, 248, 0.22)"/>
                <line x1="${padL}" y1="${(plotBottom + 13).toFixed(1)}" x2="${w - padR}" y2="${(plotBottom + 13).toFixed(1)}" stroke="rgba(148,163,184,0.28)" stroke-width="3" stroke-linecap="round"/>
                <circle cx="${selSlot.x.toFixed(1)}" cy="${(plotBottom + 13).toFixed(1)}" r="7" fill="#fbbf24" stroke="#060911" stroke-width="2"/>
                ${slots.map((s, i) => {
                    const isPicked = s.hour === selSlot.hour;
                    const showLabel = isPicked || count <= 12 || i % 2 === 0;
                    const shortHour = s.hourStr.slice(0, 2);
                    return `
                        <g data-hour="${s.hour}">
                            <line x1="${s.x.toFixed(1)}" y1="${(plotBottom + 10).toFixed(1)}" x2="${s.x.toFixed(1)}" y2="${(plotBottom + 16).toFixed(1)}" stroke="${isPicked ? '#fbbf24' : '#64748b'}" stroke-width="1.2"/>
                            ${showLabel ? `<text x="${s.x.toFixed(1)}" y="${(h - 10).toFixed(1)}" text-anchor="middle" fill="${isPicked ? '#fbbf24' : '#cbd5e1'}" font-size="11.5" font-family="JetBrains Mono, monospace" font-weight="${isPicked ? '800' : '600'}">${escapeHtml(isPicked ? s.hourStr : shortHour)}</text>` : ''}
                        </g>
                    `;
                }).join('')}
            </g>
        </svg>
    `;

    containerEl.innerHTML = html;
    bindDiurnalScrubbing(containerEl, { onSelectHour, slots, viewBoxW: w });
    return html;
}

// ============================================================================
// 3. TEMPERATURE & 35-DAY ENSEMBLE FAN CHART (P10-P90, P25-P75, CLIM, MODELS)
// ============================================================================
function groupDaysIntoPentads(days) {
    const pentads = [];
    let i = 0;
    while (i < days.length) {
        const zone = resolveDayZone(days[i]);
        const chunk = [days[i]];
        i++;
        while (chunk.length < 5 && i < days.length && resolveDayZone(days[i]) === zone) {
            chunk.push(days[i]);
            i++;
        }

        const avgField = (fn) => {
            const vals = chunk.map(fn).filter(v => Number.isFinite(v));
            return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };

        const first = chunk[0];
        const last = chunk[chunk.length - 1];
        const firstDayNum = String(first.dateStr || first.isoDate || '').split(' ')[0];
        const lastLabel = String(last.dateStr || last.isoDate || '');
        const label = chunk.length === 1 ? lastLabel : `${firstDayNum}–${lastLabel}`;

        const modelIds = new Set();
        for (const d of chunk) {
            if (d?.modelBreakdown && typeof d.modelBreakdown === 'object') {
                Object.keys(d.modelBreakdown).forEach(k => modelIds.add(k));
            }
        }
        const modelBreakdown = {};
        for (const mId of modelIds) {
            const mMax = avgField(d => toNum(d?.modelBreakdown?.[mId]?.maxC));
            const mMin = avgField(d => toNum(d?.modelBreakdown?.[mId]?.minC));
            if (mMax !== null || mMin !== null) {
                modelBreakdown[mId] = { maxC: mMax, minC: mMin };
            }
        }

        const rep = chunk[Math.floor(chunk.length / 2)];
        pentads.push({
            id: rep.id,
            memberIds: chunk.map(d => d.id),
            zone,
            dayShort: `${chunk.length}д`,
            dateStr: label,
            maxC: avgField(d => toNum(d.maxC)),
            maxF: avgField(d => toNum(d.maxF)),
            minC: avgField(d => toNum(d.minC)),
            minF: avgField(d => toNum(d.minF)),
            maxP10C: avgField(d => toNum(d.maxP10C)),
            maxP25C: avgField(d => toNum(d.maxP25C)),
            maxP75C: avgField(d => toNum(d.maxP75C)),
            maxP90C: avgField(d => toNum(d.maxP90C)),
            minP10C: avgField(d => toNum(d.minP10C)),
            minP25C: avgField(d => toNum(d.minP25C)),
            minP75C: avgField(d => toNum(d.minP75C)),
            minP90C: avgField(d => toNum(d.minP90C)),
            climMaxC: avgField(d => toNum(d.climMaxC)),
            climMinC: avgField(d => toNum(d.climMinC)),
            modelBreakdown
        });
    }
    return pentads;
}

function buildZoneSpans(items, xCoords, w, padL, padR) {
    if (!items.length) return [];
    const spans = [];
    let startIdx = 0;
    for (let i = 1; i <= items.length; i++) {
        const prevZone = resolveDayZone(items[startIdx]);
        const curZone = i < items.length ? resolveDayZone(items[i]) : null;
        if (curZone !== prevZone) {
            const leftEdge = startIdx === 0 ? Math.max(0, padL - 26) : (xCoords[startIdx - 1] + xCoords[startIdx]) / 2;
            const rightEdge = i === items.length ? Math.min(w, w - padR + 26) : (xCoords[i - 1] + xCoords[i]) / 2;
            spans.push({
                zone: prevZone,
                meta: ZONE_META[prevZone] || ZONE_META.deterministic,
                leftEdge,
                rightEdge,
                hasSeparatorLeft: startIdx > 0
            });
            startIdx = i;
        }
    }
    return spans;
}

export function renderTempEnsembleChart(containerEl, days, uiState = {}, onSelectDay = null) {
    if (!containerEl) return '';
    if (!Array.isArray(days) || !days.length) return renderEmptySvg(containerEl, 'Нет температурных данных');

    const unit = uiState?.unit || 'metric';
    const isImp = unit === 'imperial';
    const isPentad = Boolean(uiState?.groupByPentad && days.length > 16);
    const items = isPentad ? groupDaysIntoPentads(days) : days;
    const count = items.length;

    const showClim = Boolean(uiState?.showClimatology);
    const showModels = Boolean(uiState?.showModelLines);

    // Collect model IDs when model lines requested
    const modelIds = [];
    if (showModels) {
        const seen = new Set();
        const orderedKeys = Object.keys(MODEL_META || {});
        for (const k of orderedKeys) {
            if (items.some(d => d?.modelBreakdown?.[k])) {
                modelIds.push(k);
                seen.add(k);
            }
        }
        for (const d of items) {
            if (!d?.modelBreakdown) continue;
            for (const k of Object.keys(d.modelBreakdown)) {
                if (!seen.has(k)) {
                    modelIds.push(k);
                    seen.add(k);
                }
            }
        }
    }

    const step = count <= 12 ? 82 : (count <= 24 ? 64 : 48);
    const w = Math.max(740, count * step + 90);
    const padT = (showClim || (showModels && modelIds.length)) ? 58 : 44;
    const h = 295 + (padT - 44);
    const padL = 56;
    const padR = 44;
    const padB = 50;

    // Collect all Y values so uncertainty fan & model lines never clip
    const allVals = [isImp ? 20 : -6, isImp ? 45 : 7];
    for (const d of items) {
        const zone = resolveDayZone(d);
        const isFanZone = zone === 'extended_ensemble' || zone === 'subseasonal';
        const mx = tempVal(d.maxC, d.maxF, unit);
        const mn = tempVal(d.minC, d.minF, unit);
        if (mx !== null) allVals.push(mx);
        if (mn !== null) allVals.push(mn);

        if (isFanZone) {
            [d.maxP10C, d.maxP90C, d.minP10C, d.minP90C, d.maxP25C, d.maxP75C, d.minP25C, d.minP75C].forEach(q => {
                const v = tempVal(q, null, unit);
                if (v !== null) allVals.push(v);
            });
        }
        if (showClim) {
            const cMax = tempVal(d.climMaxC, null, unit);
            const cMin = tempVal(d.climMinC, null, unit);
            if (cMax !== null) allVals.push(cMax);
            if (cMin !== null) allVals.push(cMin);
        }
        if (showModels && d.modelBreakdown) {
            for (const mId of modelIds) {
                const mMax = tempVal(d.modelBreakdown[mId]?.maxC, null, unit);
                if (mMax !== null) allVals.push(mMax);
            }
        }
    }

    const bounds = computeScaleBounds(allVals, isImp ? 4 : 2.5);
    const getY = val => h - padB - ((val - bounds.min) / (bounds.max - bounds.min || 1)) * (h - padT - padB);

    const xCoords = items.map((_, i) => getXCoordinate(i, count, w, padL, padR));
    const zoneSpans = buildZoneSpans(items, xCoords, w, padL, padR);

    // Find absolute max and min items for guaranteed label visibility
    let absMaxIdx = 0;
    let absMinIdx = 0;
    for (let i = 1; i < count; i++) {
        if ((toNum(items[i].maxC, -999)) > (toNum(items[absMaxIdx].maxC, -999))) absMaxIdx = i;
        if ((toNum(items[i].minC, 999)) < (toNum(items[absMinIdx].minC, 999))) absMinIdx = i;
    }

    const maxPts = items.map((d, i) => {
        const v = tempVal(d.maxC, d.maxF, unit);
        return v !== null ? { x: xCoords[i], y: getY(v) } : null;
    });
    const minPts = items.map((d, i) => {
        const v = tempVal(d.minC, d.minF, unit);
        return v !== null ? { x: xCoords[i], y: getY(v) } : null;
    });

    // Build uncertainty fan upper/lower arrays for extended_ensemble & subseasonal
    // Anchor 1 deterministic predecessor point smoothly into the fan if available
    const maxP90Pts = [];
    const maxP10Pts = [];
    const maxP75Pts = [];
    const maxP25Pts = [];
    const minP90Pts = [];
    const minP10Pts = [];
    const minP75Pts = [];
    const minP25Pts = [];

    for (let i = 0; i < count; i++) {
        const d = items[i];
        const zone = resolveDayZone(d);
        const nextZone = i + 1 < count ? resolveDayZone(items[i + 1]) : null;
        const inFan = zone === 'extended_ensemble' || zone === 'subseasonal';
        const isFanAnchor = !inFan && (nextZone === 'extended_ensemble' || nextZone === 'subseasonal');

        if (inFan) {
            const mx = tempVal(d.maxC, d.maxF, unit);
            const mn = tempVal(d.minC, d.minF, unit);
            const x = xCoords[i];
            const mx90 = tempVal(d.maxP90C, null, unit) ?? mx;
            const mx10 = tempVal(d.maxP10C, null, unit) ?? mx;
            const mx75 = tempVal(d.maxP75C, null, unit) ?? mx;
            const mx25 = tempVal(d.maxP25C, null, unit) ?? mx;
            const mn90 = tempVal(d.minP90C, null, unit) ?? mn;
            const mn10 = tempVal(d.minP10C, null, unit) ?? mn;
            const mn75 = tempVal(d.minP75C, null, unit) ?? mn;
            const mn25 = tempVal(d.minP25C, null, unit) ?? mn;

            maxP90Pts.push(mx90 !== null ? { x, y: getY(mx90) } : null);
            maxP10Pts.push(mx10 !== null ? { x, y: getY(mx10) } : null);
            maxP75Pts.push(mx75 !== null ? { x, y: getY(mx75) } : null);
            maxP25Pts.push(mx25 !== null ? { x, y: getY(mx25) } : null);
            minP90Pts.push(mn90 !== null ? { x, y: getY(mn90) } : null);
            minP10Pts.push(mn10 !== null ? { x, y: getY(mn10) } : null);
            minP75Pts.push(mn75 !== null ? { x, y: getY(mn75) } : null);
            minP25Pts.push(mn25 !== null ? { x, y: getY(mn25) } : null);
        } else if (isFanAnchor) {
            maxP90Pts.push(maxPts[i]);
            maxP10Pts.push(maxPts[i]);
            maxP75Pts.push(maxPts[i]);
            maxP25Pts.push(maxPts[i]);
            minP90Pts.push(minPts[i]);
            minP10Pts.push(minPts[i]);
            minP75Pts.push(minPts[i]);
            minP25Pts.push(minPts[i]);
        } else {
            maxP90Pts.push(null);
            maxP10Pts.push(null);
            maxP75Pts.push(null);
            maxP25Pts.push(null);
            minP90Pts.push(null);
            minP10Pts.push(null);
            minP75Pts.push(null);
            minP25Pts.push(null);
        }
    }

    const maxOuterFanPath = buildAreaPolygonPath(maxP90Pts, maxP10Pts);
    const maxInnerFanPath = buildAreaPolygonPath(maxP75Pts, maxP25Pts);
    const minOuterFanPath = buildAreaPolygonPath(minP90Pts, minP10Pts);
    const minInnerFanPath = buildAreaPolygonPath(minP75Pts, minP25Pts);

    const maxPath = buildSegmentedPath(maxPts);
    const minPath = buildSegmentedPath(minPts);
    const detBandPath = buildAreaPolygonPath(maxPts, minPts);

    const climMaxPath = showClim
        ? buildSegmentedPath(items.map((d, i) => {
            const v = tempVal(d.climMaxC, null, unit);
            return v !== null ? { x: xCoords[i], y: getY(v) } : null;
        }))
        : '';
    const climMinPath = showClim
        ? buildSegmentedPath(items.map((d, i) => {
            const v = tempVal(d.climMinC, null, unit);
            return v !== null ? { x: xCoords[i], y: getY(v) } : null;
        }))
        : '';

    const modelLines = showModels
        ? modelIds.map((mId, idx) => {
            const meta = MODEL_META?.[mId];
            const color = meta?.color || FALLBACK_MODEL_COLORS[idx % FALLBACK_MODEL_COLORS.length];
            const label = meta?.shortName || meta?.name || mId;
            const path = buildSegmentedPath(items.map((d, i) => {
                const v = tempVal(d?.modelBreakdown?.[mId]?.maxC, null, unit);
                return v !== null ? { x: xCoords[i], y: getY(v) } : null;
            }));
            return { mId, color, label, path };
        }).filter(m => m.path)
        : [];

    // Build top legend items
    const legendChips = [];
    if (showClim) {
        legendChips.push({ color: '#fb923c', label: 'Норма Max (1991–2020)', dashed: true });
        legendChips.push({ color: '#60a5fa', label: 'Норма Min', dashed: true });
    }
    for (const m of modelLines) {
        legendChips.push({ color: m.color, label: m.label, dashed: false });
    }

    let legendX = padL;
    const legendSvg = legendChips.length ? `<g font-size="10.5" font-family="JetBrains Mono, monospace">
        ${legendChips.map(ch => {
            const x0 = legendX;
            const approxW = ch.label.length * 6.5 + 34;
            legendX += approxW;
            return `
                <line x1="${x0}" y1="14" x2="${x0 + 16}" y2="14" stroke="${escapeHtml(ch.color)}" stroke-width="2" ${ch.dashed ? 'stroke-dasharray="4 3"' : ''} stroke-linecap="round"/>
                <text x="${x0 + 21}" y="18" fill="#cbd5e1">${escapeHtml(ch.label)}</text>
            `;
        }).join('')}
    </g>` : '';

    const zeroVal = isImp ? 32 : 0;
    const zeroY = getY(zeroVal);
    const showZero = zeroY >= padT - 10 && zeroY <= h - padB + 10;

    const html = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" class="chart-svg-mobile" style="min-width:${w}px;height:${h}px" role="img" aria-label="Температурный профиль и ансамблевый веер P10-P90">
            <defs>
                <linearGradient id="aban-ens-band-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.22"/>
                    <stop offset="55%" stop-color="#38bdf8" stop-opacity="0.14"/>
                    <stop offset="100%" stop-color="#22d3ee" stop-opacity="0.22"/>
                </linearGradient>
            </defs>

            ${legendSvg}

            <!-- Zone backgrounds, headers & vertical dashed separators -->
            ${zoneSpans.map(sp => `
                <rect x="${sp.leftEdge.toFixed(1)}" y="${padT - 18}" width="${Math.max(0, sp.rightEdge - sp.leftEdge).toFixed(1)}" height="${(h - padT - padB + 26).toFixed(1)}" fill="${sp.meta.bg}"/>
                ${sp.hasSeparatorLeft ? `<line x1="${sp.leftEdge.toFixed(1)}" y1="${padT - 20}" x2="${sp.leftEdge.toFixed(1)}" y2="${(h - padB + 8).toFixed(1)}" stroke="${sp.meta.color}" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="5 4"/>` : ''}
                <text x="${(sp.leftEdge + 8).toFixed(1)}" y="${(padT - 6).toFixed(1)}" fill="${sp.meta.color}" font-size="10.5" font-family="JetBrains Mono, monospace" font-weight="700">${escapeHtml(sp.meta.label)}${isPentad ? ' (5д)' : ''}</text>
            `).join('')}

            <!-- 0°C Threshold -->
            ${showZero ? `
                <line x1="${padL - 10}" y1="${zeroY.toFixed(1)}" x2="${w - padR + 10}" y2="${zeroY.toFixed(1)}" stroke="#fb7185" stroke-width="1.8" stroke-dasharray="5 4"/>
                <text x="${padL - 14}" y="${(zeroY + 4).toFixed(1)}" text-anchor="end" fill="#fb7185" font-size="12" font-family="JetBrains Mono, monospace" font-weight="700">${isImp ? '32°F' : '0°C'}</text>
            ` : ''}

            <!-- Main Day-Night band & Ensemble P10-P90 / P25-P75 fans -->
            ${detBandPath ? `<path d="${detBandPath}" fill="url(#aban-ens-band-grad)"/>` : ''}
            ${maxOuterFanPath ? `<path d="${maxOuterFanPath}" fill="#fbbf24" fill-opacity="0.14"/>` : ''}
            ${maxInnerFanPath ? `<path d="${maxInnerFanPath}" fill="#fbbf24" fill-opacity="0.24"/>` : ''}
            ${minOuterFanPath ? `<path d="${minOuterFanPath}" fill="#22d3ee" fill-opacity="0.14"/>` : ''}
            ${minInnerFanPath ? `<path d="${minInnerFanPath}" fill="#22d3ee" fill-opacity="0.24"/>` : ''}

            <!-- Climatology 30-year Aban normal -->
            ${climMaxPath ? `<path d="${climMaxPath}" fill="none" stroke="#fb923c" stroke-opacity="0.85" stroke-width="1.8" stroke-dasharray="6 4"/>` : ''}
            ${climMinPath ? `<path d="${climMinPath}" fill="none" stroke="#60a5fa" stroke-opacity="0.85" stroke-width="1.8" stroke-dasharray="6 4"/>` : ''}

            <!-- Model Spaghetti Lines -->
            ${modelLines.map(m => `<path d="${m.path}" fill="none" stroke="${escapeHtml(m.color)}" stroke-opacity="0.78" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}
            ${count === 1 && showModels ? modelIds.map((mId, idx) => {
                const v = tempVal(items[0]?.modelBreakdown?.[mId]?.maxC, null, unit);
                if (v === null) return '';
                const meta = MODEL_META?.[mId];
                const color = meta?.color || FALLBACK_MODEL_COLORS[idx % FALLBACK_MODEL_COLORS.length];
                return `<circle cx="${(xCoords[0] + (idx - (modelIds.length - 1) / 2) * 7).toFixed(1)}" cy="${getY(v).toFixed(1)}" r="3.5" fill="${escapeHtml(color)}" stroke="#060911" stroke-width="1"/>`;
            }).join('') : ''}

            <!-- Median / Deterministic Max & Min Curves -->
            ${maxPath ? `<path d="${maxPath}" fill="none" stroke="#fbbf24" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
            ${minPath ? `<path d="${minPath}" fill="none" stroke="#22d3ee" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>` : ''}

            <!-- Interactive Nodes -->
            ${items.map((d, i) => {
                const x = xCoords[i];
                const pMax = maxPts[i];
                const pMin = minPts[i];
                const isSel = d.id === uiState?.selectedDayId || (Array.isArray(d.memberIds) && d.memberIds.includes(uiState?.selectedDayId));
                const showValLabels = isSel || i === absMaxIdx || i === absMinIdx || count <= 14 || i % 2 === 0;
                const showDateLabel = isSel || count <= 18 || i % 2 === 0 || i === count - 1;
                const zone = resolveDayZone(d);
                const inFan = zone === 'extended_ensemble' || zone === 'subseasonal';

                // Single-day quantile whisker fallback when fan polygons cannot form
                const q90Max = inFan && maxP90Pts[i] ? maxP90Pts[i].y : null;
                const q10Max = inFan && maxP10Pts[i] ? maxP10Pts[i].y : null;
                const q75Max = inFan && maxP75Pts[i] ? maxP75Pts[i].y : null;
                const q25Max = inFan && maxP25Pts[i] ? maxP25Pts[i].y : null;
                const q90Min = inFan && minP90Pts[i] ? minP90Pts[i].y : null;
                const q10Min = inFan && minP10Pts[i] ? minP10Pts[i].y : null;

                const maxLabel = fmtTempCompact(d.maxC, d.maxF, unit);
                const minLabel = fmtTempCompact(d.minC, d.minF, unit);
                const hitW = Math.max(24, step * 0.88);
                const dateShortText = count > 20 ? String(d.dateStr || d.isoDate || '') : `${d.dayShort || ''}, ${d.dateStr || ''}`.replace(/^,\s*/, '');

                return `
                <g class="cursor-pointer" data-day-id="${escapeHtml(d.id)}" tabindex="0" role="button" aria-label="${escapeHtml(dateShortText)} Max ${escapeHtml(maxLabel)} Min ${escapeHtml(minLabel)}">
                    <rect x="${(x - hitW / 2).toFixed(1)}" y="${padT - 12}" width="${hitW.toFixed(1)}" height="${(h - padT - padB + 20).toFixed(1)}" fill="transparent"/>
                    ${isSel ? `<rect x="${(x - Math.min(34, hitW / 2)).toFixed(1)}" y="${padT - 14}" width="${Math.min(68, hitW).toFixed(1)}" height="${(h - padT - padB + 22).toFixed(1)}" rx="10" fill="rgba(56,189,248,0.14)" stroke="rgba(56,189,248,0.45)"/>` : ''}

                    ${count === 1 && q90Max !== null && q10Max !== null ? `
                        <rect x="${(x - 10).toFixed(1)}" y="${Math.min(q90Max, q10Max).toFixed(1)}" width="20" height="${Math.max(4, Math.abs(q10Max - q90Max)).toFixed(1)}" rx="4" fill="#fbbf24" fill-opacity="0.20"/>
                    ` : ''}
                    ${count === 1 && q75Max !== null && q25Max !== null ? `
                        <rect x="${(x - 6).toFixed(1)}" y="${Math.min(q75Max, q25Max).toFixed(1)}" width="12" height="${Math.max(3, Math.abs(q25Max - q75Max)).toFixed(1)}" rx="3" fill="#fbbf24" fill-opacity="0.38"/>
                    ` : ''}
                    ${count === 1 && q90Min !== null && q10Min !== null ? `
                        <rect x="${(x - 10).toFixed(1)}" y="${Math.min(q90Min, q10Min).toFixed(1)}" width="20" height="${Math.max(4, Math.abs(q10Min - q90Min)).toFixed(1)}" rx="4" fill="#22d3ee" fill-opacity="0.20"/>
                    ` : ''}

                    ${pMax && pMin ? `<line x1="${x.toFixed(1)}" y1="${pMax.y.toFixed(1)}" x2="${x.toFixed(1)}" y2="${pMin.y.toFixed(1)}" stroke="rgba(148,163,184,0.32)" stroke-width="1.8" stroke-dasharray="2 2"/>` : ''}

                    ${pMax ? `
                        <circle cx="${x.toFixed(1)}" cy="${pMax.y.toFixed(1)}" r="${isSel ? 6.8 : (count > 20 ? 4 : 5.2)}" fill="#0f172a" stroke="#fbbf24" stroke-width="2.5"/>
                        ${showValLabels ? `<text x="${x.toFixed(1)}" y="${(pMax.y - 11).toFixed(1)}" text-anchor="middle" fill="#fde68a" font-size="${count > 20 ? '11.5' : '13'}" font-family="JetBrains Mono, monospace" font-weight="700">${escapeHtml(maxLabel)}</text>` : ''}
                    ` : ''}

                    ${pMin ? `
                        <circle cx="${x.toFixed(1)}" cy="${pMin.y.toFixed(1)}" r="${isSel ? 6.8 : (count > 20 ? 4 : 5.2)}" fill="#0f172a" stroke="#22d3ee" stroke-width="2.5"/>
                        ${showValLabels ? `<text x="${x.toFixed(1)}" y="${(pMin.y + 19).toFixed(1)}" text-anchor="middle" fill="#a5f3fc" font-size="${count > 20 ? '11.5' : '13'}" font-family="JetBrains Mono, monospace" font-weight="700">${escapeHtml(minLabel)}</text>` : ''}
                    ` : ''}

                    ${showDateLabel ? `<text x="${x.toFixed(1)}" y="${(h - 14).toFixed(1)}" text-anchor="middle" fill="${isSel ? '#38bdf8' : '#e2e8f0'}" font-size="${count > 20 ? '11' : '12.5'}" font-family="Inter, system-ui, sans-serif" font-weight="700">${escapeHtml(dateShortText)}</text>` : ''}
                </g>`;
            }).join('')}
        </svg>
    `;

    containerEl.innerHTML = html;
    bindDayClickDelegation(containerEl, onSelectDay);
    return html;
}

// ============================================================================
// 4. PRECIPITATION, P75 WHISKERS, SNOW DEPTH TRACK & HUMIDITY CHART
// ============================================================================
export function renderPrecipSnowChart(containerEl, days, uiState = {}, onSelectDay = null) {
    if (!containerEl) return '';
    if (!Array.isArray(days) || !days.length) return renderEmptySvg(containerEl, 'Нет данных по осадкам и снегу');

    const count = days.length;
    const step = count <= 12 ? 82 : (count <= 24 ? 64 : 48);
    const w = Math.max(740, count * step + 96);
    const h = 305;
    const padL = 56;
    const padR = 52;
    const padT = 40;
    const mainBottom = 196;
    const snowTop = 214;
    const snowBottom = 264;
    const padB = 41;

    const precipVals = [];
    const snowVals = [];
    for (const d of days) {
        const mm = toNum(d.precipMm, 0);
        const p75 = toNum(d.precipP75Mm);
        const sn = toNum(d.snowDepthCm, 0);
        precipVals.push(mm);
        if (p75 !== null) precipVals.push(p75);
        snowVals.push(sn);
    }

    const maxPrecip = Math.max(4, ...precipVals) * 1.15;
    const maxSnow = Math.max(10, ...snowVals) * 1.18;

    const getPrecipY = mm => mainBottom - (clamp(mm, 0, maxPrecip) / maxPrecip) * (mainBottom - padT);
    const getHumY = pct => mainBottom - (clamp(pct, 0, 100) / 100) * (mainBottom - padT);
    const getSnowY = cm => snowBottom - (clamp(cm, 0, maxSnow) / maxSnow) * (snowBottom - snowTop);

    const xCoords = days.map((_, i) => getXCoordinate(i, count, w, padL, padR));
    const zoneSpans = buildZoneSpans(days, xCoords, w, padL, padR);

    const humPts = days.map((d, i) => {
        const hum = toNum(d.humidity);
        return hum !== null ? { x: xCoords[i], y: getHumY(hum), val: Math.round(hum) } : null;
    });
    const humPath = buildSegmentedPath(humPts);

    const snowPts = days.map((d, i) => {
        const cm = toNum(d.snowDepthCm);
        return cm !== null ? { x: xCoords[i], y: getSnowY(cm), val: cm } : null;
    });
    const snowLinePath = buildSegmentedPath(snowPts);
    const validSnowPts = snowPts.filter(Boolean);
    const snowAreaPath = validSnowPts.length >= 2
        ? `${buildSegmentedPath(validSnowPts)} L ${validSnowPts[validSnowPts.length - 1].x.toFixed(1)} ${snowBottom.toFixed(1)} L ${validSnowPts[0].x.toFixed(1)} ${snowBottom.toFixed(1)} Z`
        : '';

    const barW = count <= 14 ? 22 : (count <= 24 ? 16 : 12);
    const hitW = Math.max(24, step * 0.88);

    const precipTicks = [0, 0.5, 1].map(f => ({
        val: (maxPrecip * f).toFixed(1),
        y: getPrecipY(maxPrecip * f)
    }));

    const html = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" class="chart-svg-mobile" style="min-width:${w}px;height:${h}px" role="img" aria-label="Осадки по фазам, квантиль P75, влажность и снежный покров">
            <defs>
                <linearGradient id="aban-precip-snow-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.34"/>
                    <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.04"/>
                </linearGradient>
            </defs>

            <!-- Inline Phase & Track Legend -->
            <g font-size="10.5" font-family="JetBrains Mono, monospace">
                <rect x="${padL}" y="10" width="9" height="9" rx="2" fill="#22d3ee"/><text x="${padL + 14}" y="18" fill="#cbd5e1">Снег</text>
                <rect x="${padL + 56}" y="10" width="9" height="9" rx="2" fill="#818cf8"/><text x="${padL + 70}" y="18" fill="#cbd5e1">Мокрый снег</text>
                <rect x="${padL + 162}" y="10" width="9" height="9" rx="2" fill="#fb7185"/><text x="${padL + 176}" y="18" fill="#cbd5e1">Гололёд</text>
                <rect x="${padL + 242}" y="10" width="9" height="9" rx="2" fill="#34d399"/><text x="${padL + 256}" y="18" fill="#cbd5e1">Дождь</text>
                <line x1="${padL + 306}" y1="14.5" x2="${padL + 322}" y2="14.5" stroke="#a78bfa" stroke-width="2.2"/><text x="${padL + 327}" y="18" fill="#cbd5e1">Влажн.%</text>
                <line x1="${padL + 392}" y1="14.5" x2="${padL + 408}" y2="14.5" stroke="#38bdf8" stroke-width="2.4"/><text x="${padL + 413}" y="18" fill="#cbd5e1">Покров см (P75 усы)</text>
            </g>

            <!-- Zone separators -->
            ${zoneSpans.map(sp => sp.hasSeparatorLeft ? `
                <line x1="${sp.leftEdge.toFixed(1)}" y1="${padT - 8}" x2="${sp.leftEdge.toFixed(1)}" y2="${snowBottom + 6}" stroke="${sp.meta.color}" stroke-opacity="0.45" stroke-width="1.4" stroke-dasharray="4 4"/>
            ` : '').join('')}

            <!-- Horizontal gridlines & Left/Right axes -->
            ${precipTicks.map(t => `
                <line x1="${padL - 8}" y1="${t.y.toFixed(1)}" x2="${w - padR + 8}" y2="${t.y.toFixed(1)}" stroke="${CHART_PALETTE.gridLine}" stroke-width="1"/>
                <text x="${padL - 12}" y="${(t.y + 4).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="11" font-family="JetBrains Mono, monospace">${t.val}м</text>
            `).join('')}

            ${[50, 100].map(pct => `
                <text x="${w - padR + 12}" y="${(getHumY(pct) + 4).toFixed(1)}" text-anchor="start" fill="#a78bfa" font-size="10.5" font-family="JetBrains Mono, monospace">${pct}%</text>
            `).join('')}

            <!-- Secondary Track: Snow Depth -->
            <rect x="${padL - 8}" y="${snowTop - 4}" width="${(w - padL - padR + 16).toFixed(1)}" height="${(snowBottom - snowTop + 8).toFixed(1)}" rx="6" fill="rgba(15, 23, 42, 0.55)" stroke="rgba(56, 189, 248, 0.16)"/>
            <text x="${padL - 12}" y="${(snowTop + 12).toFixed(1)}" text-anchor="end" fill="#38bdf8" font-size="10.5" font-family="JetBrains Mono, monospace" font-weight="700">Снег</text>
            <text x="${padL - 12}" y="${(snowBottom - 2).toFixed(1)}" text-anchor="end" fill="#64748b" font-size="10" font-family="JetBrains Mono, monospace">0 см</text>

            ${snowAreaPath ? `<path d="${snowAreaPath}" fill="url(#aban-precip-snow-grad)"/>` : ''}
            ${snowLinePath ? `<path d="${snowLinePath}" fill="none" stroke="#38bdf8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` : ''}

            <!-- Humidity Curve -->
            ${humPath ? `<path d="${humPath}" fill="none" stroke="#a78bfa" stroke-opacity="0.88" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` : ''}

            <!-- Day Bars, P75 Whiskers & Nodes -->
            ${days.map((d, i) => {
                const x = xCoords[i];
                const mm = Math.max(0, toNum(d.precipMm, 0));
                const p75 = toNum(d.precipP75Mm);
                const phase = resolvePrecipPhase(d);
                const barColor = PHASE_COLORS[phase] || PHASE_COLORS.rain;
                const yBar = getPrecipY(mm);
                const hBar = mm > 0 ? Math.max(4, mainBottom - yBar) : 2;
                const yBarDraw = mm > 0 ? yBar : mainBottom - 2;

                const hasWhisker = p75 !== null && p75 > mm && p75 > 0.05;
                const yP75 = hasWhisker ? getPrecipY(p75) : null;

                const hp = humPts[i];
                const sp = snowPts[i];
                const isSel = d.id === uiState?.selectedDayId;
                const showLabel = isSel || count <= 14 || i % 2 === 0;
                const dateShortText = count > 20 ? String(d.dateStr || d.isoDate || '') : `${d.dayShort || ''}, ${d.dateStr || ''}`.replace(/^,\s*/, '');

                return `
                <g class="cursor-pointer" data-day-id="${escapeHtml(d.id)}" tabindex="0" role="button" aria-label="${escapeHtml(dateShortText)} осадки ${mm.toFixed(1)} мм">
                    <rect x="${(x - hitW / 2).toFixed(1)}" y="${padT - 8}" width="${hitW.toFixed(1)}" height="${(h - padT - 12).toFixed(1)}" fill="transparent"/>
                    ${isSel ? `<rect x="${(x - Math.min(32, hitW / 2)).toFixed(1)}" y="${padT - 8}" width="${Math.min(64, hitW).toFixed(1)}" height="${(snowBottom - padT + 14).toFixed(1)}" rx="8" fill="rgba(56,189,248,0.10)" stroke="rgba(56,189,248,0.4)"/>` : ''}

                    <!-- Precip Bar -->
                    <rect x="${(x - barW / 2).toFixed(1)}" y="${yBarDraw.toFixed(1)}" width="${barW}" height="${hBar.toFixed(1)}" rx="3.5" fill="${barColor}" fill-opacity="${mm > 0 ? '0.86' : '0.28'}"/>
                    ${mm >= 0.1 && (showLabel || mm >= 2) ? `<text x="${x.toFixed(1)}" y="${((hasWhisker ? yP75 : yBarDraw) - 5).toFixed(1)}" text-anchor="middle" fill="${barColor}" font-size="11" font-family="JetBrains Mono, monospace" font-weight="700">${mm.toFixed(1)}</text>` : ''}

                    <!-- P75 Upper Whisker -->
                    ${hasWhisker ? `
                        <line x1="${x.toFixed(1)}" y1="${yBarDraw.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yP75.toFixed(1)}" stroke="#e2e8f0" stroke-width="1.6"/>
                        <line x1="${(x - 5).toFixed(1)}" y1="${yP75.toFixed(1)}" x2="${(x + 5).toFixed(1)}" y2="${yP75.toFixed(1)}" stroke="#e2e8f0" stroke-width="1.8" stroke-linecap="round"/>
                    ` : ''}

                    <!-- Humidity Node -->
                    ${hp ? `
                        <circle cx="${hp.x.toFixed(1)}" cy="${hp.y.toFixed(1)}" r="${isSel ? 5 : 3.5}" fill="#0f172a" stroke="#a78bfa" stroke-width="2"/>
                        ${isSel ? `<text x="${hp.x.toFixed(1)}" y="${(hp.y - 8).toFixed(1)}" text-anchor="middle" fill="#e9d5ff" font-size="10.5" font-family="JetBrains Mono, monospace" font-weight="700">${hp.val}%</text>` : ''}
                    ` : ''}

                    <!-- Snow Depth Node -->
                    ${sp ? `
                        ${count === 1 && sp.val > 0 ? `<rect x="${(sp.x - 14).toFixed(1)}" y="${sp.y.toFixed(1)}" width="28" height="${Math.max(3, snowBottom - sp.y).toFixed(1)}" rx="3" fill="rgba(56,189,248,0.28)"/>` : ''}
                        <circle cx="${sp.x.toFixed(1)}" cy="${sp.y.toFixed(1)}" r="${isSel ? 4.5 : 3}" fill="#0f172a" stroke="#38bdf8" stroke-width="2"/>
                        ${(sp.val > 0 && (isSel || count <= 14 || i % 3 === 0)) ? `<text x="${sp.x.toFixed(1)}" y="${(sp.y - 6).toFixed(1)}" text-anchor="middle" fill="#bae6fd" font-size="10" font-family="JetBrains Mono, monospace" font-weight="700">${Math.round(sp.val)}см</text>` : ''}
                    ` : ''}

                    ${showLabel ? `<text x="${x.toFixed(1)}" y="${(h - 14).toFixed(1)}" text-anchor="middle" fill="${isSel ? '#38bdf8' : '#e2e8f0'}" font-size="${count > 20 ? '11' : '12.5'}" font-family="Inter, system-ui, sans-serif" font-weight="700">${escapeHtml(dateShortText)}</text>` : ''}
                </g>`;
            }).join('')}
        </svg>
    `;

    containerEl.innerHTML = html;
    bindDayClickDelegation(containerEl, onSelectDay);
    return html;
}

// ============================================================================
// 5. WIND, GUSTS (10 m/s THRESHOLD) & STATION/MSL PRESSURE (+ BARIC JUMPS)
// ============================================================================
export function renderWindPressureChart(containerEl, days, uiState = {}, onSelectDay = null) {
    if (!containerEl) return '';
    if (!Array.isArray(days) || !days.length) return renderEmptySvg(containerEl, 'Нет данных по ветру и давлению');

    const unit = uiState?.unit || 'metric';
    const isImp = unit === 'imperial';
    const pressureMode = uiState?.pressureMode === 'msl' ? 'msl' : 'station';
    const count = days.length;

    const step = count <= 12 ? 82 : (count <= 24 ? 64 : 48);
    const w = Math.max(740, count * step + 96);
    const h = 315;
    const padL = 62;
    const padR = 46;
    const padT = 38;
    const windBottom = 172;
    const pressTop = 194;
    const pressBottom = 268;

    const warnThreshold = isImp ? msToMph(10) : 10.0;
    const windVals = [warnThreshold];
    const pressVals = [];

    for (const d of days) {
        const wv = windVal(d.windMs, d.windMph, unit);
        const gv = windVal(d.gustMs, d.gustMph, unit);
        if (wv !== null) windVals.push(wv);
        if (gv !== null) windVals.push(gv);

        const pv = pressureMode === 'msl'
            ? toNum(d.pressureMslMm ?? d.pressureStationMm ?? d.pressureMm)
            : toNum(d.pressureStationMm ?? d.pressureMm ?? d.pressureMslMm);
        if (pv !== null) pressVals.push(pv);
    }

    const maxWindScale = Math.max(isImp ? 30 : 14, ...windVals) * 1.15;
    const pressBounds = computeScaleBounds(pressVals, 3, pressureMode === 'msl' ? 745 : 725, pressureMode === 'msl' ? 775 : 755);

    const getWindY = val => windBottom - (clamp(val, 0, maxWindScale) / maxWindScale) * (windBottom - padT);
    const getPressY = mm => pressBottom - ((mm - pressBounds.min) / (pressBounds.max - pressBounds.min || 1)) * (pressBottom - pressTop);

    const xCoords = days.map((_, i) => getXCoordinate(i, count, w, padL, padR));
    const zoneSpans = buildZoneSpans(days, xCoords, w, padL, padR);

    const windPts = days.map((d, i) => {
        const v = windVal(d.windMs, d.windMph, unit);
        return v !== null ? { x: xCoords[i], y: getWindY(v), val: v } : null;
    });
    const gustPts = days.map((d, i) => {
        const v = windVal(d.gustMs, d.gustMph, unit);
        return v !== null ? { x: xCoords[i], y: getWindY(v), val: v } : null;
    });
    const pressPts = days.map((d, i) => {
        const pv = pressureMode === 'msl'
            ? toNum(d.pressureMslMm ?? d.pressureStationMm ?? d.pressureMm)
            : toNum(d.pressureStationMm ?? d.pressureMm ?? d.pressureMslMm);
        return pv !== null ? { x: xCoords[i], y: getPressY(pv), val: Math.round(pv) } : null;
    });

    const windPath = buildSegmentedPath(windPts);
    const gustPath = buildSegmentedPath(gustPts);
    const pressPath = buildSegmentedPath(pressPts);

    const warnY = getWindY(warnThreshold);
    const hitW = Math.max(24, step * 0.88);
    const pressLabelMode = pressureMode === 'msl' ? 'Давление (ур. моря)' : 'Давление (ст. 246м)';

    const html = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" class="chart-svg-mobile" style="min-width:${w}px;height:${h}px" role="img" aria-label="Ветер, порывы и барическое давление">
            <!-- Inline Legend -->
            <g font-size="10.5" font-family="JetBrains Mono, monospace">
                <line x1="${padL}" y1="15" x2="${padL + 16}" y2="15" stroke="#38bdf8" stroke-width="3"/><text x="${padL + 21}" y="19" fill="#cbd5e1">Ветер</text>
                <line x1="${padL + 68}" y1="15" x2="${padL + 84}" y2="15" stroke="#fbbf24" stroke-width="2.2" stroke-dasharray="4 3"/><text x="${padL + 89}" y="19" fill="#cbd5e1">Порывы</text>
                <line x1="${padL + 146}" y1="15" x2="${padL + 162}" y2="15" stroke="#34d399" stroke-width="2.4"/><text x="${padL + 167}" y="19" fill="#cbd5e1">${escapeHtml(pressLabelMode)}, мм</text>
                <circle cx="${padL + 345}" cy="15" r="4" fill="none" stroke="#fb7185" stroke-width="2"/><text x="${padL + 354}" y="19" fill="#fda4af">|ΔP24| ≥ 6 мм</text>
            </g>

            <!-- Zone separators -->
            ${zoneSpans.map(sp => sp.hasSeparatorLeft ? `
                <line x1="${sp.leftEdge.toFixed(1)}" y1="${padT - 8}" x2="${sp.leftEdge.toFixed(1)}" y2="${pressBottom + 6}" stroke="${sp.meta.color}" stroke-opacity="0.45" stroke-width="1.4" stroke-dasharray="4 4"/>
            ` : '').join('')}

            <!-- Wind 10 m/s threshold -->
            <line x1="${padL - 8}" y1="${warnY.toFixed(1)}" x2="${w - padR + 8}" y2="${warnY.toFixed(1)}" stroke="#fb7185" stroke-width="1.6" stroke-dasharray="5 4"/>
            <text x="${padL - 12}" y="${(warnY + 4).toFixed(1)}" text-anchor="end" fill="#fb7185" font-size="11" font-family="JetBrains Mono, monospace" font-weight="700">${isImp ? `${warnThreshold}mph` : '10м/с'}</text>

            <!-- Pressure Track Backdrop & Axis -->
            <rect x="${padL - 8}" y="${pressTop - 6}" width="${(w - padL - padR + 16).toFixed(1)}" height="${(pressBottom - pressTop + 12).toFixed(1)}" rx="6" fill="rgba(15, 23, 42, 0.55)" stroke="rgba(52, 211, 153, 0.16)"/>
            <text x="${padL - 12}" y="${(pressTop + 10).toFixed(1)}" text-anchor="end" fill="#34d399" font-size="10.5" font-family="JetBrains Mono, monospace" font-weight="700">${Math.round(pressBounds.max)}</text>
            <text x="${padL - 12}" y="${(pressBottom - 2).toFixed(1)}" text-anchor="end" fill="#64748b" font-size="10.5" font-family="JetBrains Mono, monospace">${Math.round(pressBounds.min)}</text>

            <!-- Curves -->
            ${gustPath ? `<path d="${gustPath}" fill="none" stroke="#fbbf24" stroke-width="2.2" stroke-dasharray="5 3" stroke-linecap="round"/>` : ''}
            ${windPath ? `<path d="${windPath}" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
            ${pressPath ? `<path d="${pressPath}" fill="none" stroke="#34d399" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` : ''}

            <!-- Nodes & Baric Jump Highlights -->
            ${days.map((d, i) => {
                const x = xCoords[i];
                const wp = windPts[i];
                const gp = gustPts[i];
                const pp = pressPts[i];
                const isSel = d.id === uiState?.selectedDayId;
                const showLabel = isSel || count <= 14 || i % 2 === 0;

                // Determine rapid baric jump |deltaP24hMm| >= 6 mmHg
                let deltaP = toNum(d.deltaP24hMm);
                if (deltaP === null && i > 0 && pp && pressPts[i - 1]) {
                    deltaP = pp.val - pressPts[i - 1].val;
                }
                const isBaricJump = deltaP !== null && Math.abs(deltaP) >= 6;
                const dateShortText = count > 20 ? String(d.dateStr || d.isoDate || '') : `${d.dayShort || ''}, ${d.dateStr || ''}`.replace(/^,\s*/, '');
                const wText = wp ? (isImp ? `${Math.round(wp.val)}` : wp.val.toFixed(1)) : '';
                const gText = gp ? (isImp ? `${Math.round(gp.val)}` : gp.val.toFixed(1)) : '';

                return `
                <g class="cursor-pointer" data-day-id="${escapeHtml(d.id)}" tabindex="0" role="button" aria-label="${escapeHtml(dateShortText)} ветер ${escapeHtml(wText)}">
                    <rect x="${(x - hitW / 2).toFixed(1)}" y="${padT - 8}" width="${hitW.toFixed(1)}" height="${(h - padT - 10).toFixed(1)}" fill="transparent"/>
                    ${isSel ? `<rect x="${(x - Math.min(32, hitW / 2)).toFixed(1)}" y="${padT - 8}" width="${Math.min(64, hitW).toFixed(1)}" height="${(pressBottom - padT + 14).toFixed(1)}" rx="8" fill="rgba(56,189,248,0.10)" stroke="rgba(56,189,248,0.4)"/>` : ''}
                    ${isBaricJump ? `<line x1="${x.toFixed(1)}" y1="${(pressTop - 4).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(pressBottom + 4).toFixed(1)}" stroke="rgba(251, 113, 133, 0.35)" stroke-width="6"/>` : ''}

                    ${wp && gp ? `<line x1="${x.toFixed(1)}" y1="${gp.y.toFixed(1)}" x2="${x.toFixed(1)}" y2="${wp.y.toFixed(1)}" stroke="rgba(251,191,36,0.38)" stroke-width="1.8"/>` : ''}

                    ${gp ? `
                        <circle cx="${gp.x.toFixed(1)}" cy="${gp.y.toFixed(1)}" r="${isSel ? 5.5 : 4.2}" fill="#0f172a" stroke="#fbbf24" stroke-width="2.2"/>
                        ${showLabel ? `<text x="${gp.x.toFixed(1)}" y="${(gp.y - 8).toFixed(1)}" text-anchor="middle" fill="#fde68a" font-size="11" font-family="JetBrains Mono, monospace" font-weight="700">${escapeHtml(gText)}</text>` : ''}
                    ` : ''}

                    ${wp ? `
                        <circle cx="${wp.x.toFixed(1)}" cy="${wp.y.toFixed(1)}" r="${isSel ? 6.5 : 5}" fill="#0f172a" stroke="#38bdf8" stroke-width="2.5"/>
                        ${showLabel ? `<text x="${wp.x.toFixed(1)}" y="${(wp.y + 16).toFixed(1)}" text-anchor="middle" fill="#f8fafc" font-size="11.5" font-family="JetBrains Mono, monospace" font-weight="700">${escapeHtml(wText)}</text>` : ''}
                    ` : ''}

                    ${pp ? `
                        ${isBaricJump ? `<circle cx="${pp.x.toFixed(1)}" cy="${pp.y.toFixed(1)}" r="8" fill="rgba(251,113,133,0.22)" stroke="#fb7185" stroke-width="2"/>` : ''}
                        <circle cx="${pp.x.toFixed(1)}" cy="${pp.y.toFixed(1)}" r="${isBaricJump || isSel ? 5 : 3.8}" fill="#0f172a" stroke="${isBaricJump ? '#fb7185' : '#34d399'}" stroke-width="2.2"/>
                        ${isBaricJump ? `<text x="${pp.x.toFixed(1)}" y="${(pp.y - 11).toFixed(1)}" text-anchor="middle" fill="#fda4af" font-size="10" font-family="JetBrains Mono, monospace" font-weight="700">Δ${deltaP > 0 ? '+' : ''}${Math.round(deltaP)}</text>`
                        : (showLabel ? `<text x="${pp.x.toFixed(1)}" y="${(pp.y - 8).toFixed(1)}" text-anchor="middle" fill="#a7f3d0" font-size="10.5" font-family="JetBrains Mono, monospace" font-weight="700">${pp.val}</text>` : '')}
                    ` : ''}

                    ${showLabel ? `
                        <text x="${x.toFixed(1)}" y="${(h - 24).toFixed(1)}" text-anchor="middle" fill="${isSel ? '#38bdf8' : '#e2e8f0'}" font-size="${count > 20 ? '10.5' : '12'}" font-family="Inter, system-ui, sans-serif" font-weight="700">${escapeHtml(dateShortText)}</text>
                        <text x="${x.toFixed(1)}" y="${(h - 8).toFixed(1)}" text-anchor="middle" fill="#38bdf8" font-size="11" font-family="JetBrains Mono, monospace" font-weight="700">${escapeHtml(d.windDirShort || '—')}</text>
                    ` : ''}
                </g>`;
            }).join('')}
        </svg>
    `;

    containerEl.innerHTML = html;
    bindDayClickDelegation(containerEl, onSelectDay);
    return html;
}

// ============================================================================
// 6. 4-DEPTH SOIL PROFILE (0/6/18/54 CM) + DEW POINT + 0°C FROST THRESHOLD
// ============================================================================
export function renderSoilProfileChart(containerEl, days, uiState = {}, onSelectDay = null) {
    if (!containerEl) return '';
    if (!Array.isArray(days) || !days.length) return renderEmptySvg(containerEl, 'Нет данных по профилю почвы');

    const unit = uiState?.unit || 'metric';
    const isImp = unit === 'imperial';
    const count = days.length;

    const step = count <= 12 ? 82 : (count <= 24 ? 64 : 48);
    const w = Math.max(740, count * step + 96);
    const h = 278;
    const padL = 56;
    const padR = 44;
    const padT = 44;
    const padB = 46;

    const allVals = [isImp ? 22 : -6, isImp ? 42 : 5];
    for (const d of days) {
        [d.soil0C ?? d.soilTempC, d.soil6C, d.soil18C, d.soil54C, d.dewPointC].forEach(c => {
            const v = tempVal(c, null, unit);
            if (v !== null) allVals.push(v);
        });
    }

    const bounds = computeScaleBounds(allVals, isImp ? 3.5 : 2);
    const getY = val => h - padB - ((val - bounds.min) / (bounds.max - bounds.min || 1)) * (h - padT - padB);
    const xCoords = days.map((_, i) => getXCoordinate(i, count, w, padL, padR));
    const zoneSpans = buildZoneSpans(days, xCoords, w, padL, padR);

    const seriesMeta = [
        { key: 'soil0C', fallbackKey: 'soilTempC', label: '0 см', color: '#fbbf24', width: 2.8, dashed: false },
        { key: 'soil6C', label: '6 см', color: '#fb923c', width: 2.3, dashed: false },
        { key: 'soil18C', label: '18 см', color: '#38bdf8', width: 2.2, dashed: false },
        { key: 'soil54C', label: '54 см', color: '#a78bfa', width: 2.2, dashed: false },
        { key: 'dewPointC', label: 'Точка росы', color: '#34d399', width: 2.1, dashed: true }
    ];

    const seriesPts = {};
    const seriesPaths = {};
    for (const s of seriesMeta) {
        const pts = days.map((d, i) => {
            const rawC = d[s.key] ?? (s.fallbackKey ? d[s.fallbackKey] : null);
            const v = tempVal(rawC, null, unit);
            return v !== null ? { x: xCoords[i], y: getY(v), c: toNum(rawC) } : null;
        });
        seriesPts[s.key] = pts;
        seriesPaths[s.key] = buildSegmentedPath(pts);
    }

    const zeroVal = isImp ? 32 : 0;
    const zeroY = getY(zeroVal);
    const showZero = zeroY >= padT - 10 && zeroY <= h - padB + 10;
    const hitW = Math.max(24, step * 0.88);

    const html = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" class="chart-svg-mobile" style="min-width:${w}px;height:${h}px" role="img" aria-label="Температурный профиль почвы на глубинах 0, 6, 18, 54 см и точка росы">
            <!-- Inline Legend -->
            <g font-size="10.5" font-family="JetBrains Mono, monospace">
                <line x1="${padL}" y1="15" x2="${padL + 15}" y2="15" stroke="#fbbf24" stroke-width="2.8"/><text x="${padL + 20}" y="19" fill="#fde68a">0 см</text>
                <line x1="${padL + 60}" y1="15" x2="${padL + 75}" y2="15" stroke="#fb923c" stroke-width="2.4"/><text x="${padL + 80}" y="19" fill="#fed7aa">6 см</text>
                <line x1="${padL + 120}" y1="15" x2="${padL + 135}" y2="15" stroke="#38bdf8" stroke-width="2.4"/><text x="${padL + 140}" y="19" fill="#bae6fd">18 см</text>
                <line x1="${padL + 186}" y1="15" x2="${padL + 201}" y2="15" stroke="#a78bfa" stroke-width="2.4"/><text x="${padL + 206}" y="19" fill="#ddd6fe">54 см</text>
                <line x1="${padL + 252}" y1="15" x2="${padL + 267}" y2="15" stroke="#34d399" stroke-width="2.2" stroke-dasharray="4 3"/><text x="${padL + 272}" y="19" fill="#a7f3d0">Точка росы</text>
            </g>

            <!-- Zone separators -->
            ${zoneSpans.map(sp => sp.hasSeparatorLeft ? `
                <line x1="${sp.leftEdge.toFixed(1)}" y1="${padT - 8}" x2="${sp.leftEdge.toFixed(1)}" y2="${(h - padB + 6).toFixed(1)}" stroke="${sp.meta.color}" stroke-opacity="0.45" stroke-width="1.4" stroke-dasharray="4 4"/>
            ` : '').join('')}

            <!-- 0°C Frost Line -->
            ${showZero ? `
                <line x1="${padL - 10}" y1="${zeroY.toFixed(1)}" x2="${w - padR + 10}" y2="${zeroY.toFixed(1)}" stroke="#fb7185" stroke-width="1.8" stroke-dasharray="5 4"/>
                <text x="${padL - 14}" y="${(zeroY + 4).toFixed(1)}" text-anchor="end" fill="#fb7185" font-size="12" font-family="JetBrains Mono, monospace" font-weight="700">${isImp ? '32°F' : '0°C'}</text>
            ` : ''}

            <!-- Series Polylines -->
            ${seriesMeta.map(s => seriesPaths[s.key] ? `
                <path d="${seriesPaths[s.key]}" fill="none" stroke="${s.color}" stroke-width="${s.width}" ${s.dashed ? 'stroke-dasharray="5 4"' : ''} stroke-linecap="round" stroke-linejoin="round"/>
            ` : '').join('')}

            <!-- Day Nodes & Labels -->
            ${days.map((d, i) => {
                const x = xCoords[i];
                const isSel = d.id === uiState?.selectedDayId;
                const showLabel = isSel || count <= 14 || i % 2 === 0;
                const dateShortText = count > 20 ? String(d.dateStr || d.isoDate || '') : `${d.dayShort || ''}, ${d.dateStr || ''}`.replace(/^,\s*/, '');
                const p0 = seriesPts.soil0C[i];
                const p6 = seriesPts.soil6C[i];
                const p18 = seriesPts.soil18C[i];
                const p54 = seriesPts.soil54C[i];
                const pDew = seriesPts.dewPointC[i];

                return `
                <g class="cursor-pointer" data-day-id="${escapeHtml(d.id)}" tabindex="0" role="button" aria-label="${escapeHtml(dateShortText)} почва 0 см ${escapeHtml(p0 ? fmtTempCompact(p0.c, null, unit) : '—')}">
                    <rect x="${(x - hitW / 2).toFixed(1)}" y="${padT - 8}" width="${hitW.toFixed(1)}" height="${(h - padT - 10).toFixed(1)}" fill="transparent"/>
                    ${isSel ? `<rect x="${(x - Math.min(32, hitW / 2)).toFixed(1)}" y="${padT - 8}" width="${Math.min(64, hitW).toFixed(1)}" height="${(h - padT - padB + 14).toFixed(1)}" rx="8" fill="rgba(56,189,248,0.10)" stroke="rgba(56,189,248,0.4)"/>` : ''}

                    ${p54 ? `<circle cx="${p54.x.toFixed(1)}" cy="${p54.y.toFixed(1)}" r="${isSel ? 4.5 : 3}" fill="#0f172a" stroke="#a78bfa" stroke-width="1.8"/>` : ''}
                    ${p18 ? `<circle cx="${p18.x.toFixed(1)}" cy="${p18.y.toFixed(1)}" r="${isSel ? 4.5 : 3}" fill="#0f172a" stroke="#38bdf8" stroke-width="1.8"/>` : ''}
                    ${p6 ? `<circle cx="${p6.x.toFixed(1)}" cy="${p6.y.toFixed(1)}" r="${isSel ? 4.5 : 3}" fill="#0f172a" stroke="#fb923c" stroke-width="1.8"/>` : ''}
                    ${pDew ? `
                        <circle cx="${pDew.x.toFixed(1)}" cy="${pDew.y.toFixed(1)}" r="${isSel ? 5 : 3.6}" fill="#0f172a" stroke="#34d399" stroke-width="2"/>
                        ${showLabel ? `<text x="${pDew.x.toFixed(1)}" y="${(pDew.y + 15).toFixed(1)}" text-anchor="middle" fill="#6ee7b7" font-size="10.5" font-family="JetBrains Mono, monospace" font-weight="700">${escapeHtml(fmtTempCompact(pDew.c, null, unit))}</text>` : ''}
                    ` : ''}
                    ${p0 ? `
                        <circle cx="${p0.x.toFixed(1)}" cy="${p0.y.toFixed(1)}" r="${isSel ? 6 : 4.6}" fill="#0f172a" stroke="#fbbf24" stroke-width="2.4"/>
                        ${showLabel ? `<text x="${p0.x.toFixed(1)}" y="${(p0.y - 9).toFixed(1)}" text-anchor="middle" fill="#fde68a" font-size="11.5" font-family="JetBrains Mono, monospace" font-weight="700">${escapeHtml(fmtTempCompact(p0.c, null, unit))}</text>` : ''}
                    ` : ''}

                    ${showLabel ? `<text x="${x.toFixed(1)}" y="${(h - 12).toFixed(1)}" text-anchor="middle" fill="${isSel ? '#38bdf8' : '#e2e8f0'}" font-size="${count > 20 ? '11' : '12.5'}" font-family="Inter, system-ui, sans-serif" font-weight="700">${escapeHtml(dateShortText)}</text>` : ''}
                </g>`;
            }).join('')}
        </svg>
    `;

    containerEl.innerHTML = html;
    bindDayClickDelegation(containerEl, onSelectDay);
    return html;
}
