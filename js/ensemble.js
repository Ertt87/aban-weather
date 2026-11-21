// ============================================================================
// ABAN METEO v4 — MULTI-MODEL ENSEMBLE, ROLLING MOS & 35-DAY ENGINE
// ============================================================================
import { hourRangeLabel, localHourStart, localParts, openMeteoHourSlots, precipInterval, reportedInterval, sumPrecipIntervals, weatherTimeMs } from './precipitation.js';
import { ABAN_COORDS, MODEL_META, TIME_WINDOWS, SHIFT_START, SHIFT_END, TEMP_QUANTILE_FIELDS, hasEnsembleRange, getAbanClimatology, missingForecastDay } from './config.js';
import {
    cToF,
    msToMph,
    degToCompass,
    computeWetBulbC,
    classifyPrecipPhase,
    blendWindVectors,
    computeApparentTempC,
    convertPressure,
    computeAstronomy,
    detectBasinInversion,
    NO_DIRECTION
} from './physics.js';

const RU_WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const RU_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const OM_MODELS = ['ecmwf_ifs025', 'ecmwf_aifs025', 'icon_seamless', 'gfs_seamless'];

// Physical diurnal template peaking around 14:30 and reaching minimum around sunrise (~06:00)
const DEFAULT_DIURNAL = [
    0.22, 0.16, 0.11, 0.07, 0.03, 0.0, 0.02, 0.12,
    0.28, 0.46, 0.64, 0.80, 0.92, 0.98, 1.0, 0.96,
    0.86, 0.72, 0.56, 0.44, 0.36, 0.31, 0.27, 0.24
];

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function parseIsoDateUtc(isoDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ''));
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function addDaysIso(isoDate, deltaDays) {
    const ms = parseIsoDateUtc(isoDate);
    if (ms === null) return isoDate;
    return new Date(ms + deltaDays * 86400000).toISOString().slice(0, 10);
}

function diffDaysIso(isoA, isoB) {
    const a = parseIsoDateUtc(isoA);
    const b = parseIsoDateUtc(isoB);
    if (a === null || b === null) return 0;
    return Math.round((a - b) / 86400000);
}

function formatDateMeta(isoDate) {
    const ms = parseIsoDateUtc(isoDate);
    if (ms === null) return { dayShort: '—', dateStr: isoDate, year: 2026, isWeekend: false };
    const dt = new Date(ms);
    const dow = dt.getUTCDay();
    return {
        dayShort: RU_WEEKDAYS[dow],
        dateStr: `${dt.getUTCDate()} ${RU_MONTHS[dt.getUTCMonth()]}`,
        year: dt.getUTCFullYear(),
        isWeekend: dow === 0 || dow === 6
    };
}

function utcIsoToAbanParts(isoStr) {
    const str = String(isoStr || '').trim();
    if (!str) return null;
    // Open-Meteo local timezone strings ('2026-10-18T14:00') carry no Z or offset
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(str)) {
        return {
            isoDate: str.slice(0, 10),
            hour: clamp(parseInt(str.slice(11, 13), 10) || 0, 0, 23)
        };
    }
    const ms = Date.parse(str);
    if (!Number.isFinite(ms)) return null;
    const local = new Date(ms + ABAN_COORDS.utcOffsetHours * 3600000);
    return {
        isoDate: local.toISOString().slice(0, 10),
        hour: local.getUTCHours()
    };
}

function formatAbanTimestamp(isoOrNow) {
    const ms = isoOrNow ? Date.parse(isoOrNow) : Date.now();
    const safeMs = Number.isFinite(ms) ? ms : Date.now();
    const local = new Date(safeMs + ABAN_COORDS.utcOffsetHours * 3600000);
    const dd = String(local.getUTCDate()).padStart(2, '0');
    const mon = RU_MONTHS[local.getUTCMonth()];
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const mm = String(local.getUTCMinutes()).padStart(2, '0');
    return {
        isoDate: local.toISOString().slice(0, 10),
        hour: local.getUTCHours(),
        label: `${dd} ${mon}, ${hh}:${mm} (UTC+7)`
    };
}

const NO_PRESSURE = Object.freeze({ stationHpa: null, stationMm: null, mslHpa: null, mslMm: null });

/**
 * Station / sea-level pressure pair, or all-null when no source supplied either value.
 * convertPressure() alone would fall back to a standard 1013 hPa atmosphere, which then shows up
 * as a perfectly flat "forecast" line and as a fake baric jump where real data ends.
 */
function resolvePressure(surfaceHpa, mslHpa, tempC) {
    const s = toNum(surfaceHpa);
    const m = toNum(mslHpa);
    if (s === null && m === null) return NO_PRESSURE;
    return convertPressure({ surfaceHpa: s, mslHpa: m, tempC, elevM: ABAN_COORDS.elev });
}

/** Wind record for sources that provide speed only (ensemble quantiles): no bearing is invented. */
function windSpeedOnly(windMs, gustMs) {
    return {
        windMs,
        windMph: msToMph(windMs),
        gustMs,
        gustMph: msToMph(gustMs),
        windDeg: null,
        windDirShort: NO_DIRECTION.s,
        windDirFull: NO_DIRECTION.f
    };
}

function roundOne(value) {
    const n = toNum(value);
    return n === null ? null : +n.toFixed(1);
}

function ensembleWind(row) {
    const speed = toNum(row?.windP50Ms);
    return windSpeedOnly(speed, speed === null ? null : roundOne(Math.max(speed * 1.5, row.windP90Ms ?? speed * 1.8)));
}

function diffOrNull(a, b) {
    const x = toNum(a);
    const y = toNum(b);
    return x !== null && y !== null ? x - y : null;
}

const STORMS = new Map([
    [95, 'Гроза'],
    [96, 'Гроза с небольшим градом'],
    [97, 'Сильная гроза'],
    [99, 'Гроза с сильным градом']
]);
const UNKNOWN_CONDITION = { ru: 'Нет данных о погодном явлении', en: 'Unknown', icon: 'unknown' };

function wmoCodeToWeather(code, tempC = 0, isNight = false) {
    const c = toNum(code);
    if (STORMS.has(c)) {
        const hail = c === 96 || c === 99;
        return { ru: STORMS.get(c), en: hail ? 'Thunderstorm with hail' : 'Thunderstorm', icon: hail ? 'thunder-hail' : 'thunderstorm' };
    }
    if (c === 0) return { ru: isNight ? 'Ясно' : 'Ясно', en: 'Clear', icon: isNight ? 'clear-night' : 'sunny' };
    if (c === 1) return { ru: 'Преимущественно ясно', en: 'Mostly clear', icon: isNight ? 'partly-cloudy-night' : 'mostly-sunny' };
    if (c === 2) return { ru: 'Малооблачно', en: 'Partly cloudy', icon: isNight ? 'partly-cloudy-night' : 'partly-sunny' };
    if (c === 3) return { ru: 'Пасмурно', en: 'Overcast', icon: isNight ? 'partly-cloudy-night' : 'cloudy' };
    if (c === 45 || c === 48) return { ru: 'Туман / дымка', en: 'Fog', icon: 'fog' };
    if (c === 56 || c === 57 || c === 66 || c === 67) {
        return { ru: 'Ледяной дождь / гололёд', en: 'Freezing rain', icon: 'freezing-rain' };
    }
    if ((c >= 51 && c <= 55) || (c >= 61 && c <= 65) || (c >= 80 && c <= 82)) {
        if (tempC <= -1.0) return { ru: 'Осадки / снег', en: 'Snow / mixed', icon: 'cloudy-snow' };
        return { ru: c === 65 || c === 82 ? 'Дождь' : 'Небольшой дождь', en: 'Rain', icon: 'rain-cloudy' };
    }
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) {
        return { ru: c === 75 || c === 86 ? 'Сильный снег' : 'Небольшой снег', en: 'Snow', icon: c === 71 ? 'cloudy-snow' : 'snow' };
    }
    return { ru: 'Переменная облачность', en: 'Partly cloudy', icon: isNight ? 'partly-cloudy-night' : 'partly-sunny' };
}

function googleCondToMeta(condObj, tempC = 0, isNight = false) {
    const type = String(condObj?.type || '').toUpperCase();
    const text = condObj?.description?.text || null;
    if (type.includes('THUNDER')) {
        const hail = type.includes('HAIL');
        return { icon: hail ? 'thunder-hail' : 'thunderstorm', ru: text || (hail ? 'Гроза с градом' : 'Гроза'), en: type.toLowerCase() };
    }
    if (type.includes('FREEZING') || type.includes('ICE')) {
        return { icon: 'freezing-rain', ru: text || 'Ледяной дождь', en: type.toLowerCase() };
    }
    if (type.includes('SLEET') || type.includes('RAIN_AND_SNOW')) {
        return { icon: 'sleet', ru: text || 'Мокрый снег', en: type.toLowerCase() };
    }
    if (type.includes('SNOW') || type.includes('FLURRIES') || type.includes('BLIZZARD')) {
        return { icon: type.includes('CLOUDY') ? 'cloudy-snow' : 'snow', ru: text || 'Снег', en: type.toLowerCase() };
    }
    if (type.includes('RAIN') || type.includes('DRIZZLE') || type.includes('SHOWER')) {
        return { icon: tempC <= -1 ? 'cloudy-snow' : 'rain-cloudy', ru: text || 'Дождь', en: type.toLowerCase() };
    }
    if (type.includes('FOG') || type.includes('MIST') || type.includes('HAZE')) {
        return { icon: 'fog', ru: text || 'Туман', en: type.toLowerCase() };
    }
    if (type === 'CLEAR' || type === 'SUNNY') {
        return { icon: isNight ? 'clear-night' : 'sunny', ru: text || 'Ясно', en: type.toLowerCase() };
    }
    if (type === 'MOSTLY_CLEAR' || type === 'MOSTLY_SUNNY' || type === 'PARTLY_CLOUDY') {
        return { icon: isNight ? 'partly-cloudy-night' : 'mostly-sunny', ru: text || 'Малооблачно', en: type.toLowerCase() };
    }
    if (type.includes('CLOUDY') || type.includes('OVERCAST')) {
        return { icon: isNight ? 'partly-cloudy-night' : 'cloudy', ru: text || 'Облачно', en: type.toLowerCase() };
    }
    return {
        icon: isNight ? 'partly-cloudy-night' : 'partly-sunny',
        ru: text || 'Переменная облачность',
        en: type ? type.toLowerCase() : 'partly cloudy'
    };
}

function reportedWeather(code, source, tempC, isNight) {
    if (toNum(code) === null) return null;
    return { ...wmoCodeToWeather(code, tempC, isNight), code: Number(code), source };
}

function stormPriority(weather) {
    if (weather?.icon === 'thunder-hail') return weather.code === 99 ? 4 : 3;
    if (weather?.icon === 'thunderstorm') return weather.code === 97 ? 2 : 1;
    return 0;
}

// Inputs are in order of preference. Keep an explicit storm/hail signal even
// when a higher-weight model predicts rain for the same period.
function chooseWeather(candidates) {
    return candidates.reduce((best, item) =>
        item && (!best || stormPriority(item) > stormPriority(best)) ? item : best, null);
}

function weatherLabel(weather) {
    const source = MODEL_META[weather.source]?.shortName || weather.source;
    return stormPriority(weather) && source ? `${weather.ru} (${source}${weather.dailyOnly ? ', за сутки' : ''})` : weather.ru;
}

// Check provider values before interpolation, climate normals and gust estimates.
// A complete daily report or 24 actual hours can support a daily road assessment.
function coversRoadRisk({ modelId, dailyRec, hourlyMap }) {
    const fields = ['precipMm', 'windMs', 'gustMs'];
    const hasFields = (record, keys) => keys.every(key => Number.isFinite(record?.[key]));
    if (modelId !== 'met_no' && modelId !== 'google_wn3' && hasFields(dailyRec, ['maxC', 'minC', ...fields])) return true;
    return hourlyMap?.size === 24 && [...hourlyMap.values()].every(h => hasFields(h, ['tempC', ...fields]));
}

function getModelWeight(modelId, offset, mosModels) {
    const meta = MODEL_META[modelId];
    if (!meta) return 0.1;
    let base;
    if (offset <= 1) base = meta.weights.short48h;
    else if (offset <= 9) base = meta.weights.med10d;
    else base = meta.weights.ext16d;

    const mult = mosModels?.[modelId]?.weightMultiplier ?? 1.0;
    return Math.max(0.01, base * mult);
}

function weightedMean(entries) {
    let sumVW = 0;
    let sumW = 0;
    for (const e of entries) {
        if (!Number.isFinite(e.value) || !Number.isFinite(e.weight) || e.weight <= 0) continue;
        sumVW += e.value * e.weight;
        sumW += e.weight;
    }
    return sumW > 0 ? sumVW / sumW : null;
}

function weightedTrimmedMean(entries, trimFrac = 0.2) {
    const valid = entries.filter((e) => Number.isFinite(e.value) && Number.isFinite(e.weight) && e.weight > 0);
    if (!valid.length) return null;
    if (valid.length === 1) return valid[0].value;
    if (valid.length === 2) {
        return (valid[0].value * valid[0].weight + valid[1].value * valid[1].weight) / (valid[0].weight + valid[1].weight);
    }
    const sorted = [...valid].sort((a, b) => a.value - b.value);
    const totalW = sorted.reduce((s, e) => s + e.weight, 0);
    const frac = valid.length === 3 ? 0.12 : trimFrac;
    const lowCut = totalW * frac;
    const highCut = totalW * (1 - frac);

    let cum = 0;
    let sumVW = 0;
    let sumW = 0;
    for (const e of sorted) {
        const segStart = cum;
        const segEnd = cum + e.weight;
        cum = segEnd;
        const overlap = Math.max(0, Math.min(segEnd, highCut) - Math.max(segStart, lowCut));
        if (overlap > 0) {
            sumVW += e.value * overlap;
            sumW += overlap;
        }
    }
    return sumW > 1e-9 ? sumVW / sumW : sorted[Math.floor(sorted.length / 2)].value;
}

function enforceQuantiles(central, p10, p25, p75, p90, fallbackHalfSpread = 1.5) {
    if (central == null) return { p10: null, p25: null, p75: null, p90: null };
    const c = Number(central);
    let q25 = toNum(p25);
    let q10 = toNum(p10);
    let q75 = toNum(p75);
    let q90 = toNum(p90);

    q25 = q25 !== null ? Math.min(q25, c) : c - fallbackHalfSpread * 0.5;
    q10 = q10 !== null ? Math.min(q10, q25) : q25 - fallbackHalfSpread * 0.5;
    q75 = q75 !== null ? Math.max(q75, c) : c + fallbackHalfSpread * 0.5;
    q90 = q90 !== null ? Math.max(q90, q75) : q75 + fallbackHalfSpread * 0.5;

    return {
        p10: +q10.toFixed(1),
        p25: +q25.toFixed(1),
        p75: +q75.toFixed(1),
        p90: +q90.toFixed(1)
    };
}

