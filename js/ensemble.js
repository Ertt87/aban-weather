// ============================================================================
// ABAN METEO v4 — MULTI-MODEL ENSEMBLE, ROLLING MOS & 35-DAY ENGINE
// ============================================================================
import { ABAN_COORDS, MODEL_META, TIME_WINDOWS, getAbanClimatology } from './config.js';
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
    detectBasinInversion
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

function wmoCodeToWeather(code, tempC = 0, isNight = false) {
    const c = toNum(code);
    if (c === 0) return { ru: isNight ? 'Ясно' : 'Ясно', en: 'Clear', icon: isNight ? 'clear-night' : 'sunny' };
    if (c === 1) return { ru: 'Преимущественно ясно', en: 'Mostly clear', icon: isNight ? 'partly-cloudy-night' : 'mostly-sunny' };
    if (c === 2) return { ru: 'Малооблачно', en: 'Partly cloudy', icon: isNight ? 'partly-cloudy-night' : 'partly-sunny' };
    if (c === 3) return { ru: 'Пасмурно', en: 'Overcast', icon: isNight ? 'partly-cloudy-night' : 'cloudy' };
    if (c === 45 || c === 48) return { ru: 'Туман / дымка', en: 'Fog', icon: 'fog' };
    if (c === 56 || c === 57 || c === 66 || c === 67) {
        return { ru: 'Ледяной дождь / гололёд', en: 'Freezing rain', icon: 'freezing-rain' };
    }
    if ((c >= 51 && c <= 55) || (c >= 61 && c <= 65) || (c >= 80 && c <= 82) || c >= 95) {
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
    if (type.includes('FREEZING') || type.includes('ICE')) {
        return { icon: 'freezing-rain', ru: text || 'Ледяной дождь', en: type.toLowerCase() };
    }
    if (type.includes('SLEET') || type.includes('RAIN_AND_SNOW')) {
        return { icon: 'sleet', ru: text || 'Мокрый снег', en: type.toLowerCase() };
    }
    if (type.includes('SNOW') || type.includes('FLURRIES') || type.includes('BLIZZARD')) {
        return { icon: type.includes('CLOUDY') ? 'cloudy-snow' : 'snow', ru: text || 'Снег', en: type.toLowerCase() };
    }
    if (type.includes('RAIN') || type.includes('DRIZZLE') || type.includes('SHOWER') || type.includes('THUNDER')) {
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
        summaryRu: `MOS 14д: лидер ${bestMeta?.shortName || bestModelId} (MAE ${bestStats.maeC.toFixed(1)}°C, день ${bestStats.dayBiasC >= 0 ? '+' : ''}${bestStats.dayBiasC.toFixed(1)}°, ночь ${bestStats.nightBiasC >= 0 ? '+' : ''}${bestStats.nightBiasC.toFixed(1)}°)`
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
            if (tArr) {
                const appArr = hVar('apparent_temperature');
                const rhArr = hVar('relative_humidity_2m');
                const dewArr = hVar('dew_point_2m');
                const pArr = hVar('precipitation');
                const rArr = hVar('rain');
                const sArr = hVar('snowfall');
                const wmoArr = hVar('weather_code');
                const pmslArr = hVar('pressure_msl');
                const psurfArr = hVar('surface_pressure');
                const cldArr = hVar('cloud_cover');
                const wsArr = hVar('wind_speed_10m');
                const wdArr = hVar('wind_direction_10m');
                const wgArr = hVar('wind_gusts_10m');

                for (let i = 0; i < hourly.time.length; i++) {
                    const parts = utcIsoToAbanParts(hourly.time[i]);
                    if (!parts) continue;
                    const tempC = toNum(tArr[i]);
                    if (tempC === null) continue;
                    if (!hMap.has(parts.isoDate)) hMap.set(parts.isoDate, new Map());
                    hMap.get(parts.isoDate).set(parts.hour, {
                        tempC,
                        feelsC: toNum(appArr?.[i]),
                        humidity: toNum(rhArr?.[i]),
                        dewPointC: toNum(dewArr?.[i]),
                        precipMm: toNum(pArr?.[i]),
                        rainMm: toNum(rArr?.[i]),
                        snowfallCm: toNum(sArr?.[i]),
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
            if (maxArr && minArr) {
                const wmoArr = dVar('weather_code');
                const pArr = dVar('precipitation_sum');
                const rArr = dVar('rain_sum');
                const sArr = dVar('snowfall_sum');
                const wsArr = dVar('wind_speed_10m_max');
                const wgArr = dVar('wind_gusts_10m_max');
                const wdArr = dVar('wind_direction_10m_dominant');

                for (let i = 0; i < daily.time.length; i++) {
                    const isoDate = String(daily.time[i]).slice(0, 10);
                    const maxC = toNum(maxArr[i]);
                    const minC = toNum(minArr[i]);
                    if (maxC === null && minC === null) continue;
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
        for (let i = 0; i < h.time.length; i++) {
            const parts = utcIsoToAbanParts(h.time[i]);
            if (!parts) continue;
            if (!hourlyByDate.has(parts.isoDate)) hourlyByDate.set(parts.isoDate, new Map());
            hourlyByDate.get(parts.isoDate).set(parts.hour, {
                precipProb: toNum(h.precipitation_probability?.[i]),
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
    if (!google) return { hourlyByDate, dailyByDate, current: null };

    const ingestHours = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const gh of arr) {
            const isoStr = gh?.interval?.startTime || gh?.displayDateTime?.utcOffset || gh?.time;
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
            if (tempC === null) continue;
            if (!hourlyByDate.has(parts.isoDate)) hourlyByDate.set(parts.isoDate, new Map());
            const ws = parseGoogleSpeedMs(gh.wind?.speed);
            const wg = parseGoogleSpeedMs(gh.wind?.gust);
            const meta = googleCondToMeta(gh.weatherCondition, tempC, !gh.isDaytime);
            hourlyByDate.get(parts.isoDate).set(parts.hour, {
                tempC,
                feelsC: toNum(gh.feelsLikeTemperature?.degrees),
                humidity: toNum(gh.relativeHumidity),
                dewPointC: toNum(gh.dewPoint?.degrees),
                precipProb: toNum(gh.precipitation?.probability?.percent),
                precipMm: toNum(gh.precipitation?.qpf?.quantity),
                cloudCoverPct: toNum(gh.cloudCover),
                pressureMslHpa: toNum(gh.airPressure?.meanSeaLevelMillibars),
                windMs: ws,
                gustMs: wg,
                windDeg: toNum(gh.wind?.direction?.degrees),
                uv: toNum(gh.uvIndex),
                condRu: meta.ru,
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
            const qpfDay = toNum(dayF.precipitation?.qpf?.quantity) ?? 0;
            const qpfNight = toNum(nightF.precipitation?.qpf?.quantity) ?? 0;

            dailyByDate.set(isoDate, {
                maxC,
                minC,
                dayCond: dayMeta.ru,
                dayCondEn: dayMeta.en,
                nightCond: nightMeta.ru,
                nightCondEn: nightMeta.en,
                iconType: dayMeta.icon,
                nightIconType: nightMeta.icon,
                precipDay: toNum(dayF.precipitation?.probability?.percent),
                precipNight: toNum(nightF.precipitation?.probability?.percent),
                precipMm: +(qpfDay + qpfNight).toFixed(1),
                humidity: toNum(dayF.relativeHumidity ?? nightF.relativeHumidity),
                uv: toNum(dayF.uvIndex),
                windMs: parseGoogleSpeedMs(dayF.wind?.speed ?? nightF.wind?.speed),
                gustMs: parseGoogleSpeedMs(dayF.wind?.gust ?? nightF.wind?.gust),
                windDeg: toNum(dayF.wind?.direction?.degrees ?? nightF.wind?.direction?.degrees),
                cloudCoverPct: toNum(dayF.cloudCover)
            });
        }
    }

    return { hourlyByDate, dailyByDate, current: google.current || null };
}

function parseMetNo(metNo) {
    const hourlyByDate = new Map();
    const dailyByDate = new Map();
    const series = metNo?.properties?.timeseries;
    if (!Array.isArray(series)) return { hourlyByDate, dailyByDate };

    for (const item of series) {
        const parts = utcIsoToAbanParts(item.time);
        if (!parts) continue;
        const det = item.data?.instant?.details || {};
        const tempC = toNum(det.air_temperature);
        if (tempC === null) continue;
        const next1 = item.data?.next_1_hours?.details || {};
        const next6 = item.data?.next_6_hours?.details || {};
        const precipMm = toNum(next1.precipitation_amount) ?? (toNum(next6.precipitation_amount) !== null ? toNum(next6.precipitation_amount) / 6 : null);

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
            precipMm
        });
    }

    for (const [isoDate, hMap] of hourlyByDate.entries()) {
        if (hMap.size < 4) continue;
        const vals = [...hMap.values()];
        const temps = vals.map((v) => v.tempC);
        const winds = vals.map((v) => v.windMs).filter((v) => v !== null);
        const gusts = vals.map((v) => v.gustMs).filter((v) => v !== null);
        const precips = vals.map((v) => v.precipMm).filter((v) => v !== null);
        const wAvg = blendWindVectors(vals.filter((v) => v.windMs !== null).map((v) => ({ speedMs: v.windMs, gustMs: v.gustMs, dirDeg: v.windDeg ?? 0, weight: 1 })));
        dailyByDate.set(isoDate, {
            maxC: +Math.max(...temps).toFixed(1),
            minC: +Math.min(...temps).toFixed(1),
            precipMm: precips.length ? +precips.reduce((a, b) => a + b, 0).toFixed(1) : null,
            windMs: winds.length ? +Math.max(...winds).toFixed(1) : null,
            gustMs: gusts.length ? +Math.max(...gusts).toFixed(1) : null,
            windDeg: wAvg.windDeg
        });
    }

    return { hourlyByDate, dailyByDate };
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
            if (!row?.isoDate) continue;
            qMap.set(String(row.isoDate).slice(0, 10), row);
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

            if (!maxMembers.length && !minMembers.length) continue;

            const belowMinus20 = minMembers.length
                ? Math.round((minMembers.filter((v) => v <= -20).length / minMembers.length) * 100)
                : 0;
            const precipOver5 = pMembers.length
                ? Math.round((pMembers.filter((v) => v >= 5).length / pMembers.length) * 100)
                : 0;

            qMap.set(isoDate, {
                isoDate,
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
function buildSyntheticHours({ maxC, minC, humidity, precipMm, precipProb, windMs, gustMs, windDeg, pressureStationMm, pressureMslMm, cloudCoverPct, soil0C, astronomy, dayIcon, nightIcon }) {
    const comp = degToCompass(windDeg);
    const sr = astronomy?.sunriseHour ?? 7;
    const ss = astronomy?.sunsetHour ?? 18;
    const minHour = clamp(Math.round(sr - 0.5), 2, 9);

    return Array.from({ length: 24 }, (_, h) => {
        // Shift template minimum slightly toward local sunrise while preserving afternoon peak ~14:30
        const shiftedIdx = (h - (minHour - 5) + 24) % 24;
        const w = DEFAULT_DIURNAL[shiftedIdx];
        const tempC = +(minC + w * (maxC - minC)).toFixed(1);
        const hWind = +(windMs * (0.76 + 0.34 * w)).toFixed(1);
        const hGust = +Math.max(hWind, gustMs * (0.76 + 0.34 * w)).toFixed(1);
        const hHum = Math.round(clamp(humidity + (1 - w) * 12 - w * 10, 30, 98));
        const wetBulbC = computeWetBulbC(tempC, hHum);
        const feelsC = computeApparentTempC(tempC, hWind, hHum);
        const dewPointC = +(tempC - (100 - hHum) / 5).toFixed(1);
        const hSoil0 = +(soil0C + (w - 0.5) * 0.7).toFixed(1);
        const hPrecipMm = precipMm > 0 ? +(precipMm / 24).toFixed(2) : 0;
        const phaseObj = classifyPrecipPhase(tempC, hHum, hPrecipMm, hSoil0);
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
            precipMm: hPrecipMm,
            precipProb: Math.round(precipProb ?? (hPrecipMm > 0 ? 45 : 10)),
            precipPhase: phaseObj.phase,
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
    let confidencePct;
    if (offsetFromToday < 0) {
        zone = 'archive';
        confidencePct = 99;
    } else if (offsetFromToday <= 9) {
        zone = 'deterministic';
        confidencePct = Math.round(93 - (offsetFromToday * 15) / 9);
    } else if (offsetFromToday <= 15) {
        zone = 'extended_ensemble';
        confidencePct = Math.round(74 - ((offsetFromToday - 10) * 18) / 5);
    } else {
        zone = 'subseasonal';
        confidencePct = Math.round(Math.max(35, 52 - ((offsetFromToday - 16) * 17) / 18));
    }

    const isArchive = zone === 'archive';
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
                precipMm: +(dailyRec.precipMm ?? 0).toFixed(1),
                windMs: +(dailyRec.windMs ?? 0).toFixed(1)
            };
        } else if (hourlyMap && hourlyMap.size >= 6) {
            const temps = [...hourlyMap.values()].map((x) => x.tempC).filter((v) => v !== null);
            const winds = [...hourlyMap.values()].map((x) => x.windMs).filter((v) => v !== null);
            const precs = [...hourlyMap.values()].map((x) => x.precipMm).filter((v) => v !== null);
            if (temps.length) {
                modelBreakdown[modelId] = {
                    maxC: +Math.max(...temps).toFixed(1),
                    minC: +Math.min(...temps).toFixed(1),
                    precipMm: +(precs.length ? precs.reduce((a, b) => a + b, 0) : 0).toFixed(1),
                    windMs: +(winds.length ? Math.max(...winds) : 0).toFixed(1)
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

    const compHours = companionData?.hourlyByDate?.get(isoDate) || null;
    const compDaily = companionData?.dailyByDate?.get(isoDate) || null;

    // ------------------------------------------------------------------------
    // Build real 24h hours[0..23] when hourly observations/forecasts exist
    // ------------------------------------------------------------------------
    const realHours = [];
    const hasAnyHourly = modelSourcesForDay.some((m) => m.hourlyMap && m.hourlyMap.size >= 4) || (Array.isArray(rawArchiveDay?.hourlyRaw) && rawArchiveDay.hourlyRaw.length >= 6);

    if (hasAnyHourly && zone !== 'subseasonal') {
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
            const wmoCodes = [];

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
                        dirDeg: hr.windDeg ?? 250,
                        weight: ms.weight
                    });
                }
                if (hr.weatherCode !== null && hr.weatherCode !== undefined) wmoCodes.push({ code: hr.weatherCode, weight: ms.weight });
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
                        dirDeg: toNum(aHr.windDeg) ?? 250,
                        weight: 1.0
                    });
                }
                if (toNum(aHr.weatherCode) !== null) wmoCodes.push({ code: toNum(aHr.weatherCode), weight: 1.0 });
            }

            const cHr = compHours?.get(h);
            if (cHr) {
                if (cHr.precipProb !== null) probEntries.push({ value: cHr.precipProb, weight: 1.0 });
                if (cHr.pressureMslHpa !== null && !pMslEntries.length) pMslEntries.push({ value: cHr.pressureMslHpa, weight: 0.8 });
                if (cHr.surfacePressureHpa !== null && !pSurfEntries.length) pSurfEntries.push({ value: cHr.surfacePressureHpa, weight: 0.8 });
                if (cHr.soil0C !== null) soilEntries.push({ value: cHr.soil0C, weight: 1.0 });
            }

            const rawTemp = weightedTrimmedMean(tempEntries);
            if (rawTemp === null) continue;

            const tempC = +rawTemp.toFixed(1);
            const humidity = Math.round(clamp(weightedMean(humEntries) ?? 72, 10, 100));
            const dewPointC = +(weightedMean(dewEntries) ?? (tempC - (100 - humidity) / 5)).toFixed(1);
            const precipMm = +(Math.max(0, weightedMean(precipEntries) ?? 0)).toFixed(2);
            const precipProb = Math.round(clamp(weightedMean(probEntries) ?? (precipMm > 0.1 ? Math.min(95, 25 + precipMm * 20) : 5), 0, 100));
            const cloudCoverPct = Math.round(clamp(weightedMean(cloudEntries) ?? 50, 0, 100));
            const wind = blendWindVectors(windSamples);
            const soil0C = +(weightedMean(soilEntries) ?? (tempC * 0.45)).toFixed(1);
            const pObj = convertPressure({
                surfaceHpa: weightedMean(pSurfEntries),
                mslHpa: weightedMean(pMslEntries),
                tempC,
                elevM: ABAN_COORDS.elev
            });

            const wetBulbC = computeWetBulbC(tempC, humidity);
            const feelsC = computeApparentTempC(tempC, wind.windMs, humidity);
            const phaseObj = classifyPrecipPhase(tempC, humidity, precipMm, soil0C);
            const isNightHour = h < astronomy.sunriseHour || h > astronomy.sunsetHour;

            const topCode = wmoCodes.length
                ? wmoCodes.sort((a, b) => b.weight - a.weight)[0].code
                : (precipMm > 0.2 ? (phaseObj.phase === 'snow' ? 71 : 61) : cloudCoverPct > 75 ? 3 : cloudCoverPct > 35 ? 2 : 0);
            const wMeta = wmoCodeToWeather(topCode, tempC, isNightHour);

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
                precipPhase: phaseObj.phase,
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
                iconType: phaseObj.phase === 'freezing_rain' ? 'freezing-rain' : phaseObj.phase === 'sleet' ? 'sleet' : wMeta.icon
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
                dirDeg: d.windDeg ?? 250,
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
                dirDeg: toNum(rawArchiveDay.windDeg) ?? 250,
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
        const rawP50Max = toNum(ensQ?.maxP50C) ?? detMaxC ?? clim.climMaxC;
        const rawP50Min = toNum(ensQ?.minP50C) ?? detMinC ?? clim.climMinC;

        maxC = +(alpha * rawP50Max + (1 - alpha) * clim.climMaxC).toFixed(1);
        minC = +(alpha * rawP50Min + (1 - alpha) * clim.climMinC).toFixed(1);
        if (minC > maxC) {
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

        const rawPrecip = toNum(ensQ?.precipP50Mm) ?? clim.climPrecipMm;
        precipMm = +(Math.max(0, alpha * rawPrecip + (1 - alpha) * clim.climPrecipMm)).toFixed(1);
        precipP75Mm = +(Math.max(precipMm, toNum(ensQ?.precipP75Mm) ?? precipMm * 1.6)).toFixed(1);
        const wSpeed = +(toNum(ensQ?.windP50Ms) ?? 3.8).toFixed(1);
        const wGust = +(Math.max(wSpeed * 1.5, toNum(ensQ?.windP90Ms) ?? wSpeed * 1.8)).toFixed(1);
        const comp = degToCompass(250);
        windObj = {
            windMs: wSpeed,
            windMph: msToMph(wSpeed),
            gustMs: wGust,
            gustMph: msToMph(wGust),
            windDeg: 250,
            windDirShort: comp.s,
            windDirFull: comp.f
        };
    } else if (zone === 'extended_ensemble') {
        const t = clamp((offsetFromToday - 10) / 5, 0, 1);
        const wDet = 0.65 - 0.25 * t; // 0.65 -> 0.40 deterministic 16d weight
        const ensMax = toNum(ensQ?.maxP50C);
        const ensMin = toNum(ensQ?.minP50C);

        if (detMaxC !== null && ensMax !== null) {
            maxC = +(wDet * detMaxC + (1 - wDet) * ensMax).toFixed(1);
        } else {
            maxC = +(detMaxC ?? ensMax ?? clim.climMaxC).toFixed(1);
        }
        if (detMinC !== null && ensMin !== null) {
            minC = +(wDet * detMinC + (1 - wDet) * ensMin).toFixed(1);
        } else {
            minC = +(detMinC ?? ensMin ?? clim.climMinC).toFixed(1);
        }
        if (minC > maxC) {
            const mid = +((maxC + minC) / 2).toFixed(1);
            maxC = +(mid + 0.5).toFixed(1);
            minC = +(mid - 0.5).toFixed(1);
        }

        const halfSpread = 2.0 + t * 1.2;
        maxQ = enforceQuantiles(maxC, ensQ?.maxP10C, ensQ?.maxP25C, ensQ?.maxP75C, ensQ?.maxP90C, halfSpread);
        minQ = enforceQuantiles(minC, ensQ?.minP10C, ensQ?.minP25C, ensQ?.minP75C, ensQ?.minP90C, halfSpread + 0.3);

        const detPrecip = weightedMean(precipEntries);
        const ensPrecip = toNum(ensQ?.precipP50Mm);
        precipMm = +(Math.max(0, detPrecip !== null && ensPrecip !== null ? wDet * detPrecip + (1 - wDet) * ensPrecip : (detPrecip ?? ensPrecip ?? 0))).toFixed(1);
        precipP75Mm = +(Math.max(precipMm, toNum(ensQ?.precipP75Mm) ?? precipMm * 1.5)).toFixed(1);
        windObj = windDaySamples.length ? blendWindVectors(windDaySamples) : (() => {
            const ws = +(toNum(ensQ?.windP50Ms) ?? 4.0).toFixed(1);
            const wg = +(Math.max(ws * 1.6, toNum(ensQ?.windP90Ms) ?? ws * 1.9)).toFixed(1);
            const c = degToCompass(250);
            return { windMs: ws, windMph: msToMph(ws), gustMs: wg, gustMph: msToMph(wg), windDeg: 250, windDirShort: c.s, windDirFull: c.f };
        })();
    } else {
        // Archive or Deterministic (0..9)
        maxC = +(detMaxC ?? clim.climMaxC).toFixed(1);
        minC = +(detMinC ?? clim.climMinC).toFixed(1);
        if (minC > maxC) {
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

        const hourSumPrecip = sortedRealHours.length ? sortedRealHours.reduce((s, h) => s + h.precipMm, 0) : null;
        const dailyPrecipMean = weightedMean(precipEntries);
        precipMm = +(Math.max(0, dailyPrecipMean ?? hourSumPrecip ?? 0)).toFixed(1);
        precipP75Mm = +(Math.max(precipMm, toNum(ensQ?.precipP75Mm) ?? (isArchive ? precipMm : precipMm * 1.3))).toFixed(1);

        if (windDaySamples.length) {
            windObj = blendWindVectors(windDaySamples);
        } else if (sortedRealHours.length) {
            windObj = blendWindVectors(sortedRealHours.map((h) => ({ speedMs: h.windMs, gustMs: h.gustMs, dirDeg: 250, weight: 1 })));
        } else {
            const c = degToCompass(250);
            windObj = { windMs: 3.5, windMph: msToMph(3.5), gustMs: 6.0, gustMph: msToMph(6.0), windDeg: 250, windDirShort: c.s, windDirFull: c.f };
        }
    }

    // Extract companion soil, snow depth, humidity, pressure, cloud cover
    const avgArr = (arr) => {
        const vals = arr.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
        return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
    };

    const compHourVals = compHours ? [...compHours.values()] : [];
    const snowDepthCm =
        toNum(rawArchiveDay?.snowDepthCm) ??
        (compHourVals.length ? Math.max(0, ...compHourVals.map((c) => c.snowDepthCm ?? 0)) : null) ??
        (zone === 'subseasonal' ? clim.climSnowDepthCm : 0);

    const soil0C =
        toNum(rawArchiveDay?.soil0C) ??
        avgArr(compHourVals.map((c) => c.soil0C)) ??
        +((maxC + minC) * 0.42).toFixed(1);
    const soil6C =
        toNum(rawArchiveDay?.soil6C) ??
        avgArr(compHourVals.map((c) => c.soil6C)) ??
        +(soil0C * 0.86 + 0.3).toFixed(1);
    const soil18C =
        toNum(rawArchiveDay?.soil18C) ??
        avgArr(compHourVals.map((c) => c.soil18C)) ??
        +(soil6C * 0.8 + 0.7).toFixed(1);
    const soil54C =
        toNum(rawArchiveDay?.soil54C) ??
        avgArr(compHourVals.map((c) => c.soil54C)) ??
        +(soil18C * 0.7 + 1.5).toFixed(1);

    const humidity = Math.round(
        clamp(
            toNum(rawArchiveDay?.humidity) ??
                (sortedRealHours.length ? avgArr(sortedRealHours.map((h) => h.humidity)) : null) ??
                toNum(googleData?.dailyByDate?.get(isoDate)?.humidity) ??
                74 - (maxC - minC) * 1.1 + Math.min(18, precipMm * 3),
            25,
            98
        )
    );
    const dewPointC =
        toNum(rawArchiveDay?.dewPointC) ??
        (sortedRealHours.length ? avgArr(sortedRealHours.map((h) => h.dewPointC)) : null) ??
        +(((maxC + minC) / 2) - (100 - humidity) / 5).toFixed(1);

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

    const pObj = convertPressure({
        surfaceHpa: toNum(rawArchiveDay?.surfacePressureHpa) ?? avgHourSurf ?? compSurf,
        mslHpa: toNum(rawArchiveDay?.pressureMslHpa) ?? avgHourMsl ?? compMsl,
        tempC: (maxC + minC) / 2,
        elevM: ABAN_COORDS.elev
    });

    const uv = Math.round(
        clamp(
            toNum(compDaily?.uv) ??
                toNum(googleData?.dailyByDate?.get(isoDate)?.uv) ??
                Math.max(0, Math.round((astronomy.daylightHours - 6) * 0.45)),
            0,
            11
        )
    );

    const dayMeanC = +((maxC + minC) / 2).toFixed(1);
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

    const precipDay = Math.round(
        clamp(
            toNum(googleData?.dailyByDate?.get(isoDate)?.precipDay) ??
                toNum(compDaily?.precipProbMax) ??
                (sortedRealHours.length ? Math.max(...sortedRealHours.filter((h) => h.hour >= 8 && h.hour <= 20).map((h) => h.precipProb)) : null) ??
                (ensQ?.probPrecipOver5 ? Math.min(95, Math.max(10, ensQ.probPrecipOver5 + precipMm * 10)) : null) ??
                Math.min(95, precipMm > 0.1 ? 25 + precipMm * 14 : 8),
            0,
            100
        )
    );
    const precipNight = Math.round(
        clamp(
            toNum(googleData?.dailyByDate?.get(isoDate)?.precipNight) ??
                (sortedRealHours.length ? Math.max(...sortedRealHours.filter((h) => h.hour >= 20 || h.hour <= 7).map((h) => h.precipProb)) : null) ??
                Math.round(precipDay * 0.8),
            0,
            100
        )
    );

    const gDaily = googleData?.dailyByDate?.get(isoDate);
    const repOmCode =
        toNum(rawArchiveDay?.weatherCode) ??
        toNum(omModelsData.ecmwf_ifs025?.dailyByDate?.get(isoDate)?.weatherCode) ??
        toNum(omModelsData.ecmwf_aifs025?.dailyByDate?.get(isoDate)?.weatherCode) ??
        toNum(omModelsData.gfs_seamless?.dailyByDate?.get(isoDate)?.weatherCode);
    const wDay = gDaily
        ? { ru: gDaily.dayCond, en: gDaily.dayCondEn, icon: gDaily.iconType }
        : repOmCode !== null
        ? wmoCodeToWeather(repOmCode, maxC, false)
        : wmoCodeToWeather(precipMm >= 1.5 ? (dayPhase.potentialPhase === 'snow' ? 73 : 61) : cloudCoverPct > 75 ? 3 : cloudCoverPct > 35 ? 2 : 0, maxC, false);

    const wNight = gDaily
        ? { ru: gDaily.nightCond, en: gDaily.nightCondEn, icon: gDaily.nightIconType }
        : repOmCode !== null
        ? wmoCodeToWeather(repOmCode, minC, true)
        : wmoCodeToWeather(precipMm >= 1.5 ? (nightPhase.potentialPhase === 'snow' ? 71 : 61) : cloudCoverPct > 70 ? 3 : cloudCoverPct > 35 ? 2 : 0, minC, true);

    const hours =
        sortedRealHours.length === 24
            ? sortedRealHours
            : buildSyntheticHours({
                  maxC,
                  minC,
                  humidity,
                  precipMm,
                  precipProb: precipDay,
                  windMs: windObj.windMs,
                  gustMs: windObj.gustMs,
                  windDeg: windObj.windDeg,
                  pressureStationMm: pObj.stationMm,
                  pressureMslMm: pObj.mslMm,
                  cloudCoverPct,
                  soil0C,
                  astronomy,
                  dayIcon: wDay.icon,
                  nightIcon: wNight.icon
              });

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
    const probFrostBelowMinus20 =
        toNum(ensQ?.probBelowMinus20) ?? Math.round(clamp(normCdf((-20 - minC) / minSigma) * 100, 0, 100));
    const probSnowOver5mm =
        meanPhase.potentialPhase === 'rain' && maxC > 3
            ? 0
            : (toNum(ensQ?.probPrecipOver5) ?? Math.round(clamp(snowMm >= 5 ? 75 : snowMm * 12, 0, 100)));

    let label;
    if (offsetFromToday === -1) label = 'Вчера (Архив)';
    else if (offsetFromToday < -1) label = 'Архив';
    else if (offsetFromToday === 0) label = 'Сегодня';
    else if (offsetFromToday === 1) label = 'Завтра';
    else label = dateMeta.isWeekend ? `${dateMeta.dayShort} (Вых.)` : dateMeta.dayShort;

    return {
        id: `day_${isoDate}`,
        idx: 0,
        isoDate,
        offsetFromToday,
        dayShort: dateMeta.dayShort,
        dateStr: dateMeta.dateStr,
        fullDateLabel: `${dateMeta.dayShort}, ${dateMeta.dateStr} ${dateMeta.year}${isArchive ? ' (Архив)' : offsetFromToday === 0 ? ' (Сегодня)' : ''}`,
        label,
        zone,
        confidencePct,
        isArchive,
        dayCond: wDay.ru,
        dayCondEn: wDay.en,
        nightCond: inversion.active && minC < 0 ? `${wNight.ru} (выхолаживание)` : wNight.ru,
        nightCondEn: wNight.en,
        iconType: wDay.icon,
        nightIconType: wNight.icon,
        maxC,
        maxF: cToF(maxC),
        minC,
        minF: cToF(minC),
        maxP10C: maxQ.p10,
        maxP25C: maxQ.p25,
        maxP75C: maxQ.p75,
        maxP90C: maxQ.p90,
        minP10C: minQ.p10,
        minP25C: minQ.p25,
        minP75C: minQ.p75,
        minP90C: minQ.p90,
        climMaxC: clim.climMaxC,
        climMinC: clim.climMinC,
        climAnomalyC: +(dayMeanC - clim.climMeanC).toFixed(1),
        humidity,
        uv,
        precipDay,
        precipNight,
        precipDayType: dayPhase.potentialShortRu,
        precipNightType: nightPhase.potentialShortRu,
        precipMm,
        precipP75Mm,
        rainMm,
        snowMm,
        snowDepthCm: +Number(snowDepthCm).toFixed(1),
        precipPhase: meanPhase.phase,
        windMs: windObj.windMs,
        windMph: windObj.windMph,
        gustMs: windObj.gustMs,
        gustMph: windObj.gustMph,
        windDirShort: windObj.windDirShort,
        windDirFull: windObj.windDirFull,
        windDeg: windObj.windDeg,
        soil0C: +Number(soil0C).toFixed(1),
        soil6C: +Number(soil6C).toFixed(1),
        soil18C: +Number(soil18C).toFixed(1),
        soil54C: +Number(soil54C).toFixed(1),
        soilTempC: +Number(soil0C).toFixed(1),
        dewPointC: +Number(dewPointC).toFixed(1),
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
        nextNightMaxC: +((maxC + minC) / 2).toFixed(1),
        nextNightMaxF: cToF((maxC + minC) / 2),
        nextNightPrecipProb: precipNight,
        nextNightPrecipMm: +(precipMm * 0.4).toFixed(1),
        nextNightPrecipType: nightPhase.potentialShortRu,
        nextNightWindMs: windObj.windMs,
        nextNightGustMs: windObj.gustMs,
        nextNightWindDirShort: windObj.windDirShort,
        nextNightCond: wNight.ru,
        nextNightIconType: wNight.icon,
        probFrostBelowMinus20,
        probSnowOver5mm,
        modelBreakdown,
        hours
    };
}

function finalizeDaysSequence(days, todayIso) {
    const sorted = [...days].sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    for (let i = 0; i < sorted.length; i++) {
        const d = sorted[i];
        d.idx = i;
        d.offsetFromToday = diffDaysIso(d.isoDate, todayIso);
        const isConsecutivePrev = i > 0 && diffDaysIso(d.isoDate, sorted[i - 1].isoDate) === 1;
        d.deltaP24hMm = isConsecutivePrev ? d.pressureStationMm - sorted[i - 1].pressureStationMm : 0;

        // True overnight: 20:00 of day d .. 08:00 of day d+1
        const nextDay = sorted[i + 1] && diffDaysIso(sorted[i + 1].isoDate, d.isoDate) === 1 ? sorted[i + 1] : null;
        const evening = (d.hours || []).filter((h) => h.hour >= 20);
        const morning = nextDay ? (nextDay.hours || []).filter((h) => h.hour <= 8) : (d.hours || []).filter((h) => h.hour <= 7);
        const overnight = [...evening, ...morning];
        if (overnight.length) {
            const temps = overnight.map((h) => h.tempC);
            const nMin = +Math.min(...temps).toFixed(1);
            const nMax = +Math.max(...temps).toFixed(1);
            const nPrecipSum = +overnight.reduce((s, h) => s + (h.precipMm || 0), 0).toFixed(1);
            const nProb = Math.max(...overnight.map((h) => h.precipProb || 0));
            const nHum = Math.round(overnight.reduce((s, h) => s + (h.humidity || 75), 0) / overnight.length);
            const nSoil = +(overnight.reduce((s, h) => s + (h.soil0C ?? d.soil0C), 0) / overnight.length).toFixed(1);
            const nWind = blendWindVectors(overnight.map((h) => ({ speedMs: h.windMs, gustMs: h.gustMs, dirDeg: d.windDeg, weight: 1 })));
            const nPhase = classifyPrecipPhase(nMin, nHum, nPrecipSum > 0 ? nPrecipSum : null, nSoil);

            d.nextNightMinC = nMin;
            d.nextNightMinF = cToF(nMin);
            d.nextNightMaxC = nMax;
            d.nextNightMaxF = cToF(nMax);
            d.nextNightPrecipProb = nProb;
            d.nextNightPrecipMm = nPrecipSum;
            d.nextNightPrecipType = nPhase.potentialShortRu;
            d.nextNightWindMs = nWind.windMs;
            d.nextNightGustMs = nWind.gustMs;
            d.nextNightWindDirShort = nWind.windDirShort;
            d.nextNightCond = d.nightCond;
            d.nextNightIconType = d.nightIconType;
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
    const abanNow = formatAbanTimestamp(rawBundle.fetchedAtIso);
    const googleFirstDate = googleData.dailyByDate.size ? [...googleData.dailyByDate.keys()].sort()[0] : null;
    const todayIso =
        options.todayIso ||
        rawBundle.openMeteoMulti?.current?.time?.slice(0, 10) ||
        rawBundle.openMeteoCompanion?.current?.time?.slice(0, 10) ||
        googleFirstDate ||
        abanNow.isoDate;

    const currentHour =
        utcIsoToAbanParts(rawBundle.openMeteoMulti?.current?.time)?.hour ??
        utcIsoToAbanParts(rawBundle.openMeteoCompanion?.current?.time)?.hour ??
        abanNow.hour;

    // Collect all dates across active sources
    const dateSet = new Set();
    for (const m of Object.values(omModelsData)) {
        for (const d of m.dailyByDate.keys()) dateSet.add(d);
        for (const d of m.hourlyByDate.keys()) dateSet.add(d);
    }
    for (const d of googleData.dailyByDate.keys()) dateSet.add(d);
    for (const d of googleData.hourlyByDate.keys()) dateSet.add(d);
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

    // Ensure continuous 0..34 forecast range whenever ensemble35 is supplied (or 0..15 for multi-model)
    if (ensMap.size) {
        for (let off = 0; off <= 34; off++) {
            dateSet.add(addDaysIso(todayIso, off));
        }
    } else if (Object.keys(omModelsData).length) {
        for (let off = 0; off <= 15; off++) {
            dateSet.add(addDaysIso(todayIso, off));
        }
    }

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
    const todayDay = days[todayIdx >= 0 ? todayIdx : Math.min(0, days.length - 1)] || null;
    const tomorrowDay = todayIdx >= 0 && days[todayIdx + 1] ? days[todayIdx + 1] : todayDay;
    const yesterdayDay = todayIdx > 0 ? days[todayIdx - 1] : null;
    const todaySlot = todayDay?.hours?.[currentHour] || todayDay?.hours?.[12] || null;

    // ------------------------------------------------------------------------
    // Air Quality
    // ------------------------------------------------------------------------
    const aqCur = rawBundle.airQuality?.current;
    let airQuality;
    if (aqCur && (toNum(aqCur.pm2_5) !== null || toNum(aqCur.european_aqi) !== null)) {
        const pm25 = +(toNum(aqCur.pm2_5) ?? 0).toFixed(1);
        const pm10 = +(toNum(aqCur.pm10) ?? 0).toFixed(1);
        const co = Math.round(toNum(aqCur.carbon_monoxide) ?? 0);
        const aqi = Math.round(toNum(aqCur.european_aqi) ?? 0);
        let statusRu = 'Отличный';
        let smogRisk = 'low';
        if (aqi > 80 || pm25 >= 50) {
            statusRu = 'Плохой (смог)';
            smogRisk = 'high';
        } else if (aqi > 60 || pm25 >= 25 || (todayDay?.inversion?.active && pm25 >= 18)) {
            statusRu = 'Повышенный (дымка)';
            smogRisk = 'moderate';
        } else if (aqi > 40) {
            statusRu = 'Умеренный';
            smogRisk = 'low';
        } else if (aqi > 20) {
            statusRu = 'Хороший';
            smogRisk = 'low';
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
    const curPrecipEntries = [];

    if (gCur && toNum(gCur.temperature?.degrees) !== null) {
        const gw = MODEL_META.google_wn3.weights.short48h * (mos?.models?.google_wn3?.weightMultiplier ?? 1);
        curTempEntries.push({ value: toNum(gCur.temperature.degrees), weight: gw });
        if (toNum(gCur.relativeHumidity) !== null) curHumEntries.push({ value: toNum(gCur.relativeHumidity), weight: gw });
        if (toNum(gCur.airPressure?.meanSeaLevelMillibars) !== null) curMslEntries.push({ value: toNum(gCur.airPressure.meanSeaLevelMillibars), weight: gw });
        if (toNum(gCur.precipitation?.qpf?.quantity) !== null) curPrecipEntries.push({ value: toNum(gCur.precipitation.qpf.quantity), weight: gw });
        const gWs = parseGoogleSpeedMs(gCur.wind?.speed);
        if (gWs !== null) {
            curWindSamples.push({
                speedMs: gWs,
                gustMs: parseGoogleSpeedMs(gCur.wind?.gust) ?? gWs * 1.6,
                dirDeg: toNum(gCur.wind?.direction?.degrees) ?? 250,
                weight: gw
            });
        }
    }
    if (omCur && toNum(omCur.temperature_2m) !== null) {
        curTempEntries.push({ value: toNum(omCur.temperature_2m), weight: 0.45 });
        if (toNum(omCur.relative_humidity_2m) !== null) curHumEntries.push({ value: toNum(omCur.relative_humidity_2m), weight: 0.45 });
        if (toNum(omCur.pressure_msl) !== null) curMslEntries.push({ value: toNum(omCur.pressure_msl), weight: 0.45 });
        if (toNum(omCur.surface_pressure) !== null) curSurfEntries.push({ value: toNum(omCur.surface_pressure), weight: 0.45 });
        if (toNum(omCur.precipitation) !== null) curPrecipEntries.push({ value: toNum(omCur.precipitation), weight: 0.45 });
        if (toNum(omCur.wind_speed_10m) !== null) {
            curWindSamples.push({
                speedMs: toNum(omCur.wind_speed_10m),
                gustMs: toNum(omCur.wind_gusts_10m) ?? toNum(omCur.wind_speed_10m) * 1.6,
                dirDeg: toNum(omCur.wind_direction_10m) ?? 250,
                weight: 0.45
            });
        }
    }
    if (compCur && toNum(compCur.surface_pressure) !== null && !curSurfEntries.length) {
        curSurfEntries.push({ value: toNum(compCur.surface_pressure), weight: 0.4 });
    }
    if (!curTempEntries.length && todaySlot) {
        curTempEntries.push({ value: todaySlot.tempC, weight: 1 });
        curHumEntries.push({ value: todaySlot.humidity, weight: 1 });
        curPrecipEntries.push({ value: todaySlot.precipMm, weight: 1 });
        curWindSamples.push({ speedMs: todaySlot.windMs, gustMs: todaySlot.gustMs, dirDeg: todayDay?.windDeg ?? 250, weight: 1 });
    }

    const curTempC = +(weightedMean(curTempEntries) ?? todaySlot?.tempC ?? 0).toFixed(1);
    const curWind = curWindSamples.length ? blendWindVectors(curWindSamples) : {
        windMs: todaySlot?.windMs ?? 0, windMph: todaySlot?.windMph ?? 0,
        gustMs: todaySlot?.gustMs ?? 0, gustMph: msToMph(todaySlot?.gustMs ?? 0),
        windDeg: todayDay?.windDeg ?? 250, windDirShort: todayDay?.windDirShort ?? 'З'
    };
    const curHumidity = Math.round(clamp(weightedMean(curHumEntries) ?? todaySlot?.humidity ?? 70, 10, 100));
    const curWetBulbC = computeWetBulbC(curTempC, curHumidity);
    const curFeelsC = computeApparentTempC(curTempC, curWind.windMs, curHumidity);
    const curDewPointC = +(todaySlot?.dewPointC ?? (curTempC - (100 - curHumidity) / 5)).toFixed(1);
    const curSoil0C = +(todaySlot?.soil0C ?? todayDay?.soil0C ?? 0).toFixed(1);
    const curPrecipMm = +(Math.max(0, weightedMean(curPrecipEntries) ?? todaySlot?.precipMm ?? 0)).toFixed(1);
    const curPrecipProb = Math.round(
        clamp(toNum(gCur?.precipitation?.probability?.percent) ?? todaySlot?.precipProb ?? todayDay?.precipDay ?? 0, 0, 100)
    );
    const curPhaseObj = classifyPrecipPhase(curTempC, curHumidity, curPrecipMm, curSoil0C);
    const curPress = convertPressure({
        surfaceHpa: weightedMean(curSurfEntries) ?? todaySlot?.pressureStationHpa,
        mslHpa: weightedMean(curMslEntries) ?? todaySlot?.pressureMslHpa,
        tempC: curTempC,
        elevM: ABAN_COORDS.elev
    });

    // Pressure tendencies (3h & 24h)
    let p3hAgoMm = curPress.stationMm;
    if (todayDay?.hours?.length) {
        if (currentHour >= 3) {
            p3hAgoMm = todayDay.hours[currentHour - 3]?.pressureStationMm ?? curPress.stationMm;
        } else if (yesterdayDay?.hours?.length) {
            p3hAgoMm = yesterdayDay.hours[24 + currentHour - 3]?.pressureStationMm ?? curPress.stationMm;
        }
    }
    const p24hAgoMm = yesterdayDay?.hours?.[currentHour]?.pressureStationMm ?? yesterdayDay?.pressureStationMm ?? curPress.stationMm;

    const isCurNight = todayDay ? (currentHour < todayDay.astronomy.sunriseHour || currentHour > todayDay.astronomy.sunsetHour) : false;
    const curMeta = gCur?.weatherCondition
        ? googleCondToMeta(gCur.weatherCondition, curTempC, isCurNight)
        : wmoCodeToWeather(omCur?.weather_code ?? (curPrecipMm > 0 ? (curPhaseObj.phase === 'snow' ? 71 : 61) : 2), curTempC, isCurNight);

    const current = {
        tempC: curTempC,
        tempF: cToF(curTempC),
        feelsC: curFeelsC,
        feelsF: cToF(curFeelsC),
        wetBulbC: curWetBulbC,
        condRu: curMeta.ru,
        iconType: curMeta.icon,
        windMs: curWind.windMs,
        windMph: curWind.windMph,
        gustMs: curWind.gustMs,
        gustMph: curWind.gustMph,
        windDeg: curWind.windDeg,
        windDirShort: curWind.windDirShort,
        precipProb: curPrecipProb,
        precipMm: curPrecipMm,
        precipPhase: curPhaseObj.phase,
        snowDepthCm: todayDay?.snowDepthCm ?? 0,
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
        deltaP3hMm: curPress.stationMm - p3hAgoMm,
        deltaP24hMm: curPress.stationMm - p24hAgoMm,
        uv: Math.round(toNum(gCur?.uvIndex) ?? todayDay?.uv ?? 0),
        obsTimeLabel: `п. Абан • ${abanNow.label}`
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
    const shiftSlot = targetDay?.hours?.[targetHour] || todaySlot;
    const h3Raw = currentHour + 3;
    const h3Hour = h3Raw % 24;
    const h3Day = h3Raw >= 24 ? tomorrowDay : todayDay;
    const h3Slot = h3Day?.hours?.[h3Hour] || shiftSlot;

    const shiftMeta = wmoCodeToWeather(shiftSlot?.precipMm > 0.2 ? (shiftSlot.precipPhase === 'snow' ? 71 : 61) : (shiftSlot?.cloudCoverPct > 70 ? 3 : 1), shiftSlot?.tempC ?? curTempC, targetHour >= 20 || targetHour < 7);

    const controlPoint = {
        targetLabel: `Смена ${String(targetHour).padStart(2, '0')}:00${targetSuffix}`,
        tempC: shiftSlot?.tempC ?? curTempC,
        tempF: cToF(shiftSlot?.tempC ?? curTempC),
        feelsC: shiftSlot?.feelsC ?? curFeelsC,
        condRu: shiftMeta.ru,
        badgeRu: shiftMeta.ru.split(' ')[0],
        iconType: shiftSlot?.iconType || shiftMeta.icon,
        precipProb: shiftSlot?.precipProb ?? curPrecipProb,
        windMs: shiftSlot?.windMs ?? curWind.windMs,
        windMph: shiftSlot?.windMph ?? curWind.windMph,
        windDirShort: shiftSlot?.windDirShort ?? curWind.windDirShort,
        soil0C: shiftSlot?.soil0C ?? curSoil0C,
        next3hLabel: `Через 3 ч (${String(h3Hour).padStart(2, '0')}:00)`,
        next3hTempC: h3Slot?.tempC ?? curTempC
    };

    const sourceType =
        mode === 'google_wn3'
            ? 'live_google_wn3'
            : mode === 'open_meteo'
            ? 'live_open_meteo'
            : activeModels.includes('google_wn3')
            ? 'live_super_ensemble'
            : 'live_multi_ensemble';

    const sourceLabel =
        mode === 'google_wn3'
            ? 'WeatherNext 3 Live (Абан)'
            : mode === 'open_meteo'
            ? `Open-Meteo ${days.filter((d) => !d.isArchive).length}д (${preferredOmModel})`
            : `Супер-Ансамбль (${activeModels.length} мод. • ${days.filter((d) => !d.isArchive).length}д)`;

    return {
        version: 4,
        sourceType,
        sourceLabel,
        syncedAt: abanNow.label,
        latencyMs,
        activeModels,
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
        if (!raw?.isoDate) continue;
        const isoDate = String(raw.isoDate).slice(0, 10);
        const existing = byIso.get(isoDate);
        // Never overwrite deterministic/ensemble forecast days with archive
        if (existing && !existing.isArchive && existing.offsetFromToday >= 0) continue;

        // If already canonical archive DayRecord, preserve/update safely
        if (raw.version === 4 || (raw.zone === 'archive' && Array.isArray(raw.hours) && raw.hours.length === 24 && raw.astronomy)) {
            byIso.set(isoDate, { ...raw, id: `day_${isoDate}`, zone: 'archive', isArchive: true, confidencePct: 99 });
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
        normalized.confidencePct = 99;
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
export function computeDayWindowStats(day, timeWindowKey = 'full') {
    const winCfg = TIME_WINDOWS[timeWindowKey] || TIME_WINDOWS.full;
    let hours = Array.isArray(day?.hours) && day.hours.length ? day.hours : [];
    if (!hours.length && day) {
        hours = buildSyntheticHours({
            maxC: day.maxC ?? 0,
            minC: day.minC ?? 0,
            humidity: day.humidity ?? 70,
            precipMm: day.precipMm ?? 0,
            precipProb: day.precipDay ?? 10,
            windMs: day.windMs ?? 3,
            gustMs: day.gustMs ?? 5,
            windDeg: day.windDeg ?? 250,
            pressureStationMm: day.pressureStationMm ?? 745,
            pressureMslMm: day.pressureMslMm ?? 765,
            cloudCoverPct: day.cloudCoverPct ?? 40,
            soil0C: day.soil0C ?? 0,
            astronomy: day.astronomy,
            dayIcon: day.iconType || 'partly-sunny',
            nightIcon: day.nightIconType || 'partly-cloudy-night'
        });
    }

    const activeRaw = hours.filter((h) => winCfg.isHourActive(h.hour, day));
    const activeHours = activeRaw.length ? activeRaw : hours;
    if (!activeHours.length) {
        return {
            hours: [],
            activeHours: [],
            avgC: 0,
            avgF: 32,
            minC: 0,
            maxC: 0,
            avgWindMs: 0,
            maxGustMs: 0,
            maxPrecipProb: 0,
            sumPrecipMm: 0
        };
    }

    const temps = activeHours.map((h) => Number(h.tempC) || 0);
    const avgC = +(temps.reduce((a, b) => a + b, 0) / activeHours.length).toFixed(1);
    const minC = +Math.min(...temps).toFixed(1);
    const maxC = +Math.max(...temps).toFixed(1);
    const avgWindMs = +(activeHours.reduce((a, h) => a + (Number(h.windMs) || 0), 0) / activeHours.length).toFixed(1);
    const maxGustMs = +Math.max(...activeHours.map((h) => Number(h.gustMs) || Number(h.windMs) || 0)).toFixed(1);
    const maxPrecipProb = Math.round(Math.max(...activeHours.map((h) => Number(h.precipProb) || 0)));
    const sumPrecipMm = +activeHours.reduce((a, h) => a + (Number(h.precipMm) || 0), 0).toFixed(1);

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

export function buildPentadSummary(days) {
    if (!Array.isArray(days) || !days.length) return [];
    const pentads = [];
    for (let i = 0; i < days.length; i += 5) {
        const chunk = days.slice(i, i + 5);
        const n = chunk.length;
        const first = chunk[0];
        const last = chunk[n - 1];
        const avg = (fn) => +(chunk.reduce((s, d) => s + (toNum(fn(d)) ?? 0), 0) / n).toFixed(1);

        const maxC = avg((d) => d.maxC);
        const minC = avg((d) => d.minC);
        const absMaxC = +Math.max(...chunk.map((d) => d.maxC)).toFixed(1);
        const absMinC = +Math.min(...chunk.map((d) => d.minC)).toFixed(1);
        const meanC = +((maxC + minC) / 2).toFixed(1);

        const wind = blendWindVectors(
            chunk.map((d) => ({ speedMs: d.windMs, gustMs: d.gustMs, dirDeg: d.windDeg ?? 250, weight: 1 }))
        );
        const precipMm = +chunk.reduce((s, d) => s + (d.precipMm ?? 0), 0).toFixed(1);
        const precipP75Mm = +chunk.reduce((s, d) => s + (d.precipP75Mm ?? d.precipMm ?? 0), 0).toFixed(1);
        const snowMm = +chunk.reduce((s, d) => s + (d.snowMm ?? 0), 0).toFixed(1);
        const rainMm = +chunk.reduce((s, d) => s + (d.rainMm ?? 0), 0).toFixed(1);

        const startDay = first.dateStr.split(' ')[0];
        const endParts = last.dateStr.split(' ');
        const label = n === 1
            ? first.dateStr
            : first.dateStr.split(' ')[1] === endParts[1]
            ? `${startDay}–${endParts[0]} ${endParts[1]}`
            : `${first.dateStr}–${last.dateStr}`;

        const qMax = enforceQuantiles(
            maxC,
            avg((d) => d.maxP10C ?? d.maxC),
            avg((d) => d.maxP25C ?? d.maxC),
            avg((d) => d.maxP75C ?? d.maxC),
            avg((d) => d.maxP90C ?? d.maxC)
        );
        const qMin = enforceQuantiles(
            minC,
            avg((d) => d.minP10C ?? d.minC),
            avg((d) => d.minP25C ?? d.minC),
            avg((d) => d.minP75C ?? d.minC),
            avg((d) => d.minP90C ?? d.minC)
        );

        const repZone = chunk[Math.floor(n / 2)].zone;
        const meanPhase = classifyPrecipPhase(meanC, Math.round(avg((d) => d.humidity ?? 70)), precipMm, avg((d) => d.soil0C ?? 0));

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
            confidencePct: Math.round(avg((d) => d.confidencePct ?? 70)),
            maxC,
            maxF: cToF(maxC),
            minC,
            minF: cToF(minC),
            absMaxC,
            absMinC,
            meanC,
            maxP10C: qMax.p10,
            maxP25C: qMax.p25,
            maxP75C: qMax.p75,
            maxP90C: qMax.p90,
            minP10C: qMin.p10,
            minP25C: qMin.p25,
            minP75C: qMin.p75,
            minP90C: qMin.p90,
            climMaxC: avg((d) => d.climMaxC),
            climMinC: avg((d) => d.climMinC),
            climAnomalyC: avg((d) => d.climAnomalyC),
            humidity: Math.round(avg((d) => d.humidity ?? 70)),
            precipMm,
            precipP75Mm,
            snowMm,
            rainMm,
            precipDay: Math.round(Math.max(...chunk.map((d) => d.precipDay ?? 0))),
            precipDayType: meanPhase.potentialShortRu,
            precipPhase: meanPhase.phase,
            snowDepthCm: +Math.max(...chunk.map((d) => d.snowDepthCm ?? 0)).toFixed(1),
            windMs: wind.windMs,
            windMph: wind.windMph,
            gustMs: +Math.max(...chunk.map((d) => d.gustMs ?? 0)).toFixed(1),
            gustMph: msToMph(Math.max(...chunk.map((d) => d.gustMs ?? 0))),
            windDirShort: wind.windDirShort,
            soil0C: avg((d) => d.soil0C ?? 0),
            soil6C: avg((d) => d.soil6C ?? 0),
            soil18C: avg((d) => d.soil18C ?? 0),
            soil54C: avg((d) => d.soil54C ?? 0),
            dewPointC: avg((d) => d.dewPointC ?? 0),
            pressureStationMm: Math.round(avg((d) => d.pressureStationMm ?? 745)),
            pressureMslMm: Math.round(avg((d) => d.pressureMslMm ?? 765)),
            deltaP24hMm: Math.round(last.pressureStationMm - first.pressureStationMm),
            dayIds: chunk.map((d) => d.id)
        });
    }
    return pentads;
}
