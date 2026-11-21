import { ABAN_COORDS } from './config.js';

const HOUR = 3_600_000;
const LOCAL_OFFSET = ABAN_COORDS.utcOffsetHours * HOUR;

// Offset-free Open-Meteo timestamps are already in Aban civil time.
export function weatherTimeMs(value) {
    if (typeof value !== 'string' || !value.includes('T')) return NaN;
    return /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? Date.parse(value) : Date.parse(value + 'Z') - LOCAL_OFFSET;
}

export function hourRangeLabel(hour) {
    const clock = h => String(h % 24).padStart(2, '0') + ':00';
    return `${clock(hour)}–${clock(hour + 1)}`;
}

export function localHourStart(isoDate, hour) {
    return Date.parse(isoDate + 'T00:00:00Z') - LOCAL_OFFSET + hour * HOUR;
}

export function localParts(ms) {
    const date = new Date(ms + LOCAL_OFFSET);
    return { isoDate: date.toISOString().slice(0, 10), hour: date.getUTCHours() };
}

// Join by timestamp, including midnight and gaps, never by neighbouring array index.
export function openMeteoHourSlots(times) {
    const slots = new Map();
    function put(ms, field, i) {
        if (!slots.has(ms)) slots.set(ms, localParts(ms));
        slots.get(ms)[field] = i;
    }
    times.forEach((time, i) => {
        const end = weatherTimeMs(time);
        if (!Number.isFinite(end) || end % HOUR !== 0) return;
        put(end, 'instantIndex', i);
        put(end - HOUR, 'precipIndex', i);
    });
    return [...slots.entries()].sort(([a], [b]) => a - b).map(([, slot]) => slot);
}

export function precipInterval(startMs, durationHours, mm) {
    if (!Number.isFinite(mm) || mm < 0 || !Number.isFinite(startMs) || startMs % HOUR !== 0 ||
        !Number.isInteger(durationHours) || durationHours <= 0) return null;
    return { startMs, endMs: startMs + durationHours * HOUR, durationHours, mm };
}

export function reportedInterval(interval, mm, defaultHours) {
    const start = weatherTimeMs(interval?.startTime);
    const duration = interval?.endTime ? (weatherTimeMs(interval.endTime) - start) / HOUR : defaultHours;
    return precipInterval(start, duration, mm);
}

// Tile the requested period with whole, non-overlapping reports. Prefer hourly data
// when it covers as much of the window as a longer block. A gap makes the total unknown.
export function sumPrecipIntervals(intervals, startMs, hours) {
    const starting = Array.from({ length: hours }, () => []);
    for (const interval of intervals) {
        if (!interval || !Number.isFinite(interval.mm) || interval.mm < 0) continue;
        const i = (interval.startMs - startMs) / HOUR;
        const n = interval.durationHours;
        if (Number.isInteger(i) && i >= 0 && Number.isInteger(n) && n > 0 && i + n <= hours &&
            interval.endMs === interval.startMs + n * HOUR) starting[i].push(interval);
    }
    const best = Array(hours + 1);
    best[hours] = { covered: 0, count: 0, sum: 0 };
    for (let i = hours - 1; i >= 0; i--) {
        best[i] = best[i + 1];
        for (const b of starting[i]) {
            const tail = best[i + b.durationHours];
            const covered = b.durationHours + tail.covered;
            const count = 1 + tail.count;
            if (covered > best[i].covered || (covered === best[i].covered && count > best[i].count)) {
                best[i] = { covered, count, sum: b.mm + tail.sum };
            }
        }
    }
    return { mm: best[0].covered === hours ? +best[0].sum.toFixed(2) : null, coveredHours: best[0].covered, hours };
}