function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
}

// ============================================================================
// 1. ROLLING 14-DAY MOS CALIBRATION
// ============================================================================
export function computeRollingMos(previousRunsPayload) {
    const empty = {
        models: {},
        bestModelId: null,
        summaryRu: 'MOS: калибровка по прошлым прогонам недоступна'
    };
    if (!previousRunsPayload) return empty;

    const payload = previousRunsPayload.hourly ? previousRunsPayload : previousRunsPayload.data || previousRunsPayload;
    const hourly = payload?.hourly;
    if (!hourly || !Array.isArray(hourly.time) || !hourly.time.length) {
        return empty;
    }

    const times = hourly.time;
    const maxHours = Math.min(times.length, 14 * 24);
    const modelsOut = {};

    const resolveArr = (baseName, modelId) => {
        if (Array.isArray(hourly[`${baseName}_${modelId}`])) return hourly[`${baseName}_${modelId}`];
        if (modelId === 'ecmwf_ifs025' && Array.isArray(hourly[baseName])) return hourly[baseName];
        return null;
    };

    for (const modelId of OM_MODELS) {
        const actual = resolveArr('temperature_2m', modelId);
        if (!actual) continue;
        const prev1 = resolveArr('temperature_2m_previous_day1', modelId);
        const prev2 = resolveArr('temperature_2m_previous_day2', modelId);
        if (!prev1 && !prev2) continue;

        let absErrSum = 0;
        let absWeightSum = 0;
        let dayErrSum = 0;
        let dayWeightSum = 0;
        let nightErrSum = 0;
        let nightWeightSum = 0;
        let samples = 0;

        for (let i = 0; i < maxHours; i++) {
            const act = toNum(actual[i]);
            if (act === null) continue;
            const p1 = prev1 ? toNum(prev1[i]) : null;
            const p2 = prev2 ? toNum(prev2[i]) : null;
            if (p1 === null && p2 === null) continue;

            const parts = utcIsoToAbanParts(times[i]);
            const h = parts ? parts.hour : i % 24;
            const isDay = h >= 8 && h < 20;
            samples++;

            const pairs = [];
            if (p1 !== null) pairs.push({ err: p1 - act, w: 1.0 });
            if (p2 !== null) pairs.push({ err: p2 - act, w: 0.65 });

            for (const pair of pairs) {
                absErrSum += pair.w * Math.abs(pair.err);
                absWeightSum += pair.w;
                if (isDay) {
                    dayErrSum += pair.w * pair.err;
                    dayWeightSum += pair.w;
                } else {
                    nightErrSum += pair.w * pair.err;
                    nightWeightSum += pair.w;
                }
            }
        }

        if (samples < 4 || absWeightSum <= 0) continue;

        const maeC = +(absErrSum / absWeightSum).toFixed(2);
        const dayBiasC = +clamp(dayWeightSum > 0 ? dayErrSum / dayWeightSum : 0, -6, 6).toFixed(2);
        const nightBiasC = +clamp(nightWeightSum > 0 ? nightErrSum / nightWeightSum : 0, -6, 6).toFixed(2);
        const skillScore = +clamp(1 / (1 + maeC / 2.5), 0.1, 1.0).toFixed(3);

        modelsOut[modelId] = {
            maeC,
            dayBiasC,
            nightBiasC,
            samples,
            skillScore,
            weightMultiplier: 1.0
        };
    }

    const activeIds = Object.keys(modelsOut);
    if (!activeIds.length) return empty;

    const maes = activeIds.map((id) => modelsOut[id].maeC).sort((a, b) => a - b);
    const medianMae = maes[Math.floor(maes.length / 2)];
    let bestModelId = activeIds[0];

    for (const id of activeIds) {
        const m = modelsOut[id];
        m.weightMultiplier = +clamp((medianMae + 0.3) / (m.maeC + 0.3), 0.55, 1.65).toFixed(3);
        if (m.maeC < modelsOut[bestModelId].maeC) bestModelId = id;
    }

    const bestMeta = MODEL_META[bestModelId];
    const bestStats = modelsOut[bestModelId];
    return {
        models: modelsOut,
        bestModelId,
        // "MAE к анализу": the reference is each model's own latest analysis, NOT station observations,
        // so this ranks run-to-run consistency and must not be read as absolute forecast accuracy.
        referenceRu: 'собственный анализ модели',
        summaryRu: `MOS 14д: лидер ${bestMeta?.shortName || bestModelId} (MAE к анализу ${bestStats.maeC.toFixed(1)}°C, день ${bestStats.dayBiasC >= 0 ? '+' : ''}${bestStats.dayBiasC.toFixed(1)}°, ночь ${bestStats.nightBiasC >= 0 ? '+' : ''}${bestStats.nightBiasC.toFixed(1)}°)`
    };
}

// ============================================================================
// UPSTREAM PAYLOAD PARSERS
// ============================================================================
function snowDepthToCm(val, unitHint) {
    const n = toNum(val);
    if (n === null) return null;
    if (unitHint === 'cm') return +Math.max(0, n).toFixed(1);
    if (unitHint === 'm') return +Math.max(0, n * 100).toFixed(1);
    return +Math.max(0, n > 1.5 ? n : n * 100).toFixed(1);
}

function parseOpenMeteoMulti(payload) {
    const byModel = {};
    if (!payload) return byModel;

    const extractOne = (src, modelId, allowUnsuffixed) => {
        const hMap = new Map();
        const dMap = new Map();
        const hourly = src?.hourly;
        const daily = src?.daily;

        const hVar = (name) => {
            if (hourly?.[`${name}_${modelId}`]) return hourly[`${name}_${modelId}`];
            if (allowUnsuffixed && hourly?.[name]) return hourly[name];
            return null;
        };
        const dVar = (name) => {
            if (daily?.[`${name}_${modelId}`]) return daily[`${name}_${modelId}`];
            if (allowUnsuffixed && daily?.[name]) return daily[name];
            return null;
        };

        if (hourly && Array.isArray(hourly.time)) {
            const tArr = hVar('temperature_2m');
            const wmoArr = hVar('weather_code');
            if (tArr || wmoArr || hVar('precipitation') || hVar('precipitation_probability')) {
                const appArr = hVar('apparent_temperature');
                const rhArr = hVar('relative_humidity_2m');
                const dewArr = hVar('dew_point_2m');
                const pArr = hVar('precipitation');
                const probArr = hVar('precipitation_probability');
                const rArr = hVar('rain');
                const sArr = hVar('snowfall');
                const pmslArr = hVar('pressure_msl');
                const psurfArr = hVar('surface_pressure');
                const cldArr = hVar('cloud_cover');
                const wsArr = hVar('wind_speed_10m');
                const wdArr = hVar('wind_direction_10m');
                const wgArr = hVar('wind_gusts_10m');

                for (const parts of openMeteoHourSlots(hourly.time)) {
                    const { instantIndex: i, precipIndex: p } = parts;
                    const tempC = toNum(tArr?.[i]);
                    if ([tempC, wmoArr?.[i], pArr?.[p], probArr?.[p]].every(v => toNum(v) === null)) continue;
                    if (!hMap.has(parts.isoDate)) hMap.set(parts.isoDate, new Map());
                    hMap.get(parts.isoDate).set(parts.hour, {
                        tempC,
                        feelsC: toNum(appArr?.[i]),
                        precipProb: toNum(probArr?.[p]),
                        humidity: toNum(rhArr?.[i]),
                        dewPointC: toNum(dewArr?.[i]),
                        precipMm: toNum(pArr?.[p]),
                        rainMm: toNum(rArr?.[p]),
                        snowfallCm: toNum(sArr?.[p]),
                        weatherCode: toNum(wmoArr?.[i]),
                        pressureMslHpa: toNum(pmslArr?.[i]),
                        surfacePressureHpa: toNum(psurfArr?.[i]),
                        cloudCoverPct: toNum(cldArr?.[i]),
                        windMs: toNum(wsArr?.[i]),
                        windDeg: toNum(wdArr?.[i]),
                        gustMs: toNum(wgArr?.[i])
                    });
                }
            }
        }

        if (daily && Array.isArray(daily.time)) {
            const maxArr = dVar('temperature_2m_max');
            const minArr = dVar('temperature_2m_min');
            const wmoArr = dVar('weather_code');
            if (maxArr || minArr || wmoArr || dVar('precipitation_sum') || dVar('wind_speed_10m_max')) {
                const pArr = dVar('precipitation_sum');
                const rArr = dVar('rain_sum');
                const sArr = dVar('snowfall_sum');
                const wsArr = dVar('wind_speed_10m_max');
                const wgArr = dVar('wind_gusts_10m_max');
                const wdArr = dVar('wind_direction_10m_dominant');

                for (let i = 0; i < daily.time.length; i++) {
                    const isoDate = String(daily.time[i]).slice(0, 10);
                    const maxC = toNum(maxArr?.[i]);
                    const minC = toNum(minArr?.[i]);
                    if ([maxC, minC, wmoArr?.[i], pArr?.[i], wsArr?.[i]].every(v => toNum(v) === null)) continue;
                    dMap.set(isoDate, {
                        maxC,
                        minC,
                        weatherCode: toNum(wmoArr?.[i]),
                        precipMm: toNum(pArr?.[i]),
                        rainMm: toNum(rArr?.[i]),
                        snowfallCm: toNum(sArr?.[i]),
                        windMs: toNum(wsArr?.[i]),
                        gustMs: toNum(wgArr?.[i]),
                        windDeg: toNum(wdArr?.[i])
                    });
                }
            }
        }

        if (hMap.size || dMap.size) {
            byModel[modelId] = { hourlyByDate: hMap, dailyByDate: dMap };
        }
    };

    const hasExplicitModels = OM_MODELS.some(
        (m) => payload.hourly?.[`temperature_2m_${m}`] || payload.daily?.[`temperature_2m_max_${m}`]
    );
    for (const m of OM_MODELS) {
        if (payload[m] && (payload[m].hourly || payload[m].daily)) {
            extractOne(payload[m], m, true);
        } else {
            extractOne(payload, m, !hasExplicitModels && m === 'ecmwf_ifs025');
        }
    }
    return byModel;
}

function parseOpenMeteoCompanion(payload) {
    const hourlyByDate = new Map();
    const dailyByDate = new Map();
    if (!payload) return { hourlyByDate, dailyByDate };

    const snowUnit = payload.hourly_units?.snow_depth;
    const h = payload.hourly;
    if (h && Array.isArray(h.time)) {
        for (const parts of openMeteoHourSlots(h.time)) {
            const { instantIndex: i, precipIndex: p } = parts;
            if (!hourlyByDate.has(parts.isoDate)) hourlyByDate.set(parts.isoDate, new Map());
            hourlyByDate.get(parts.isoDate).set(parts.hour, {
                precipProb: toNum(h.precipitation_probability?.[p]),
                snowDepthCm: snowDepthToCm(h.snow_depth?.[i], snowUnit),
                soil0C: toNum(h.soil_temperature_0cm?.[i] ?? h.soil_temperature_0_to_7cm?.[i]),
                soil6C: toNum(h.soil_temperature_6cm?.[i]),
                soil18C: toNum(h.soil_temperature_18cm?.[i]),
                soil54C: toNum(h.soil_temperature_54cm?.[i]),
                soilMoisture0: toNum(h.soil_moisture_0_to_1cm?.[i]),
                pressureMslHpa: toNum(h.pressure_msl?.[i]),
                surfacePressureHpa: toNum(h.surface_pressure?.[i])
            });
        }
    }

    const d = payload.daily;
    if (d && Array.isArray(d.time)) {
        for (let i = 0; i < d.time.length; i++) {
            const isoDate = String(d.time[i]).slice(0, 10);
            dailyByDate.set(isoDate, {
                uv: toNum(d.uv_index_max?.[i]),
                precipProbMax: toNum(d.precipitation_probability_max?.[i]),
                shortwaveRadMj: toNum(d.shortwave_radiation_sum?.[i])
            });
        }
    }

    return { hourlyByDate, dailyByDate };
}

function parseGoogleSpeedMs(speedObj) {
    const val = toNum(speedObj?.value);
    if (val === null) return null;
    const unit = String(speedObj?.unit || 'KILOMETERS_PER_HOUR').toUpperCase();
    if (unit === 'METERS_PER_SECOND') return val;
    if (unit === 'MILES_PER_HOUR') return val * 0.44704;
    return val / 3.6;
}

function parseGoogleWeather(google) {
    const hourlyByDate = new Map();
    const dailyByDate = new Map();
    const precipBlocks = [];
    if (!google) return { hourlyByDate, dailyByDate, precipBlocks, current: null };

    const ingestHours = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const gh of arr) {
            const isoStr = gh?.interval?.startTime || gh?.time;
            let parts = isoStr ? utcIsoToAbanParts(isoStr) : null;
            if (!parts && gh?.displayDateTime?.year) {
                const dt = gh.displayDateTime;
                parts = {
                    isoDate: `${dt.year}-${String(dt.month).padStart(2, '0')}-${String(dt.day).padStart(2, '0')}`,
                    hour: clamp(Number(dt.hours) || 0, 0, 23)
                };
            }
            if (!parts) continue;
            const tempC = toNum(gh.temperature?.degrees);
            const interval = gh.interval?.startTime ? gh.interval : { startTime: new Date(localHourStart(parts.isoDate, parts.hour)).toISOString() };
            // Google's ForecastHour/HistoryHour represents one explicit interval.
            const bounds = reportedInterval(interval, 0, 1);
            const oneHour = bounds?.durationHours === 1;
            const amount = oneHour ? toNum(gh.precipitation?.qpf?.quantity) : null;
            const probability = oneHour ? toNum(gh.precipitation?.probability?.percent) : null;
            if (tempC === null && amount === null && probability === null && !gh.weatherCondition) continue;
            if (!hourlyByDate.has(parts.isoDate)) hourlyByDate.set(parts.isoDate, new Map());
            const ws = parseGoogleSpeedMs(gh.wind?.speed);
            const wg = parseGoogleSpeedMs(gh.wind?.gust);
            const meta = googleCondToMeta(gh.weatherCondition, tempC, !gh.isDaytime);
            hourlyByDate.get(parts.isoDate).set(parts.hour, {
                tempC,
                feelsC: toNum(gh.feelsLikeTemperature?.degrees),
                humidity: toNum(gh.relativeHumidity),
                dewPointC: toNum(gh.dewPoint?.degrees),
                precipProb: probability,
                precipMm: amount,
                cloudCoverPct: toNum(gh.cloudCover),
                pressureMslHpa: toNum(gh.airPressure?.meanSeaLevelMillibars),
                windMs: ws,
                gustMs: wg,
                windDeg: toNum(gh.wind?.direction?.degrees),
                uv: toNum(gh.uvIndex),
                condRu: meta.ru,
                weather: gh.weatherCondition ? { ...meta, source: 'google_wn3' } : null,
                iconType: meta.icon
            });
        }
    };

    ingestHours(google.historyHours);
    ingestHours(google.forecastHours);

    if (Array.isArray(google.forecastDays)) {
        for (const gd of google.forecastDays) {
            let isoDate = null;
            if (gd?.displayDate?.year) {
                isoDate = `${gd.displayDate.year}-${String(gd.displayDate.month).padStart(2, '0')}-${String(gd.displayDate.day).padStart(2, '0')}`;
            } else if (gd?.interval?.startTime) {
                isoDate = utcIsoToAbanParts(gd.interval.startTime)?.isoDate || null;
            }
            if (!isoDate) continue;

            const dayF = gd.daytimeForecast || {};
            const nightF = gd.nighttimeForecast || {};
            const maxC = toNum(gd.maxTemperature?.degrees);
            const minC = toNum(gd.minTemperature?.degrees);
            const dayMeta = googleCondToMeta(dayF.weatherCondition, maxC ?? 0, false);
            const nightMeta = googleCondToMeta(nightF.weatherCondition, minC ?? 0, true);
            const qpfDay = toNum(dayF.precipitation?.qpf?.quantity);
            const qpfNight = toNum(nightF.precipitation?.qpf?.quantity);
            if ([maxC, minC, qpfDay, qpfNight].every(v => v === null) && !dayF.weatherCondition && !nightF.weatherCondition) continue;

            const parts = [reportedInterval(dayF.interval, qpfDay), reportedInterval(nightF.interval, qpfNight)].filter(Boolean);
            precipBlocks.push(...parts);
            dailyByDate.set(isoDate, {
                maxC,
                minC,
                dayWeather: dayF.weatherCondition ? { ...dayMeta, source: 'google_wn3' } : null,
                nightWeather: nightF.weatherCondition ? { ...nightMeta, source: 'google_wn3' } : null,
                precipDay: toNum(dayF.precipitation?.probability?.percent),
                precipNight: toNum(nightF.precipitation?.probability?.percent),
                precipMm: null, // Filled below only if the reports cover this local calendar day.
                humidity: toNum(dayF.relativeHumidity ?? nightF.relativeHumidity),
                uv: toNum(dayF.uvIndex),
                windMs: parseGoogleSpeedMs(dayF.wind?.speed ?? nightF.wind?.speed),
                gustMs: parseGoogleSpeedMs(dayF.wind?.gust ?? nightF.wind?.gust),
                windDeg: toNum(dayF.wind?.direction?.degrees ?? nightF.wind?.direction?.degrees),
                cloudCoverPct: toNum(dayF.cloudCover)
            });
        }
    }

    for (const [isoDate, day] of dailyByDate) {
        day.precipMm = sumPrecipIntervals(precipBlocks, localHourStart(isoDate, 0), 24).mm;
    }
    return { hourlyByDate, dailyByDate, precipBlocks, current: google.current || null };
}

function parseMetNo(metNo) {
    const hourlyByDate = new Map();
    const dailyByDate = new Map();
    const precipBlocks = [];
    const series = metNo?.properties?.timeseries;
    if (!Array.isArray(series)) return { hourlyByDate, dailyByDate };

    for (const item of series) {
        const parts = utcIsoToAbanParts(item.time);
        if (!parts) continue;
        const det = item.data?.instant?.details || {};
        const tempC = toNum(det.air_temperature);
        const next1 = item.data?.next_1_hours?.details || {};
        const next6 = item.data?.next_6_hours?.details || {};
        const p1 = toNum(next1.precipitation_amount);
        const p6 = toNum(next6.precipitation_amount);
        const startMs = weatherTimeMs(item.time);
        const block = precipInterval(startMs, 6, p6);
        if (block) precipBlocks.push(block);
        const hourly = precipInterval(startMs, 1, p1);
        if (tempC === null && !hourly && !block) continue;

        if (!hourlyByDate.has(parts.isoDate)) hourlyByDate.set(parts.isoDate, new Map());
        hourlyByDate.get(parts.isoDate).set(parts.hour, {
            tempC,
            humidity: toNum(det.relative_humidity),
            dewPointC: toNum(det.dew_point_temperature),
            windMs: toNum(det.wind_speed),
            gustMs: toNum(det.wind_speed_of_gust),
            windDeg: toNum(det.wind_from_direction),
            pressureMslHpa: toNum(det.air_pressure_at_sea_level),
            cloudCoverPct: toNum(det.cloud_area_fraction),
            precipMm: hourly?.mm ?? null
        });
    }

    for (const [isoDate, hMap] of hourlyByDate.entries()) {
        if (hMap.size < 4) continue;
        const vals = [...hMap.values()];
        const temps = vals.map((v) => v.tempC).filter(Number.isFinite);
        if (!temps.length) continue;
        const winds = vals.map((v) => v.windMs).filter((v) => v !== null);
        const gusts = vals.map((v) => v.gustMs).filter((v) => v !== null);
        const midnight = localHourStart(isoDate, 0);
        const hourly = [...hMap].map(([hour, h]) => precipInterval(localHourStart(isoDate, hour), 1, h.precipMm));
        const dailyPrecip = sumPrecipIntervals([...hourly, ...precipBlocks], midnight, 24);
        const wAvg = blendWindVectors(vals.filter((v) => v.windMs !== null).map((v) => ({ speedMs: v.windMs, gustMs: v.gustMs, dirDeg: v.windDeg ?? 0, weight: 1 })));
        dailyByDate.set(isoDate, {
            maxC: +Math.max(...temps).toFixed(1),
            minC: +Math.min(...temps).toFixed(1),
            precipMm: dailyPrecip.mm,
            windMs: winds.length ? +Math.max(...winds).toFixed(1) : null,
            gustMs: gusts.length ? +Math.max(...gusts).toFixed(1) : null,
            windDeg: wAvg.windDeg
        });
    }

    return { hourlyByDate, dailyByDate, precipBlocks };
}

function quantileSorted(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
        return +(sorted[base] + rest * (sorted[base + 1] - sorted[base])).toFixed(1);
    }
    return +sorted[base].toFixed(1);
}

function parseEnsemble35(ensemble35) {
    const qMap = new Map();
    if (!ensemble35) return qMap;

    if (Array.isArray(ensemble35.dailyQuantiles)) {
        for (const row of ensemble35.dailyQuantiles) {
            if (!row?.isoDate || [row.maxP50C, row.minP50C, row.precipP50Mm, row.windP50Ms].every(v => toNum(v) === null)) continue;
            const sources = row.sources ?? (ensemble35.sources?.length === 1 ? ensemble35.sources : []);
            qMap.set(String(row.isoDate).slice(0, 10), { ...row, sources });
        }
        return qMap;
    }

    // Fallback: parse raw Open-Meteo ensemble daily member arrays (member01..member51)
    const daily = ensemble35.daily;
    if (daily && Array.isArray(daily.time)) {
        const keys = Object.keys(daily);
        const maxKeys = keys.filter((k) => k.startsWith('temperature_2m_max'));
        const minKeys = keys.filter((k) => k.startsWith('temperature_2m_min'));
        const precipKeys = keys.filter((k) => k.startsWith('precipitation_sum'));
        const windKeys = keys.filter((k) => k.startsWith('wind_speed_10m_max'));

        for (let i = 0; i < daily.time.length; i++) {
            const isoDate = String(daily.time[i]).slice(0, 10);
            const maxMembers = maxKeys.map((k) => toNum(daily[k]?.[i])).filter((v) => v !== null).sort((a, b) => a - b);
            const minMembers = minKeys.map((k) => toNum(daily[k]?.[i])).filter((v) => v !== null).sort((a, b) => a - b);
            const pMembers = precipKeys.map((k) => toNum(daily[k]?.[i])).filter((v) => v !== null).sort((a, b) => a - b);
            const wMembers = windKeys.map((k) => toNum(daily[k]?.[i])).filter((v) => v !== null).sort((a, b) => a - b);

            if (!maxMembers.length && !minMembers.length && !pMembers.length && !wMembers.length) continue;

            const belowMinus20 = minMembers.length
                ? Math.round((minMembers.filter((v) => v <= -20).length / minMembers.length) * 100)
                : null;
            const precipOver5 = pMembers.length
                ? Math.round((pMembers.filter((v) => v >= 5).length / pMembers.length) * 100)
                : null;

            qMap.set(isoDate, {
                isoDate,
                temperatureMemberCount: Math.min(maxMembers.length, minMembers.length),
                maxP10C: quantileSorted(maxMembers, 0.1),
                maxP25C: quantileSorted(maxMembers, 0.25),
                maxP50C: quantileSorted(maxMembers, 0.5),
                maxP75C: quantileSorted(maxMembers, 0.75),
                maxP90C: quantileSorted(maxMembers, 0.9),
                minP10C: quantileSorted(minMembers, 0.1),
                minP25C: quantileSorted(minMembers, 0.25),
                minP50C: quantileSorted(minMembers, 0.5),
                minP75C: quantileSorted(minMembers, 0.75),
                minP90C: quantileSorted(minMembers, 0.9),
                precipP50Mm: quantileSorted(pMembers, 0.5),
                precipP75Mm: quantileSorted(pMembers, 0.75),
                precipP90Mm: quantileSorted(pMembers, 0.9),
                windP50Ms: quantileSorted(wMembers, 0.5),
                windP90Ms: quantileSorted(wMembers, 0.9),
                probBelowMinus20: belowMinus20,
                probPrecipOver5: precipOver5
            });
        }
    }

    return qMap;
}

// ============================================================================
// SYNTHETIC DIURNAL FALLBACK (ONLY FOR SPARSE SUBSEASONAL / ERA5 DAYS)
// ============================================================================
function buildSyntheticHours({ maxC, minC, humidity, windMs, gustMs, windDeg, pressureStationMm, pressureMslMm, cloudCoverPct, soil0C, astronomy, dayIcon, nightIcon }) {
    const comp = toNum(windDeg) !== null ? degToCompass(windDeg) : NO_DIRECTION;
    const sr = astronomy?.sunriseHour ?? 7;
    const ss = astronomy?.sunsetHour ?? 18;
    const minHour = clamp(Math.round(sr - 0.5), 2, 9);

    return Array.from({ length: 24 }, (_, h) => {
        // Shift template minimum slightly toward local sunrise while preserving afternoon peak ~14:30
        const shiftedIdx = (h - (minHour - 5) + 24) % 24;
        const w = DEFAULT_DIURNAL[shiftedIdx];
        const tempC = +(minC + w * (maxC - minC)).toFixed(1);
        const hWind = windMs === null ? null : +(windMs * (0.76 + 0.34 * w)).toFixed(1);
        const hGust = gustMs === null ? null : +Math.max(hWind, gustMs * (0.76 + 0.34 * w)).toFixed(1);
        const hHum = Math.round(clamp(humidity + (1 - w) * 12 - w * 10, 30, 98));
        const wetBulbC = computeWetBulbC(tempC, hHum);
        const feelsC = computeApparentTempC(tempC, hWind, hHum);
        const dewPointC = +(tempC - (100 - hHum) / 5).toFixed(1);
        const hSoil0 = +(soil0C + (w - 0.5) * 0.7).toFixed(1);
        const isDay = h >= sr && h <= ss;

        return {
            hour: h,
            hourStr: `${String(h).padStart(2, '0')}:00`,
            tempC,
            tempF: cToF(tempC),
            feelsC,
            wetBulbC,
            dewPointC,
            humidity: hHum,
            precipMm: null,
            precipProb: null,
            precipPhase: null,
            windMs: hWind,
            windMph: msToMph(hWind),
            gustMs: hGust,
            windDirShort: comp.s,
            pressureStationMm,
            pressureMslMm,
            cloudCoverPct,
            soil0C: hSoil0,
            iconType: isDay ? dayIcon : nightIcon,
            isSynthetic: true
        };
    });
}

// ============================================================================
// BUILD CANONICAL DAY RECORD
// ============================================================================
function buildZoneDayRecord({
    isoDate,
    offsetFromToday,
    activeModelIds,
    mode,
    preferredOmModel,
    omModelsData,
    companionData,
    googleData,
    metNoData,
    ensQ,
    mos,
    rawArchiveDay = null
}) {
    const dateMeta = formatDateMeta(isoDate);
    const clim = getAbanClimatology(isoDate);
    const astronomy = computeAstronomy(isoDate, ABAN_COORDS.lat, ABAN_COORDS.lon, ABAN_COORDS.utcOffsetHours);

    let zone;
    if (offsetFromToday < 0) {
        zone = 'archive';
    } else if (offsetFromToday <= 9) {
        zone = 'deterministic';
    } else if (offsetFromToday <= 15) {
        zone = 'extended_ensemble';
    } else {
        zone = 'subseasonal';
    }

    const isArchive = zone === 'archive';
    const identity = {
        id: `day_${isoDate}`, idx: 0, isoDate, offsetFromToday, zone, isArchive,
        dayShort: dateMeta.dayShort, dateStr: dateMeta.dateStr,
        fullDateLabel: `${dateMeta.dayShort}, ${dateMeta.dateStr} ${dateMeta.year}${isArchive ? ' (Архив)' : offsetFromToday === 0 ? ' (Сегодня)' : ''}`,
        label: offsetFromToday === -1 ? 'Вчера (Архив)' : isArchive ? 'Архив' : offsetFromToday === 0 ? 'Сегодня' :
            offsetFromToday === 1 ? 'Завтра' : dateMeta.isWeekend ? `${dateMeta.dayShort} (Вых.)` : dateMeta.dayShort
    };
    const damping = isArchive ? 0 : Math.exp(-Math.max(0, offsetFromToday) / 4);

    // Collect model weights for this day
    const modelSourcesForDay = [];
    const modelBreakdown = {};

    const addModelSource = (modelId, dailyRec, hourlyMap) => {
        if (!dailyRec && (!hourlyMap || !hourlyMap.size)) return;
        let w = getModelWeight(modelId, Math.max(0, offsetFromToday), mos?.models);
        if (mode === 'open_meteo' && preferredOmModel && preferredOmModel !== 'multi' && preferredOmModel !== 'best_match') {
            if (modelId === preferredOmModel) w = 100;
        }
        modelSourcesForDay.push({ modelId, weight: w, dailyRec, hourlyMap });

        if (dailyRec && dailyRec.maxC !== null && dailyRec.minC !== null) {
            modelBreakdown[modelId] = {
                maxC: +dailyRec.maxC.toFixed(1),
                minC: +dailyRec.minC.toFixed(1),
                precipMm: dailyRec.precipMm ?? null,
                windMs: roundOne(dailyRec.windMs)
            };
        } else if (hourlyMap && hourlyMap.size >= 6) {
            const temps = [...hourlyMap.values()].map((x) => x.tempC).filter((v) => v !== null);
            const winds = [...hourlyMap.values()].map((x) => x.windMs).filter((v) => v !== null);
            const precs = [...hourlyMap.values()].map((x) => x.precipMm).filter((v) => v !== null);
            if (temps.length) {
                modelBreakdown[modelId] = {
                    maxC: +Math.max(...temps).toFixed(1),
                    minC: +Math.min(...temps).toFixed(1),
                    precipMm: precs.length === 24 ? +precs.reduce((a, b) => a + b, 0).toFixed(2) : null,
                    windMs: winds.length ? roundOne(Math.max(...winds)) : null
                };
            }
        }
    };

    if (activeModelIds.includes('google_wn3') && googleData) {
        addModelSource('google_wn3', googleData.dailyByDate.get(isoDate), googleData.hourlyByDate.get(isoDate));
    }
    for (const omId of OM_MODELS) {
        if (activeModelIds.includes(omId) && omModelsData[omId]) {
            addModelSource(omId, omModelsData[omId].dailyByDate.get(isoDate), omModelsData[omId].hourlyByDate.get(isoDate));
        }
    }
    if (activeModelIds.includes('met_no') && metNoData) {
        addModelSource('met_no', metNoData.dailyByDate.get(isoDate), metNoData.hourlyByDate.get(isoDate));
    }

    if (!modelSourcesForDay.length && !ensQ && ![rawArchiveDay?.maxC, rawArchiveDay?.minC, rawArchiveDay?.weatherCode].some(v => toNum(v) !== null) && !rawArchiveDay?.hourlyRaw?.length) {
        return missingForecastDay(identity);
    }

    const compHours = companionData?.hourlyByDate?.get(isoDate) || null;
    const compDaily = companionData?.dailyByDate?.get(isoDate) || null;

    // ------------------------------------------------------------------------
    // Build real 24h hours[0..23] when hourly observations/forecasts exist
    // ------------------------------------------------------------------------
    const realHours = [];
    const reportsByHour = new Map();
    const precipByHour = new Map();
    let hoursWithHumidity = 0;
    const hasAnyHourly = modelSourcesForDay.some((m) => m.hourlyMap?.size) || rawArchiveDay?.hourlyRaw?.length;

    if ((hasAnyHourly || compHours?.size) && zone !== 'subseasonal') {
        const archiveHourLookup = new Map();
        if (Array.isArray(rawArchiveDay?.hourlyRaw)) {
            for (const hr of rawArchiveDay.hourlyRaw) {
                const hIdx = toNum(hr?.hour);
                if (hIdx !== null) archiveHourLookup.set(clamp(Math.round(hIdx), 0, 23), hr);
            }
        }

        for (let h = 0; h < 24; h++) {
            const isDayHour = h >= 8 && h < 20;
            const tempEntries = [];
            const humEntries = [];
            const dewEntries = [];
            const precipEntries = [];
            const probEntries = [];
            const cloudEntries = [];
            const windSamples = [];
            const pMslEntries = [];
            const pSurfEntries = [];
            const soilEntries = [];
            const weatherReports = [];
            const isNightHour = h < astronomy.sunriseHour || h > astronomy.sunsetHour;

            for (const ms of modelSourcesForDay) {
                const hr = ms.hourlyMap?.get(h);
                if (!hr) continue;
                const mosM = mos?.models?.[ms.modelId];
                const bias = mosM && mosM.samples >= 12 ? (isDayHour ? mosM.dayBiasC : mosM.nightBiasC) : 0;
                if (hr.tempC !== null) {
                    tempEntries.push({ value: hr.tempC - bias * damping, weight: ms.weight });
                }
                if (hr.humidity !== null) humEntries.push({ value: hr.humidity, weight: ms.weight });
                if (hr.dewPointC !== null) dewEntries.push({ value: hr.dewPointC, weight: ms.weight });
                if (hr.precipMm !== null) precipEntries.push({ value: hr.precipMm, weight: ms.weight });
                if (hr.precipProb !== null) probEntries.push({ value: hr.precipProb, weight: ms.weight });
                if (hr.cloudCoverPct !== null) cloudEntries.push({ value: hr.cloudCoverPct, weight: ms.weight });
                if (hr.pressureMslHpa !== null) pMslEntries.push({ value: hr.pressureMslHpa, weight: ms.weight });
                if (hr.surfacePressureHpa !== null) pSurfEntries.push({ value: hr.surfacePressureHpa, weight: ms.weight });
                if (hr.windMs !== null) {
                    windSamples.push({
                        speedMs: hr.windMs,
                        gustMs: hr.gustMs ?? hr.windMs * 1.6,
                        dirDeg: hr.windDeg ?? null,
                        weight: ms.weight
                    });
                }
                const weather = hr.weather || reportedWeather(hr.weatherCode, ms.modelId, hr.tempC, isNightHour);
                if (weather) weatherReports.push({ weather, weight: ms.weight });
            }

            const aHr = archiveHourLookup.get(h);
            if (aHr) {
                if (toNum(aHr.tempC) !== null) tempEntries.push({ value: toNum(aHr.tempC), weight: 1.0 });
                if (toNum(aHr.humidity) !== null) humEntries.push({ value: toNum(aHr.humidity), weight: 1.0 });
                if (toNum(aHr.dewPointC) !== null) dewEntries.push({ value: toNum(aHr.dewPointC), weight: 1.0 });
                if (toNum(aHr.precipMm) !== null) precipEntries.push({ value: toNum(aHr.precipMm), weight: 1.0 });
                if (toNum(aHr.cloudCoverPct) !== null) cloudEntries.push({ value: toNum(aHr.cloudCoverPct), weight: 1.0 });
                if (toNum(aHr.pressureMslHpa) !== null) pMslEntries.push({ value: toNum(aHr.pressureMslHpa), weight: 1.0 });
                if (toNum(aHr.surfacePressureHpa) !== null) pSurfEntries.push({ value: toNum(aHr.surfacePressureHpa), weight: 1.0 });
                if (toNum(aHr.soil0C) !== null) soilEntries.push({ value: toNum(aHr.soil0C), weight: 1.0 });
                if (toNum(aHr.windMs) !== null) {
                    windSamples.push({
                        speedMs: toNum(aHr.windMs),
                        gustMs: toNum(aHr.gustMs) ?? toNum(aHr.windMs) * 1.6,
                        dirDeg: toNum(aHr.windDeg),
                        weight: 1.0
                    });
                }
                const weather = !aHr.weatherCodeFromDay && reportedWeather(aHr.weatherCode, 'Архив', aHr.tempC, isNightHour);
                if (weather) weatherReports.push({ weather, weight: 1 });
            }

            const cHr = compHours?.get(h);
            if (cHr) {
                if (cHr.precipProb !== null) probEntries.push({ value: cHr.precipProb, weight: 1.0 });
                if (cHr.pressureMslHpa !== null && !pMslEntries.length) pMslEntries.push({ value: cHr.pressureMslHpa, weight: 0.8 });
                if (cHr.surfacePressureHpa !== null && !pSurfEntries.length) pSurfEntries.push({ value: cHr.surfacePressureHpa, weight: 0.8 });
                if (cHr.soil0C !== null) soilEntries.push({ value: cHr.soil0C, weight: 1.0 });
            }

            const weather = chooseWeather(weatherReports.sort((a, b) => b.weight - a.weight).map(r => r.weather));
            if (weather) reportsByHour.set(h, weather);
            const mm = weightedMean(precipEntries);
            const prob = weightedMean(probEntries);
            const precipMm = mm === null ? null : +Math.max(0, mm).toFixed(2);
            const precipProb = prob === null ? null : Math.round(clamp(prob, 0, 100));
            precipByHour.set(h, { precipMm, precipProb });
            const rawTemp = weightedTrimmedMean(tempEntries);
            if (rawTemp === null) continue;

            const tempC = +rawTemp.toFixed(1);
            // 72 % is only a working value for the wet-bulb / phase maths of this hour;
            // the day is flagged as "humidity estimated" unless some hour had a real reading.
            if (humEntries.length) hoursWithHumidity++;
            const humidity = Math.round(clamp(weightedMean(humEntries) ?? 72, 10, 100));
            const dewPointC = +(weightedMean(dewEntries) ?? (tempC - (100 - humidity) / 5)).toFixed(1);
            const cloudCoverPct = Math.round(clamp(weightedMean(cloudEntries) ?? 50, 0, 100));
            const wind = blendWindVectors(windSamples);
            const soil0C = +(weightedMean(soilEntries) ?? (tempC * 0.45)).toFixed(1);
            const pObj = resolvePressure(weightedMean(pSurfEntries), weightedMean(pMslEntries), tempC);

            const wetBulbC = computeWetBulbC(tempC, humidity);
            const feelsC = computeApparentTempC(tempC, wind.windMs, humidity);
            const phaseObj = classifyPrecipPhase(tempC, humidity, precipMm, soil0C);
            const inferredCode = precipMm > 0.2 ? (phaseObj.phase === 'snow' ? 71 : 61) : cloudCoverPct > 75 ? 3 : cloudCoverPct > 35 ? 2 : 0;
            const wMeta = weather || wmoCodeToWeather(inferredCode, tempC, isNightHour);

            realHours.push({
                hour: h,
                hourStr: `${String(h).padStart(2, '0')}:00`,
                tempC,
                tempF: cToF(tempC),
                feelsC,
                wetBulbC,
                dewPointC,
                humidity,
                precipMm,
                precipProb,
                precipPhase: precipMm === null ? null : phaseObj.phase,
                windMs: wind.windMs,
                windMph: wind.windMph,
                gustMs: wind.gustMs,
                windDirShort: wind.windDirShort,
                pressureStationMm: pObj.stationMm,
                pressureMslMm: pObj.mslMm,
                pressureStationHpa: pObj.stationHpa,
                pressureMslHpa: pObj.mslHpa,
                cloudCoverPct,
                soil0C,
                weather,
                iconType: weather ? weather.icon : precipMm > 0 && phaseObj.phase === 'freezing_rain' ? 'freezing-rain' : precipMm > 0 && phaseObj.phase === 'sleet' ? 'sleet' : wMeta.icon
            });
        }
    }

    // Fill missing hours in a sparse realHours set using physical interpolation
    let hoursByIdx = new Map(realHours.map((hr) => [hr.hour, hr]));
    if (realHours.length > 0 && realHours.length < 24) {
        for (let h = 0; h < 24; h++) {
            if (hoursByIdx.has(h)) continue;
            // Nearest available hour fallback
            let nearest = realHours[0];
            let bestDist = 99;
            for (const candidate of realHours) {
                const dist = Math.abs(candidate.hour - h);
                if (dist < bestDist) {
                    bestDist = dist;
                    nearest = candidate;
                }
            }
            hoursByIdx.set(h, {
                ...nearest,
                weather: null,
                iconType: UNKNOWN_CONDITION.icon,
                precipMm: null,
                precipProb: null,
                precipPhase: null,
                hour: h,
                hourStr: `${String(h).padStart(2, '0')}:00`,
                isSynthetic: true
            });
        }
    }
    const sortedRealHours = hoursByIdx.size === 24 ? Array.from({ length: 24 }, (_, h) => hoursByIdx.get(h)) : [];

    // ------------------------------------------------------------------------
    // Aggregate Daily Extremes & Zone Blending
    // ------------------------------------------------------------------------
    const maxEntries = [];
    const minEntries = [];
    const precipEntries = [];
    const windDaySamples = [];
    const rawMaxVals = [];
    const rawMinVals = [];

    for (const ms of modelSourcesForDay) {
        const d = ms.dailyRec;
        const mosM = mos?.models?.[ms.modelId];
        const dayBias = mosM && mosM.samples >= 12 ? mosM.dayBiasC : 0;
        const nightBias = mosM && mosM.samples >= 12 ? mosM.nightBiasC : 0;

        let mMax = d?.maxC ?? null;
        let mMin = d?.minC ?? null;
        if ((mMax === null || mMin === null) && ms.hourlyMap?.size) {
            const ts = [...ms.hourlyMap.values()].map((x) => x.tempC).filter((v) => v !== null);
            if (ts.length) {
                if (mMax === null) mMax = Math.max(...ts);
                if (mMin === null) mMin = Math.min(...ts);
            }
        }
        if (mMax !== null) {
            maxEntries.push({ value: mMax - dayBias * damping, weight: ms.weight });
            rawMaxVals.push(mMax - dayBias * damping);
        }
        if (mMin !== null) {
            minEntries.push({ value: mMin - nightBias * damping, weight: ms.weight });
            rawMinVals.push(mMin - nightBias * damping);
        }
        if (d?.precipMm !== null && d?.precipMm !== undefined) {
            precipEntries.push({ value: d.precipMm, weight: ms.weight });
        }
        if (d?.windMs !== null && d?.windMs !== undefined) {
            windDaySamples.push({
                speedMs: d.windMs,
                gustMs: d.gustMs ?? d.windMs * 1.65,
                dirDeg: d.windDeg ?? null,
                weight: ms.weight
            });
        }
    }

    if (rawArchiveDay) {
        if (toNum(rawArchiveDay.maxC) !== null) maxEntries.push({ value: toNum(rawArchiveDay.maxC), weight: 1.0 });
        if (toNum(rawArchiveDay.minC) !== null) minEntries.push({ value: toNum(rawArchiveDay.minC), weight: 1.0 });
        if (toNum(rawArchiveDay.precipMm) !== null) precipEntries.push({ value: toNum(rawArchiveDay.precipMm), weight: 1.0 });
        if (toNum(rawArchiveDay.windMs) !== null) {
            windDaySamples.push({
                speedMs: toNum(rawArchiveDay.windMs),
                gustMs: toNum(rawArchiveDay.gustMs) ?? toNum(rawArchiveDay.windMs) * 1.6,
                dirDeg: toNum(rawArchiveDay.windDeg),
                weight: 1.0
            });
        }
    }

    let detMaxC = weightedTrimmedMean(maxEntries);
    let detMinC = weightedTrimmedMean(minEntries);
    if (detMaxC === null && sortedRealHours.length) {
        detMaxC = Math.max(...sortedRealHours.map((h) => h.tempC));
    }
    if (detMinC === null && sortedRealHours.length) {
        detMinC = Math.min(...sortedRealHours.map((h) => h.tempC));
    }

    let maxC;
    let minC;
    let maxQ;
    let minQ;
    let precipMm;
    let precipP75Mm;
    let windObj;

    if (zone === 'subseasonal') {
        const t = clamp((offsetFromToday - 16) / 18, 0, 1);
        const alpha = 0.82 - t * (0.82 - 0.38); // 0.82 -> 0.38
        const rawP50Max = toNum(ensQ?.maxP50C) ?? detMaxC;
        const rawP50Min = toNum(ensQ?.minP50C) ?? detMinC;

        maxC = rawP50Max === null ? null : +(alpha * rawP50Max + (1 - alpha) * clim.climMaxC).toFixed(1);
        minC = rawP50Min === null ? null : +(alpha * rawP50Min + (1 - alpha) * clim.climMinC).toFixed(1);
        if (minC !== null && maxC !== null && minC > maxC) {
            const mid = +((maxC + minC) / 2).toFixed(1);
            maxC = +(mid + 0.5).toFixed(1);
            minC = +(mid - 0.5).toFixed(1);
        }

        const regQ = (qVal, climBase, climOffset) => {
            const v = toNum(qVal);
            if (v === null) return null;
            return +(alpha * v + (1 - alpha) * (climBase + climOffset)).toFixed(1);
        };
        const halfSpread = 2.8 + t * 2.2;
        maxQ = enforceQuantiles(
            maxC,
            regQ(ensQ?.maxP10C, clim.climMaxC, -4.5),
            regQ(ensQ?.maxP25C, clim.climMaxC, -2.2),
            regQ(ensQ?.maxP75C, clim.climMaxC, 2.2),
            regQ(ensQ?.maxP90C, clim.climMaxC, 4.5),
            halfSpread
        );
        minQ = enforceQuantiles(
            minC,
            regQ(ensQ?.minP10C, clim.climMinC, -5.0),
            regQ(ensQ?.minP25C, clim.climMinC, -2.5),
            regQ(ensQ?.minP75C, clim.climMinC, 2.5),
            regQ(ensQ?.minP90C, clim.climMinC, 5.0),
            halfSpread + 0.5
        );

        const rawPrecip = toNum(ensQ?.precipP50Mm) ?? weightedMean(precipEntries);
        precipMm = rawPrecip === null ? null : +(Math.max(0, alpha * rawPrecip + (1 - alpha) * clim.climPrecipMm)).toFixed(1);
        precipP75Mm = precipMm === null ? toNum(ensQ?.precipP75Mm) : +(Math.max(precipMm, toNum(ensQ?.precipP75Mm) ?? precipMm * 1.6)).toFixed(1);
        windObj = windDaySamples.length ? blendWindVectors(windDaySamples) : ensembleWind(ensQ);
    } else if (zone === 'extended_ensemble') {
        const t = clamp((offsetFromToday - 10) / 5, 0, 1);
        const wDet = 0.65 - 0.25 * t; // 0.65 -> 0.40 deterministic 16d weight
        const ensMax = toNum(ensQ?.maxP50C);
        const ensMin = toNum(ensQ?.minP50C);

        if (detMaxC !== null && ensMax !== null) {
            maxC = +(wDet * detMaxC + (1 - wDet) * ensMax).toFixed(1);
        } else {
            maxC = roundOne(detMaxC ?? ensMax);
        }
        if (detMinC !== null && ensMin !== null) {
            minC = +(wDet * detMinC + (1 - wDet) * ensMin).toFixed(1);
        } else {
            minC = roundOne(detMinC ?? ensMin);
        }
        if (minC !== null && maxC !== null && minC > maxC) {
            const mid = +((maxC + minC) / 2).toFixed(1);
            maxC = +(mid + 0.5).toFixed(1);
            minC = +(mid - 0.5).toFixed(1);
        }

        const halfSpread = 2.0 + t * 1.2;
        maxQ = enforceQuantiles(maxC, ensQ?.maxP10C, ensQ?.maxP25C, ensQ?.maxP75C, ensQ?.maxP90C, halfSpread);
        minQ = enforceQuantiles(minC, ensQ?.minP10C, ensQ?.minP25C, ensQ?.minP75C, ensQ?.minP90C, halfSpread + 0.3);

        const detPrecip = weightedMean(precipEntries);
        const ensPrecip = toNum(ensQ?.precipP50Mm);
        const blendedPrecip = detPrecip !== null && ensPrecip !== null ? wDet * detPrecip + (1 - wDet) * ensPrecip : detPrecip ?? ensPrecip;
        precipMm = blendedPrecip === null ? null : +Math.max(0, blendedPrecip).toFixed(2);
        precipP75Mm = precipMm === null ? toNum(ensQ?.precipP75Mm) : +(Math.max(precipMm, toNum(ensQ?.precipP75Mm) ?? precipMm * 1.5)).toFixed(1);
        windObj = windDaySamples.length ? blendWindVectors(windDaySamples) : ensembleWind(ensQ);
    } else {
        // Archive or Deterministic (0..9)
        maxC = roundOne(detMaxC ?? ensQ?.maxP50C);
        minC = roundOne(detMinC ?? ensQ?.minP50C);
        if (minC !== null && maxC !== null && minC > maxC) {
            const mid = +((maxC + minC) / 2).toFixed(1);
            maxC = +(mid + 0.5).toFixed(1);
            minC = +(mid - 0.5).toFixed(1);
        }

        // Keep quantiles consistent with multi-model spread or ensemble quantiles
        const modelMaxSorted = rawMaxVals.length >= 2 ? [...rawMaxVals].sort((a, b) => a - b) : [];
        const modelMinSorted = rawMinVals.length >= 2 ? [...rawMinVals].sort((a, b) => a - b) : [];
        const fallbackSpread = isArchive ? 0.2 : +(0.6 + Math.max(0, offsetFromToday) * 0.14).toFixed(1);
        maxQ = enforceQuantiles(
            maxC,
            ensQ?.maxP10C ?? (modelMaxSorted.length ? modelMaxSorted[0] : null),
            ensQ?.maxP25C ?? (modelMaxSorted.length ? quantileSorted(modelMaxSorted, 0.25) : null),
            ensQ?.maxP75C ?? (modelMaxSorted.length ? quantileSorted(modelMaxSorted, 0.75) : null),
            ensQ?.maxP90C ?? (modelMaxSorted.length ? modelMaxSorted[modelMaxSorted.length - 1] : null),
            fallbackSpread
        );
        minQ = enforceQuantiles(
            minC,
            ensQ?.minP10C ?? (modelMinSorted.length ? modelMinSorted[0] : null),
            ensQ?.minP25C ?? (modelMinSorted.length ? quantileSorted(modelMinSorted, 0.25) : null),
            ensQ?.minP75C ?? (modelMinSorted.length ? quantileSorted(modelMinSorted, 0.75) : null),
            ensQ?.minP90C ?? (modelMinSorted.length ? modelMinSorted[modelMinSorted.length - 1] : null),
            fallbackSpread
        );

        const hourSumPrecip = precipByHour.size === 24 ? completePrecipSum([...precipByHour.values()]) : null;
        const dailyPrecipMean = weightedMean(precipEntries);
        const dailyTotal = dailyPrecipMean ?? hourSumPrecip ?? toNum(ensQ?.precipP50Mm);
        precipMm = dailyTotal === null ? null : +Math.max(0, dailyTotal).toFixed(2);
        precipP75Mm = precipMm === null ? toNum(ensQ?.precipP75Mm) : +(Math.max(precipMm, toNum(ensQ?.precipP75Mm) ?? (isArchive ? precipMm : precipMm * 1.3))).toFixed(1);

        if (windDaySamples.length) {
            windObj = blendWindVectors(windDaySamples);
        } else if (realHours.some(h => Number.isFinite(h.windMs))) {
            // Hour slots keep a compass label, not degrees: speed blends, bearing stays unknown
            windObj = blendWindVectors(realHours.map((h) => ({ speedMs: h.windMs, gustMs: h.gustMs, dirDeg: null, weight: 1 })));
        } else {
            windObj = ensembleWind(ensQ);
        }
    }

    const dayMeanC = maxC === null || minC === null ? null : roundOne((maxC + minC) / 2);

    // Extract companion soil, snow depth, humidity, pressure, cloud cover
    const avgArr = (arr) => {
        const vals = arr.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
        return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
    };

    const compHourVals = compHours ? [...compHours.values()] : [];

    // Snow depth: modelled value when the archive / companion channel delivered one, otherwise the
    // climatological normal — explicitly flagged, never a silent "0 cm" in the middle of winter.
    const compSnowVals = compHourVals.map((c) => c.snowDepthCm).filter((v) => v !== null && v !== undefined);
    const modelledSnowCm =
        toNum(rawArchiveDay?.snowDepthCm) ?? (compSnowVals.length ? Math.max(0, ...compSnowVals) : null);
    const snowEstimated = modelledSnowCm === null;
    const snowDepthCm = modelledSnowCm ?? clim.climSnowDepthCm;

    // Soil profile: same honesty rule — without archive / companion data the values below are an
    // air-temperature heuristic and every consumer (UI, field-ops cards) must be able to tell.
    const modelledSoil0C = toNum(rawArchiveDay?.soil0C) ?? avgArr(compHourVals.map((c) => c.soil0C));
    const soilEstimated = modelledSoil0C === null && dayMeanC !== null;

    const soil0C =
        modelledSoil0C ??
        (dayMeanC === null ? null : roundOne(dayMeanC * 0.84));
    const soil6C =
        toNum(rawArchiveDay?.soil6C) ??
        avgArr(compHourVals.map((c) => c.soil6C)) ??
        (soil0C === null ? null : +(soil0C * 0.86 + 0.3).toFixed(1));
    const soil18C =
        toNum(rawArchiveDay?.soil18C) ??
        avgArr(compHourVals.map((c) => c.soil18C)) ??
        (soil6C === null ? null : +(soil6C * 0.8 + 0.7).toFixed(1));
    const soil54C =
        toNum(rawArchiveDay?.soil54C) ??
        avgArr(compHourVals.map((c) => c.soil54C)) ??
        (soil18C === null ? null : +(soil18C * 0.7 + 1.5).toFixed(1));

    // Humidity / dew point: without archive, hourly or Google data the numbers come from a formula.
    // They still feed the precipitation-phase logic, but are flagged so charts do not plot them as data.
    const modelledHumidity =
        toNum(rawArchiveDay?.humidity) ??
        (sortedRealHours.length && hoursWithHumidity > 0 ? avgArr(sortedRealHours.map((h) => h.humidity)) : null) ??
        toNum(googleData?.dailyByDate?.get(isoDate)?.humidity);
    const humidityEstimated = modelledHumidity === null;
    const humidity = Math.round(
        clamp(
            modelledHumidity ?? 74 - (maxC - minC) * 1.1 + Math.min(18, precipMm * 3),
            25,
            98
        )
    );
    const dewPointC =
        toNum(rawArchiveDay?.dewPointC) ??
        (sortedRealHours.length ? avgArr(sortedRealHours.map((h) => h.dewPointC)) : null) ??
        (dayMeanC === null ? null : roundOne(dayMeanC - (100 - humidity) / 5));

    const cloudCoverPct = Math.round(
        clamp(
            toNum(rawArchiveDay?.cloudCoverPct) ??
                (sortedRealHours.length ? avgArr(sortedRealHours.map((h) => h.cloudCoverPct)) : null) ??
                toNum(googleData?.dailyByDate?.get(isoDate)?.cloudCoverPct) ??
                (precipMm > 0.5 ? 78 : 42),
            0,
            100
        )
    );

    const avgHourSurf = sortedRealHours.length ? avgArr(sortedRealHours.map((h) => h.pressureStationHpa)) : null;
    const avgHourMsl = sortedRealHours.length ? avgArr(sortedRealHours.map((h) => h.pressureMslHpa)) : null;
    const compSurf = avgArr(compHourVals.map((c) => c.surfacePressureHpa));
    const compMsl = avgArr(compHourVals.map((c) => c.pressureMslHpa));

    // All-null beyond the modelled range (days 17–35, daily-only archive): no pressure is invented
    const pObj = resolvePressure(
        toNum(rawArchiveDay?.surfacePressureHpa) ?? avgHourSurf ?? compSurf,
        toNum(rawArchiveDay?.pressureMslHpa) ?? avgHourMsl ?? compMsl,
        (maxC + minC) / 2
    );

    const uv = Math.round(
        clamp(
            toNum(compDaily?.uv) ??
                toNum(googleData?.dailyByDate?.get(isoDate)?.uv) ??
                Math.max(0, Math.round((astronomy.daylightHours - 6) * 0.45)),
            0,
            11
        )
    );

    const dayPhase = classifyPrecipPhase(maxC, humidity, precipMm > 0 ? precipMm : null, soil0C);
    const nightPhase = classifyPrecipPhase(minC, Math.min(98, humidity + 8), precipMm > 0 ? precipMm : null, soil0C);
    const meanPhase = classifyPrecipPhase(dayMeanC, humidity, precipMm, soil0C);

    let rainMm = 0;
    let snowMm = 0;
    if (sortedRealHours.length) {
        for (const hr of sortedRealHours) {
            if (hr.precipPhase === 'snow') snowMm += hr.precipMm;
            else if (hr.precipPhase === 'sleet') {
                snowMm += hr.precipMm * 0.5;
                rainMm += hr.precipMm * 0.5;
            } else if (hr.precipMm > 0) {
                rainMm += hr.precipMm;
            }
        }
        const sumH = rainMm + snowMm;
        if (sumH > 0 && precipMm > 0) {
            rainMm = +((rainMm / sumH) * precipMm).toFixed(1);
            snowMm = +(Math.max(0, precipMm - rainMm)).toFixed(1);
        } else {
            rainMm = meanPhase.phase === 'rain' || meanPhase.phase === 'freezing_rain' ? precipMm : 0;
            snowMm = meanPhase.phase === 'snow' || meanPhase.phase === 'sleet' ? precipMm : 0;
        }
    } else if (rawArchiveDay && toNum(rawArchiveDay.rainMm) !== null) {
        rainMm = +(Math.min(precipMm, toNum(rawArchiveDay.rainMm))).toFixed(1);
        snowMm = +(Math.max(0, precipMm - rainMm)).toFixed(1);
    } else {
        if (meanPhase.potentialPhase === 'snow') {
            snowMm = precipMm;
        } else if (meanPhase.potentialPhase === 'sleet') {
            snowMm = +(precipMm * 0.6).toFixed(1);
            rainMm = +(precipMm * 0.4).toFixed(1);
        } else {
            rainMm = precipMm;
        }
    }

    const reportedProb = (night) => {
        const probs = [...precipByHour].filter(([h, p]) => (h < 8 || h >= 20) === night && p.precipProb !== null);
        return probs.length ? Math.max(...probs.map(([, p]) => p.precipProb)) : null;
    };
    // A provider's following night can extend past midnight. Only a calendar-day maximum covers this date.
    const dailyPrecipProbability = toNum(compDaily?.precipProbMax);
    const precipDay = toNum(googleData?.dailyByDate?.get(isoDate)?.precipDay) ?? toNum(compDaily?.precipProbMax) ?? reportedProb(false);
    const precipNight = toNum(googleData?.dailyByDate?.get(isoDate)?.precipNight) ?? reportedProb(true);

    const gDaily = googleData?.dailyByDate?.get(isoDate);
    const weightedSources = [...modelSourcesForDay].sort((a, b) => b.weight - a.weight);
    const dailyWeather = (night) => {
        const t = night ? minC : maxC;
        const google = night ? gDaily?.nightWeather : gDaily?.dayWeather;
        const dailyReports = [
            reportedWeather(rawArchiveDay?.weatherCode, 'Архив', t, night),
            ...weightedSources.map(m => reportedWeather(m.dailyRec?.weatherCode, m.modelId, t, night))
        ];
        const hourlyStorms = [...reportsByHour].filter(([h, w]) => (h < 8 || h >= 20) === night && stormPriority(w)).map(([, w]) => w);
        // Daily WMO is the worst condition in 24 hours. It has no night-time stamp.
        const eligibleDaily = night ? dailyReports.filter(w => !stormPriority(w)) : dailyReports;
        const reported = chooseWeather([google, ...hourlyStorms, ...eligibleDaily]);
        if (reported && stormPriority(reported) && dailyReports.includes(reported)) {
            return { ...reported, dailyOnly: true };
        }
        if (reported) return reported;
        if (night && dailyReports.some(stormPriority)) return UNKNOWN_CONDITION;
        // The appropriate shift may extend into tomorrow. Infer from its total after dates are joined.
        return { ...UNKNOWN_CONDITION, estimateFromPeriod: true };
    };
    const wDay = dailyWeather(false);
    const wNight = dailyWeather(true);

    const hours =
        sortedRealHours.length === 24
            ? sortedRealHours
            : dayMeanC === null
            ? Array.from({ length: 24 }, (_, hour) => ({ hour, hourStr: `${String(hour).padStart(2, '0')}:00`, tempC: null, isSynthetic: true }))
            : buildSyntheticHours({
                  maxC,
                  minC,
                  humidity,
                  windMs: windObj.windMs,
                  gustMs: windObj.gustMs,
                  windDeg: windObj.windDeg,
                  pressureStationMm: pObj.stationMm,
                  pressureMslMm: pObj.mslMm,
                  cloudCoverPct,
                  soil0C,
                  astronomy,
                  // A daily maximum code does not place a thunderstorm in a specific hour.
                  dayIcon: UNKNOWN_CONDITION.icon,
                  nightIcon: UNKNOWN_CONDITION.icon
              });

    for (const slot of hours) {
        if (slot.isSynthetic) {
            const reading = precipByHour.get(slot.hour);
            slot.precipMm = reading?.precipMm ?? null;
            slot.precipProb = reading?.precipProb ?? null;
            slot.precipPhase = slot.precipMm === null || slot.tempC == null ? null : classifyPrecipPhase(slot.tempC, slot.humidity, slot.precipMm, slot.soil0C).phase;
        }
        slot.precipInterval = precipInterval(localHourStart(isoDate, slot.hour), 1, slot.precipMm);
        const reported = reportsByHour.get(slot.hour);
        if (slot.isSynthetic && reported) {
            slot.weather = reported;
            slot.iconType = reported.icon;
        }
    }
    const nightHours = hours.filter((h) => h.hour >= 20 || h.hour <= 7);
    const nightCloud = nightHours.length ? avgArr(nightHours.map((h) => h.cloudCoverPct)) : cloudCoverPct;
    const nightWind = nightHours.length ? avgArr(nightHours.map((h) => h.windMs)) : windObj.windMs;
    const inversion = detectBasinInversion({
        nightMinC: minC,
        cloudCoverPct: nightCloud ?? cloudCoverPct,
        nightWindMs: nightWind ?? windObj.windMs,
        snowDepthCm
    });

    const minSigma = Math.max(0.8, (minQ.p90 - minQ.p10) / 2.56);
    const probFrostBelowMinus20 = minC === null ? null :
        toNum(ensQ?.probBelowMinus20) ?? Math.round(clamp(normCdf((-20 - minC) / minSigma) * 100, 0, 100));
    const probSnowOver5mm = precipMm === null || dayMeanC === null ? null :
        meanPhase.potentialPhase === 'rain' && maxC > 3
            ? 0
            : (toNum(ensQ?.probPrecipOver5) ?? Math.round(clamp(snowMm >= 5 ? 75 : snowMm * 12, 0, 100)));

    // The blended point forecast can fall outside the members' interval. Keep the
    // reported percentiles intact; the calculated spread is a separate estimate.
    const hasMembers = ensQ && (ensQ.temperatureMemberCount ?? ensQ.memberCount ?? Infinity) >= 2 &&
        TEMP_QUANTILE_FIELDS.every(key => Number.isFinite(ensQ[key]));
    const temperatureRange = hasMembers
        ? { kind: 'ensemble', sources: Array.isArray(ensQ.sources) ? ensQ.sources : [] }
        : { kind: 'estimate' };

    return {
        ...identity,
        hasForecast: true,
        precipTimeBasis: 'interval-start',
        precipBlocks: [...(metNoData?.precipBlocks || []), ...(googleData?.precipBlocks || [])]
            .filter(b => localParts(b.startMs).isoDate === isoDate),
        confidencePct: null,
        temperatureRange,
        dayCond: weatherLabel(wDay),
        dayConditionIsDaily: Boolean(wDay.dailyOnly),
        dayCondEn: wDay.en,
        nightCond: inversion.active && minC < 0 ? `${weatherLabel(wNight)} (выхолаживание)` : weatherLabel(wNight),
        nightCondEn: wNight.en,
        iconType: wDay.icon,
        nightIconType: wNight.icon,
        maxC,
        maxF: cToF(maxC),
        minC,
        minF: cToF(minC),
        maxP10C: hasMembers ? ensQ.maxP10C : maxQ.p10,
        maxP25C: hasMembers ? ensQ.maxP25C : maxQ.p25,
        maxP75C: hasMembers ? ensQ.maxP75C : maxQ.p75,
        maxP90C: hasMembers ? ensQ.maxP90C : maxQ.p90,
        minP10C: hasMembers ? ensQ.minP10C : minQ.p10,
        minP25C: hasMembers ? ensQ.minP25C : minQ.p25,
        minP75C: hasMembers ? ensQ.minP75C : minQ.p75,
        minP90C: hasMembers ? ensQ.minP90C : minQ.p90,
        climMaxC: clim.climMaxC,
        climMinC: clim.climMinC,
        climAnomalyC: dayMeanC === null ? null : roundOne(dayMeanC - clim.climMeanC),
        humidity,
        uv,
        dailyPrecipProbability,
        precipDay,
        precipNight,
        precipDayType: dayPhase.potentialShortRu,
        precipNightType: nightPhase.potentialShortRu,
        precipMm,
        precipP75Mm,
        rainMm: dayMeanC === null ? toNum(rawArchiveDay?.rainMm) : rainMm,
        snowMm: dayMeanC === null ? null : snowMm,
        snowDepthCm: +Number(snowDepthCm).toFixed(1),
        precipPhase: precipMm === null || dayMeanC === null ? null : meanPhase.phase,
        windMs: windObj.windMs,
        windMph: windObj.windMph,
        gustMs: windObj.gustMs,
        gustMph: windObj.gustMph,
        windDirShort: windObj.windDirShort,
        windDirFull: windObj.windDirFull,
        windDeg: windObj.windDeg,
        soil0C: roundOne(soil0C),
        soil6C: roundOne(soil6C),
        soil18C: roundOne(soil18C),
        soil54C: roundOne(soil54C),
        soilTempC: roundOne(soil0C),
        dewPointC: roundOne(dewPointC),
        cloudCoverPct,
        pressureStationHpa: pObj.stationHpa,
        pressureStationMm: pObj.stationMm,
        pressureMslHpa: pObj.mslHpa,
        pressureMslMm: pObj.mslMm,
        deltaP24hMm: 0,
        astronomy,
        inversion,
        nextNightMinC: minC,
        nextNightMinF: cToF(minC),
        nextNightMaxC: dayMeanC,
        nextNightMaxF: cToF(dayMeanC),
        nextNightPrecipProb: precipNight,
        nextNightPrecipMm: null,
        nextNightPrecipType: nightPhase.potentialShortRu,
        nextNightWindMs: windObj.windMs,
        nextNightGustMs: windObj.gustMs,
        nextNightWindDirShort: windObj.windDirShort,
        nextNightCond: weatherLabel(wNight),
        nightPeriodWeather: gDaily?.nightWeather || null,
        nextNightIconType: wNight.icon,
        probFrostBelowMinus20,
        probSnowOver5mm,
        dataQuality: {
            estimateDayCondition: Boolean(wDay.estimateFromPeriod),
            estimateNightCondition: Boolean(wNight.estimateFromPeriod),
            roadRiskInputsAvailable: zone !== 'subseasonal' && (modelSourcesForDay.some(coversRoadRisk) || rawArchiveDay?.roadRiskInputsAvailable === true),
            soilEstimated,
            snowEstimated,
            humidityEstimated,
            hasPressure: pObj.stationMm !== null,
            hasWindDirection: windObj.windDeg !== null,
            ensembleBacked: Boolean(ensQ)
        },
        modelBreakdown,
        hours
    };
}

function conditionFromPeriod(mm, temp, humidity, cloud, soil, night) {
    if (mm === null || temp == null) return UNKNOWN_CONDITION;
    const phase = classifyPrecipPhase(temp, humidity, mm, soil);
    const code = mm >= 1.5 ? (phase.potentialPhase === 'snow' ? 71 : 61) : cloud > 75 ? 3 : cloud > 35 ? 2 : 0;
    return wmoCodeToWeather(code, temp, night);
}

function finalizeDaysSequence(days, todayIso) {
    const sorted = [...days].sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    for (let i = 0; i < sorted.length; i++) {
        const d = sorted[i];
        d.idx = i;
        d.offsetFromToday = diffDaysIso(d.isoDate, todayIso);
        if (d.hasForecast === false) continue;
        const isConsecutivePrev = i > 0 && diffDaysIso(d.isoDate, sorted[i - 1].isoDate) === 1;
        // null (not 0, and never a jump against a default value) when either day lacks pressure
        d.deltaP24hMm = isConsecutivePrev ? diffOrNull(d.pressureStationMm, sorted[i - 1].pressureStationMm) : null;

        // True overnight: 20:00 of day d .. 08:00 of day d+1
        const nextDay = sorted[i + 1] && diffDaysIso(sorted[i + 1].isoDate, d.isoDate) === 1 ? sorted[i + 1] : null;
        const evening = (d.hours || []).filter((h) => h.hour >= SHIFT_END);
        const morning = (nextDay?.hours || []).filter((h) => h.hour < SHIFT_START);
        const shiftHours = SHIFT_END - SHIFT_START;
        const nightHours = 24 - shiftHours;
        const intervals = [d, nextDay].flatMap(day => [
            ...(Array.isArray(day?.precipBlocks) ? day.precipBlocks : []), ...(day?.hours || []).map(h => h.precipInterval)
        ]);
        d.dayShiftPrecip = sumPrecipIntervals(intervals, localHourStart(d.isoDate, SHIFT_START), shiftHours);
        d.nextNightPrecip = sumPrecipIntervals(intervals, localHourStart(d.isoDate, SHIFT_END), nightHours);
        d.nextNightPrecipMm = d.nextNightPrecip.mm;
        if (d.precipMm == null && d.precipTimeBasis === 'interval-start') {
            d.precipMm = sumPrecipIntervals(intervals, localHourStart(d.isoDate, 0), 24).mm;
        }
        if (d.dataQuality?.estimateDayCondition) {
            const condition = conditionFromPeriod(d.dayShiftPrecip.mm, d.maxC, d.humidity, d.cloudCoverPct, d.soil0C, false);
            d.dayCond = condition.ru;
            d.dayCondEn = condition.en;
            d.iconType = condition.icon;
        }
        if (d.dataQuality?.estimateNightCondition) {
            const condition = conditionFromPeriod(d.nextNightPrecip.mm, d.minC, d.humidity, d.cloudCoverPct, d.soil0C, true);
            d.nightCond = condition.ru;
            d.nightCondEn = condition.en;
            d.nightIconType = condition.icon;
        }
        const overnight = [...evening, ...morning];
        d.nextNightComplete = overnight.length === nightHours && overnight.every(h => Number.isFinite(h.tempC));
        if (overnight.length) {
            const temps = overnight.map((h) => h.tempC);
            const nMin = +Math.min(...temps).toFixed(1);
            const nMax = +Math.max(...temps).toFixed(1);
            const nPrecipSum = d.nextNightPrecip.mm;
            const nProb = overnight.length === nightHours && overnight.every(h => Number.isFinite(h.precipProb)) ? Math.max(...overnight.map(h => h.precipProb)) : null;
            const nHum = Math.round(overnight.reduce((s, h) => s + (h.humidity || 75), 0) / overnight.length);
            const nSoil = +(overnight.reduce((s, h) => s + (h.soil0C ?? d.soil0C), 0) / overnight.length).toFixed(1);
            const nWind = blendWindVectors(overnight.map((h) => ({ speedMs: h.windMs, gustMs: h.gustMs, dirDeg: d.windDeg, weight: 1 })));
            const nPhase = classifyPrecipPhase(nMin, nHum, nPrecipSum > 0 ? nPrecipSum : null, nSoil);

            d.nextNightMinC = d.nextNightComplete ? nMin : null;
            d.nextNightMinF = d.nextNightComplete ? cToF(nMin) : null;
            d.nextNightMaxC = d.nextNightComplete ? nMax : null;
            d.nextNightMaxF = d.nextNightComplete ? cToF(nMax) : null;
            d.nextNightPrecipProb = nProb;
            d.nextNightPrecipType = nPhase.potentialShortRu;
            d.nextNightWindMs = nWind.windMs;
            d.nextNightGustMs = nWind.gustMs;
            d.nextNightWindDirShort = nWind.windDirShort;
            // The upcoming night uses this evening and tomorrow morning, never
            // a thunderstorm that already passed at 03:00 on the selected date.
            const nightReport = chooseWeather([
                d.nightPeriodWeather,
                ...evening.map(h => h.weather),
                ...(nextDay?.hours || []).filter(h => h.hour < 8).map(h => h.weather)
            ]);
            if (stormPriority(nightReport) || stormPriority({ icon: d.nightIconType })) {
                d.nextNightCond = weatherLabel(nightReport || UNKNOWN_CONDITION);
                d.nextNightIconType = nightReport?.icon || UNKNOWN_CONDITION.icon;
            } else {
                d.nextNightCond = d.nightCond;
                d.nextNightIconType = d.nightIconType;
            }
        }
    }
    return sorted;
}

// ============================================================================
// 2. BUILD UNIFIED DATASET v4
// ============================================================================
export function buildUnifiedDataset(rawBundle = {}, options = {}) {
    const mode = rawBundle.mode || 'hybrid';
    const preferredOmModel = rawBundle.preferredOmModel || 'multi';
    const latencyMs = Math.round(toNum(rawBundle.latencyMs) ?? 0);

    const mos = rawBundle.previousRuns
        ? computeRollingMos(rawBundle.previousRuns)
        : (options.mosCache || { models: {}, bestModelId: null, summaryRu: 'MOS: калибровка по прошлым прогонам недоступна' });

    const omModelsData = mode === 'google_wn3' ? {} : parseOpenMeteoMulti(rawBundle.openMeteoMulti);
    const companionData = parseOpenMeteoCompanion(rawBundle.openMeteoCompanion);
    const googleData = mode === 'open_meteo' ? { hourlyByDate: new Map(), dailyByDate: new Map(), current: null } : parseGoogleWeather(rawBundle.google);
    const metNoData = mode === 'open_meteo' || mode === 'google_wn3' ? { hourlyByDate: new Map(), dailyByDate: new Map() } : parseMetNo(rawBundle.metNo);
    const ensMap = mode === 'google_wn3' ? new Map() : parseEnsemble35(rawBundle.ensemble35);

    const activeModels = [];
    if (mode !== 'open_meteo' && (googleData.dailyByDate.size || googleData.hourlyByDate.size || googleData.current)) {
        activeModels.push('google_wn3');
    }
    for (const omId of OM_MODELS) {
        if (omModelsData[omId]) activeModels.push(omId);
    }
    if (mode === 'hybrid' && (metNoData.dailyByDate.size || metNoData.hourlyByDate.size)) {
        activeModels.push('met_no');
    }

    // Resolve "today" in Asia/Krasnoyarsk (UTC+7)
    const receivedMs = Date.parse(rawBundle.fetchedAtIso);
    const receivedAtIso = new Date(Number.isFinite(receivedMs) ? receivedMs : Date.now()).toISOString();
    const abanNow = formatAbanTimestamp(receivedAtIso);
    const todayIso = options.todayIso || abanNow.isoDate;
    const currentHour = abanNow.hour;

    // Collect all dates across active sources
    const dateSet = new Set();
    for (const m of Object.values(omModelsData)) {
        for (const d of m.dailyByDate.keys()) dateSet.add(d);
        for (const [date, hours] of m.hourlyByDate) {
            // The first midnight accumulation may precede the requested forecast range.
            if ([...hours.values()].some(h => h.tempC !== null || h.weatherCode !== null)) dateSet.add(date);
        }
    }
    for (const d of googleData.dailyByDate.keys()) dateSet.add(d);
    for (const d of googleData.hourlyByDate.keys()) dateSet.add(d);
    for (const d of metNoData.hourlyByDate.keys()) dateSet.add(d);
    for (const d of metNoData.dailyByDate.keys()) dateSet.add(d);
    for (const d of ensMap.keys()) dateSet.add(d);

    const archiveMap = new Map();
    const rawArchiveList = Array.isArray(rawBundle.customArchive)
        ? rawBundle.customArchive
        : Array.isArray(rawBundle.customArchive?.days)
        ? rawBundle.customArchive.days
        : [];
    for (const a of rawArchiveList) {
        if (!a?.isoDate) continue;
        const iso = String(a.isoDate).slice(0, 10);
        archiveMap.set(iso, a);
        dateSet.add(iso);
    }

    // Keep forecast dates selectable even when a provider returns only part of its horizon.
    const horizon = ensMap.size ? 35 : Object.keys(omModelsData).length ? 16 :
        googleData.dailyByDate.size || googleData.hourlyByDate.size || metNoData.hourlyByDate.size ? 10 : 0;
    for (let off = 0; off < horizon; off++) dateSet.add(addDaysIso(todayIso, off));

    const sortedDates = [...dateSet].sort();
    const rawDays = sortedDates.map((isoDate) =>
        buildZoneDayRecord({
            isoDate,
            offsetFromToday: diffDaysIso(isoDate, todayIso),
            activeModelIds: activeModels,
            mode,
            preferredOmModel,
            omModelsData,
            companionData,
            googleData,
            metNoData,
            ensQ: ensMap.get(isoDate) || null,
            mos,
            rawArchiveDay: archiveMap.get(isoDate) || null
        })
    );

    const days = finalizeDaysSequence(rawDays, todayIso);
    const todayIdx = days.findIndex((d) => d.isoDate === todayIso);
    const todayDay = days[todayIdx] || null;
    const tomorrowDay = days.find(d => d.isoDate === addDaysIso(todayIso, 1));
    const yesterdayDay = todayIdx > 0 ? days[todayIdx - 1] : null;
    const todaySlot = todayDay?.hours?.[currentHour] || todayDay?.hours?.[12] || null;

    // ------------------------------------------------------------------------
    // Air Quality
    // ------------------------------------------------------------------------
    const aqCur = rawBundle.airQuality?.current;
    let airQuality;
    if (aqCur && (toNum(aqCur.pm2_5) !== null || toNum(aqCur.european_aqi) !== null)) {
        const pm25 = roundOne(aqCur.pm2_5);
        const pm10 = roundOne(aqCur.pm10);
        const co = roundOne(aqCur.carbon_monoxide);
        const aqi = toNum(aqCur.european_aqi) === null ? null : Math.round(aqCur.european_aqi);
        let statusRu = aqi === null ? 'Индекс не указан' : 'Отличный';
        let smogRisk = aqi === null ? 'unknown' : 'low';
        if (aqi > 80 || pm25 >= 50) {
            statusRu = 'Плохой (смог)';
            smogRisk = 'high';
        } else if (aqi > 60 || pm25 >= 25 || (todayDay?.inversion?.active && pm25 >= 18)) {
            statusRu = 'Повышенный (дымка)';
            smogRisk = 'moderate';
        } else if (aqi > 40) {
            statusRu = 'Умеренный';
        } else if (aqi > 20) {
            statusRu = 'Хороший';
        }
        airQuality = { pm25, pm10, co, aqi, statusRu, smogRisk };
    } else {
        airQuality = { pm25: null, pm10: null, co: null, aqi: null, statusRu: 'Нет данных AQ', smogRisk: 'unknown' };
    }

    // ------------------------------------------------------------------------
    // Current Conditions
    // ------------------------------------------------------------------------
    const gCur = mode !== 'open_meteo' ? googleData.current : null;
    const omCur = mode !== 'google_wn3' ? rawBundle.openMeteoMulti?.current : null;
    const compCur = rawBundle.openMeteoCompanion?.current;
    const curTempEntries = [];
    const curWindSamples = [];
    const curHumEntries = [];
    const curMslEntries = [];
    const curSurfEntries = [];

    if (gCur && toNum(gCur.temperature?.degrees) !== null) {
        const gw = MODEL_META.google_wn3.weights.short48h * (mos?.models?.google_wn3?.weightMultiplier ?? 1);
        curTempEntries.push({ value: toNum(gCur.temperature.degrees), weight: gw });
        if (toNum(gCur.relativeHumidity) !== null) curHumEntries.push({ value: toNum(gCur.relativeHumidity), weight: gw });
        if (toNum(gCur.airPressure?.meanSeaLevelMillibars) !== null) curMslEntries.push({ value: toNum(gCur.airPressure.meanSeaLevelMillibars), weight: gw });
        const gWs = parseGoogleSpeedMs(gCur.wind?.speed);
        if (gWs !== null) {
            curWindSamples.push({
                speedMs: gWs,
                gustMs: parseGoogleSpeedMs(gCur.wind?.gust) ?? gWs * 1.6,
                dirDeg: toNum(gCur.wind?.direction?.degrees),
                weight: gw
            });
        }
    }
    if (omCur && toNum(omCur.temperature_2m) !== null) {
        curTempEntries.push({ value: toNum(omCur.temperature_2m), weight: 0.45 });
        if (toNum(omCur.relative_humidity_2m) !== null) curHumEntries.push({ value: toNum(omCur.relative_humidity_2m), weight: 0.45 });
        if (toNum(omCur.pressure_msl) !== null) curMslEntries.push({ value: toNum(omCur.pressure_msl), weight: 0.45 });
        if (toNum(omCur.surface_pressure) !== null) curSurfEntries.push({ value: toNum(omCur.surface_pressure), weight: 0.45 });
        if (toNum(omCur.wind_speed_10m) !== null) {
            curWindSamples.push({
                speedMs: toNum(omCur.wind_speed_10m),
                gustMs: toNum(omCur.wind_gusts_10m) ?? toNum(omCur.wind_speed_10m) * 1.6,
                dirDeg: toNum(omCur.wind_direction_10m),
                weight: 0.45
            });
        }
    }
    if (compCur && toNum(compCur.surface_pressure) !== null && !curSurfEntries.length) {
        curSurfEntries.push({ value: toNum(compCur.surface_pressure), weight: 0.4 });
    }
    if (!curTempEntries.length && Number.isFinite(todaySlot?.tempC)) {
        curTempEntries.push({ value: todaySlot.tempC, weight: 1 });
        curHumEntries.push({ value: todaySlot.humidity, weight: 1 });
        curWindSamples.push({ speedMs: todaySlot.windMs, gustMs: todaySlot.gustMs, dirDeg: todayDay?.windDeg ?? null, weight: 1 });
    }

    const curTempC = roundOne(weightedMean(curTempEntries) ?? todaySlot?.tempC);
    const curWind = curWindSamples.length ? blendWindVectors(curWindSamples) : {
        windMs: todaySlot?.windMs ?? null, windMph: todaySlot?.windMph ?? null,
        gustMs: todaySlot?.gustMs ?? null, gustMph: msToMph(todaySlot?.gustMs ?? null),
        windDeg: todayDay?.windDeg ?? null, windDirShort: todayDay?.windDirShort ?? NO_DIRECTION.s
    };
    const curHumidity = Math.round(clamp(weightedMean(curHumEntries) ?? todaySlot?.humidity ?? 70, 10, 100));
    const curWetBulbC = computeWetBulbC(curTempC, curHumidity);
    const curFeelsC = computeApparentTempC(curTempC, curWind.windMs, curHumidity);
    const curDewPointC = roundOne(todaySlot?.dewPointC ?? (curTempC === null ? null : curTempC - (100 - curHumidity) / 5));
    const curSoil0C = roundOne(todaySlot?.soil0C ?? todayDay?.soil0C);
    // Current observations can cover different intervals. Keep one source and its label together.
    let curPrecipMm = todaySlot?.precipMm ?? null;
    let curPrecipProb = todaySlot?.precipProb ?? null;
    let precipPeriodLabel = `Осадки ${hourRangeLabel(currentHour)}`;
    if (toNum(gCur?.precipitation?.qpf?.quantity) !== null) {
        curPrecipMm = toNum(gCur.precipitation.qpf.quantity);
        curPrecipProb = toNum(gCur.precipitation.probability?.percent);
        precipPeriodLabel = 'Осадки за последний час';
    } else if (toNum(omCur?.precipitation) !== null && toNum(omCur.interval) > 0) {
        curPrecipMm = toNum(omCur.precipitation);
        curPrecipProb = null;
        precipPeriodLabel = `Осадки за последние ${omCur.interval / 60} мин`;
    }
    const curPhaseObj = classifyPrecipPhase(curTempC, curHumidity, curPrecipMm, curSoil0C);
    const curPress = resolvePressure(
        weightedMean(curSurfEntries) ?? todaySlot?.pressureStationHpa,
        weightedMean(curMslEntries) ?? todaySlot?.pressureMslHpa,
        curTempC
    );

    // Pressure tendencies (3h & 24h): null when the reference hour is missing — never "0 mm"
    let p3hAgoMm = null;
    if (todayDay?.hours?.length) {
        if (currentHour >= 3) {
            p3hAgoMm = todayDay.hours[currentHour - 3]?.pressureStationMm ?? null;
        } else if (yesterdayDay?.hours?.length) {
            p3hAgoMm = yesterdayDay.hours[24 + currentHour - 3]?.pressureStationMm ?? null;
        }
    }
    const p24hAgoMm = yesterdayDay?.hours?.[currentHour]?.pressureStationMm ?? yesterdayDay?.pressureStationMm ?? null;

    const isCurNight = todayDay?.astronomy ? (currentHour < todayDay.astronomy.sunriseHour || currentHour > todayDay.astronomy.sunsetHour) : false;
    const curMeta = chooseWeather([
        gCur?.weatherCondition ? { ...googleCondToMeta(gCur.weatherCondition, curTempC, isCurNight), source: 'google_wn3' } : null,
        reportedWeather(omCur?.weather_code, 'Open-Meteo', curTempC, isCurNight),
        todayDay?.isoDate === todayIso && todaySlot?.hour === currentHour ? todaySlot.weather : null
    ]) || UNKNOWN_CONDITION;

    // A provider may still return yesterday's observation after local midnight.
    // Label the oldest contributing reading; keep the retrieval time on the dataset.
    const readingTimes = [
        toNum(omCur?.temperature_2m) !== null ? weatherTimeMs(omCur.time) : NaN,
        toNum(gCur?.temperature?.degrees) !== null ? weatherTimeMs(gCur.currentTime) : NaN
    ].filter(Number.isFinite);
    const estimateAtIso = readingTimes.length ? new Date(Math.min(...readingTimes)).toISOString() : receivedAtIso;
    const current = {
        estimateAtIso,
        hasMeasurements: curTempEntries.length > 0,
        tempC: curTempC,
        tempF: cToF(curTempC),
        feelsC: curFeelsC,
        feelsF: cToF(curFeelsC),
        wetBulbC: curWetBulbC,
        condRu: weatherLabel(curMeta),
        iconType: curMeta.icon,
        windMs: curWind.windMs,
        windMph: curWind.windMph,
        gustMs: curWind.gustMs,
        gustMph: curWind.gustMph,
        windDeg: curWind.windDeg,
        windDirShort: curWind.windDirShort,
        precipPeriodLabel,
        precipProb: curPrecipProb,
        precipMm: curPrecipMm,
        precipPhase: curPrecipMm === null ? null : curPhaseObj.phase,
        snowDepthCm: todayDay?.snowDepthCm ?? 0,
        snowEstimated: Boolean(todayDay?.dataQuality?.snowEstimated),
        soilEstimated: Boolean(todayDay?.dataQuality?.soilEstimated),
        humidity: curHumidity,
        dewPointC: curDewPointC,
        cloudCoverPct: Math.round(toNum(gCur?.cloudCover) ?? todaySlot?.cloudCoverPct ?? todayDay?.cloudCoverPct ?? 40),
        soil0C: curSoil0C,
        soil6C: todayDay?.soil6C ?? curSoil0C,
        soil18C: todayDay?.soil18C ?? curSoil0C,
        soil54C: todayDay?.soil54C ?? curSoil0C,
        pressureStationHpa: curPress.stationHpa,
        pressureStationMm: curPress.stationMm,
        pressureMslHpa: curPress.mslHpa,
        pressureMslMm: curPress.mslMm,
        deltaP3hMm: diffOrNull(curPress.stationMm, p3hAgoMm),
        deltaP24hMm: diffOrNull(curPress.stationMm, p24hAgoMm),
        uv: Math.round(toNum(gCur?.uvIndex) ?? todayDay?.uv ?? 0),
        obsTimeLabel: `п. Абан • ${formatAbanTimestamp(estimateAtIso).label}`
    };

    // ------------------------------------------------------------------------
    // Dynamic Control Milestone (+3h & nearest 08:00 / 20:00 shift)
    // ------------------------------------------------------------------------
    let targetHour;
    let targetDay = todayDay;
    let targetSuffix = '';
    if (currentHour < 8) {
        targetHour = 8;
    } else if (currentHour < 20) {
        targetHour = 20;
    } else {
        targetHour = 8;
        targetDay = tomorrowDay;
        targetSuffix = ' (завтра)';
    }
    const shiftSlot = targetDay?.hours?.[targetHour];
    const h3Raw = currentHour + 3;
    const h3Hour = h3Raw % 24;
    const h3Day = h3Raw >= 24 ? tomorrowDay : todayDay;
    const h3Slot = h3Day?.hours?.[h3Hour];

    const shiftDate = currentHour >= 20 ? addDaysIso(todayIso, 1) : todayIso;
    const shiftMeta = (targetDay?.isoDate === shiftDate && targetDay.hours?.[targetHour]?.weather) || UNKNOWN_CONDITION;

    const controlPoint = {
        targetLabel: `Смена ${String(targetHour).padStart(2, '0')}:00${targetSuffix}`,
        tempC: shiftSlot?.tempC ?? null,
        tempF: shiftSlot ? cToF(shiftSlot.tempC) : null,
        feelsC: shiftSlot?.feelsC ?? null,
        condRu: shiftSlot ? weatherLabel(shiftMeta) : 'Нет прогноза',
        badgeRu: shiftMeta === UNKNOWN_CONDITION ? 'Нет данных' : shiftMeta.ru.split(' ')[0],
        iconType: shiftMeta.icon,
        precipProb: shiftSlot?.precipProb ?? null,
        windMs: shiftSlot?.windMs ?? null,
        windMph: shiftSlot?.windMph ?? null,
        windDirShort: shiftSlot?.windDirShort ?? null,
        soil0C: shiftSlot?.soil0C ?? null,
        next3hLabel: `Через 3 ч (${String(h3Hour).padStart(2, '0')}:00)`,
        next3hTempC: h3Slot?.tempC ?? null
    };

    const sourceType =
        mode === 'google_wn3'
            ? 'live_google_wn3'
            : mode === 'open_meteo'
            ? 'live_open_meteo'
            : activeModels.includes('google_wn3')
            ? 'live_super_ensemble'
            : 'live_multi_ensemble';

    const forecastDayCount = days.filter(d => !d.isArchive && d.hasForecast).length;
    const sourceLabel =
        mode === 'google_wn3'
            ? 'WeatherNext 3 Live (Абан)'
            : !activeModels.length && ensMap.size
            ? `Ансамбль Open-Meteo · дней с прогнозом: ${forecastDayCount}`
            : mode === 'open_meteo'
            ? `Open-Meteo ${forecastDayCount}д (${preferredOmModel})`
            : `Супер-Ансамбль (${activeModels.length} мод. • ${forecastDayCount}д)`;

    return {
        version: 4,
        sourceType,
        sourceLabel,
        syncedAt: abanNow.label,
        receivedAtIso,
        latencyMs,
        isPartial: Boolean(rawBundle.isPartial),
        activeModels,
        channels: rawBundle.channels || {},
        errors: rawBundle.errors || {},
        mos,
        airQuality,
        current,
        controlPoint,
        days
    };
}

// ============================================================================
// 3. MERGE CUSTOM HISTORICAL ARCHIVE RANGES (ERA5-Land + Recent)
// ============================================================================
export function mergeArchiveDaysIntoDataset(dataset, archiveInput) {
    if (!dataset || !Array.isArray(dataset.days)) return dataset;

    const rawList = Array.isArray(archiveInput)
        ? archiveInput
        : Array.isArray(archiveInput?.days)
        ? archiveInput.days
        : [];
    if (!rawList.length) return dataset;

    const existingToday = dataset.days.find((d) => d.offsetFromToday === 0) || dataset.days.find((d) => !d.isArchive) || dataset.days[0];
    const todayIso = existingToday?.isoDate || formatAbanTimestamp().isoDate;

    const byIso = new Map(dataset.days.map((d) => [d.isoDate, d]));

    for (const raw of rawList) {
        if (!raw?.isoDate || raw.hasForecast === false) continue;
        const isoDate = String(raw.isoDate).slice(0, 10);
        const existing = byIso.get(isoDate);
        // Never overwrite deterministic/ensemble forecast days with archive
        if (existing && !existing.isArchive && existing.offsetFromToday >= 0) continue;

        // If already canonical archive DayRecord, preserve/update safely
        if (raw.version === 4 || (raw.zone === 'archive' && Array.isArray(raw.hours) && raw.hours.length === 24 && raw.astronomy)) {
            byIso.set(isoDate, { ...raw, id: `day_${isoDate}`, zone: 'archive', isArchive: true, confidencePct: null });
            continue;
        }

        const normalized = buildZoneDayRecord({
            isoDate,
            offsetFromToday: Math.min(-1, diffDaysIso(isoDate, todayIso)),
            activeModelIds: [],
            mode: 'archive',
            preferredOmModel: null,
            omModelsData: {},
            companionData: null,
            googleData: null,
            metNoData: null,
            ensQ: null,
            mos: null,
            rawArchiveDay: raw
        });
        normalized.zone = 'archive';
        normalized.isArchive = true;
        normalized.confidencePct = null;
        normalized.label = diffDaysIso(isoDate, todayIso) === -1 ? 'Вчера (Архив)' : 'Архив';

        byIso.set(isoDate, normalized);
    }

    const mergedDays = finalizeDaysSequence([...byIso.values()], todayIso);
    return {
        ...dataset,
        days: mergedDays
    };
}

// ============================================================================
// 4. TIME-WINDOW STATS & 5-DAY PENTAD SUMMARIES
// ============================================================================
function completePrecipSum(hours) {
    return hours.length && hours.every(h => Number.isFinite(h.precipMm))
        ? +hours.reduce((sum, h) => sum + h.precipMm, 0).toFixed(2) : null;
}

export function computeDayWindowStats(day, timeWindowKey = 'full') {
    const winCfg = TIME_WINDOWS[timeWindowKey] || TIME_WINDOWS.full;
    const hours = Array.isArray(day?.hours) ? day.hours : [];
    const activeHours = hours.filter(h => winCfg.isHourActive(h.hour, day));
    if (!activeHours.length) {
        return {
            hours,
            activeHours,
            avgC: null,
            avgF: null,
            minC: null,
            maxC: null,
            avgWindMs: null,
            maxGustMs: null,
            maxPrecipProb: null,
            sumPrecipMm: null
        };
    }

    const available = key => activeHours.map(h => toNum(h[key])).filter(Number.isFinite);
    const average = values => values.length ? +(values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(1) : null;
    const temps = available('tempC');
    const avgC = average(temps);
    const minC = temps.length ? Math.min(...temps) : null;
    const maxC = temps.length ? Math.max(...temps) : null;
    const avgWindMs = average(available('windMs'));
    const gusts = available('gustMs');
    const maxGustMs = gusts.length ? Math.max(...gusts) : null;
    const probabilities = activeHours.map(h => h.precipProb).filter(Number.isFinite);
    const maxPrecipProb = timeWindowKey === 'night' ? day.nextNightPrecipProb ?? null :
        probabilities.length ? Math.max(...probabilities) : null;
    const sumPrecipMm = timeWindowKey === 'night' ? day.nextNightPrecip?.mm ?? null :
        timeWindowKey === 'day_shift' ? day.dayShiftPrecip?.mm ?? null : completePrecipSum(activeHours);

    return {
        hours,
        activeHours,
        avgC,
        avgF: cToF(avgC),
        minC,
        maxC,
        avgWindMs,
        maxGustMs,
        maxPrecipProb,
        sumPrecipMm
    };
}

export function hasDryWindow(day) {
    if (!Number.isFinite(day.precipMm) || day.precipMm >= 0.5) return false;
    if (Number.isFinite(day.dailyPrecipProbability)) return day.dailyPrecipProbability < 15;
    const hours = new Map((day.hours || []).map(slot => [slot.hour, slot]));
    for (let hour = 0; hour < 24; hour++) {
        const slot = hours.get(hour);
        if (!slot || !(Number.isFinite(slot.precipProb) ? slot.precipProb < 15 : slot.precipMm === 0)) return false;
    }
    return true;
}

export function buildPentadSummary(days) {
    if (!Array.isArray(days) || !days.length) return [];
    const pentads = [];
    for (let i = 0; i < days.length; i += 5) {
        const chunk = days.slice(i, i + 5).filter(d => d.hasForecast !== false);
        if (!chunk.length) continue;
        const n = chunk.length;
        const first = chunk[0];
        const last = chunk[n - 1];
        const avg = (fn) => +(chunk.reduce((s, d) => s + (toNum(fn(d)) ?? 0), 0) / n).toFixed(1);
        // Mean over the days that actually carry the value; null when none do (nothing is invented)
        const avgAvailable = (fn, decimals = 1) => {
            const vals = chunk.map((d) => toNum(fn(d))).filter((v) => v !== null);
            return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(decimals) : null;
        };

        const maxC = avgAvailable(d => d.maxC);
        const minC = avgAvailable(d => d.minC);
        const extreme = (field, fn) => {
            const values = chunk.map(d => d[field]).filter(Number.isFinite);
            return values.length ? fn(...values) : null;
        };
        const absMaxC = extreme('maxC', Math.max);
        const absMinC = extreme('minC', Math.min);
        const meanC = maxC === null || minC === null ? null : roundOne((maxC + minC) / 2);

        const wind = blendWindVectors(
            chunk.map((d) => ({ speedMs: d.windMs, gustMs: d.gustMs, dirDeg: d.windDeg ?? null, weight: 1 }))
        );
        const complete = chunk.length === Math.min(5, days.length - i);
        const completeSum = field => complete && chunk.every(d => Number.isFinite(d[field]))
            ? +chunk.reduce((sum, d) => sum + d[field], 0).toFixed(2) : null;
        const precipMm = completeSum('precipMm');
        const precipP75Mm = completeSum('precipP75Mm');
        const snowMm = completeSum('snowMm');
        const rainMm = completeSum('rainMm');

        const startDay = first.dateStr.split(' ')[0];
        const endParts = last.dateStr.split(' ');
        const label = n === 1
            ? first.dateStr
            : first.dateStr.split(' ')[1] === endParts[1]
            ? `${startDay}–${endParts[0]} ${endParts[1]}`
            : `${first.dateStr}–${last.dateStr}`;

        const ranges = Object.fromEntries(TEMP_QUANTILE_FIELDS.map(key => [
            key, chunk.every(d => Number.isFinite(d[key])) ? avg(d => d[key]) : null
        ]));
        const kinds = new Set(chunk.map(d => hasEnsembleRange(d) ? 'ensemble' : d.temperatureRange?.kind === 'estimate' ? 'estimate' : 'unknown'));
        const temperatureRange = kinds.size === 1 && kinds.has('ensemble')
            ? { kind: 'ensemble', sources: [...new Set(chunk.flatMap(d => d.temperatureRange.sources || []))] }
            : { kind: kinds.size === 1 ? [...kinds][0] : 'mixed' };

        const repZone = chunk[Math.floor(n / 2)].zone;

        // Sharpest day-to-day pressure change inside the period (signed). A first-to-last
        // difference over five days is not a 24-hour jump and must not be labelled as one.
        let peakDeltaP = null;
        for (const d of chunk) {
            const dp = toNum(d.deltaP24hMm);
            if (dp !== null && (peakDeltaP === null || Math.abs(dp) > Math.abs(peakDeltaP))) peakDeltaP = dp;
        }

        // Per-model mean Max / Min so the model lines survive pentad grouping
        const modelBreakdown = {};
        const modelIds = new Set();
        for (const d of chunk) {
            for (const k of Object.keys(d.modelBreakdown || {})) modelIds.add(k);
        }
        for (const mId of modelIds) {
            const mMax = avgAvailable((d) => d.modelBreakdown?.[mId]?.maxC);
            const mMin = avgAvailable((d) => d.modelBreakdown?.[mId]?.minC);
            if (mMax !== null || mMin !== null) modelBreakdown[mId] = { maxC: mMax, minC: mMin };
        }
        const meanPhase = classifyPrecipPhase(meanC, Math.round(avg((d) => d.humidity ?? 70)), precipMm, avgAvailable(d => d.soil0C));

        pentads.push({
            id: first.id,
            pentadId: `pentad_${first.isoDate}`,
            pentadIndex: pentads.length,
            startIso: first.isoDate,
            endIso: last.isoDate,
            isoDate: first.isoDate,
            dayCount: n,
            label,
            dateStr: label,
            dayShort: `${n}д`,
            zone: repZone,
            confidencePct: null,
            temperatureRange,
            maxC,
            maxF: cToF(maxC),
            minC,
            minF: cToF(minC),
            absMaxC,
            absMinC,
            meanC,
            ...ranges,
            climMaxC: avg((d) => d.climMaxC),
            climMinC: avg((d) => d.climMinC),
            climAnomalyC: avgAvailable(d => d.climAnomalyC),
            humidity: Math.round(avg((d) => d.humidity ?? 70)),
            precipMm,
            precipP75Mm,
            snowMm,
            rainMm,
            precipDay: complete && chunk.every(d => Number.isFinite(d.precipDay)) ? extreme('precipDay', Math.max) : null,
            precipDayType: meanC === null || precipMm === null ? null : meanPhase.potentialShortRu,
            precipPhase: precipMm === null || meanC === null ? null : meanPhase.phase,
            snowDepthCm: +Math.max(...chunk.map((d) => d.snowDepthCm ?? 0)).toFixed(1),
            windMs: wind.windMs,
            windMph: wind.windMph,
            gustMs: extreme('gustMs', Math.max),
            gustMph: msToMph(extreme('gustMs', Math.max)),
            windDeg: wind.windDeg,
            windDirShort: wind.windDirShort,
            soil0C: avgAvailable(d => d.soil0C),
            soil6C: avgAvailable(d => d.soil6C),
            soil18C: avgAvailable(d => d.soil18C),
            soil54C: avgAvailable(d => d.soil54C),
            dewPointC: avgAvailable(d => d.dewPointC),
            pressureStationMm: avgAvailable((d) => d.pressureStationMm, 0),
            pressureMslMm: avgAvailable((d) => d.pressureMslMm, 0),
            deltaP24hMm: peakDeltaP !== null ? Math.round(peakDeltaP) : null,
            dataQuality: {
                soilEstimated: chunk.some((d) => d.dataQuality?.soilEstimated),
                snowEstimated: chunk.some((d) => d.dataQuality?.snowEstimated),
                humidityEstimated: chunk.some((d) => d.dataQuality?.humidityEstimated),
                hasPressure: chunk.some((d) => toNum(d.pressureStationMm) !== null),
                hasWindDirection: wind.windDeg !== null,
                ensembleBacked: chunk.some((d) => d.dataQuality?.ensembleBacked !== false)
            },
            modelBreakdown,
            dayIds: chunk.map((d) => d.id)
        });
    }
    return pentads;
}
