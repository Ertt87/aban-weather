// ============================================================================
// ABAN METEO v4 — METEOROLOGICAL PHYSICS, ASTRONOMY & FIELD OPERATIONS
// ============================================================================
import { ABAN_COORDS } from './config.js';

const COMPASS_DIRS = [
    { s: 'С', f: 'Северный' },
    { s: 'СВ', f: 'Северо-Восточный' },
    { s: 'В', f: 'Восточный' },
    { s: 'ЮВ', f: 'Юго-Восточный' },
    { s: 'Ю', f: 'Южный' },
    { s: 'ЮЗ', f: 'Юго-Западный' },
    { s: 'З', f: 'Западный' },
    { s: 'СЗ', f: 'Северо-Западный' }
];

/** Compass label for "direction unknown" (e.g. ensemble-only days that carry wind speed only). */
export const NO_DIRECTION = Object.freeze({ s: '—', f: null });

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

/**
 * Strict numeric coercion: null / undefined / '' / non-finite => null.
 * (Plain `Number(null)` is 0, which silently turns "no value" into a real-looking zero.)
 */
export function toFiniteNumber(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
}

export function cToF(c) {
    const n = toFiniteNumber(c);
    if (n === null) return null;
    return Math.round((n * 9) / 5 + 32);
}

export function msToMph(ms) {
    const n = toFiniteNumber(ms);
    if (n === null) return null;
    return Math.round(n * 2.23694);
}

export function hpaToMmHg(hpa) {
    const n = toFiniteNumber(hpa);
    if (n === null) return null;
    return Math.round(n * 0.750062);
}

export function degToCompass(deg) {
    const raw = toFiniteNumber(deg) ?? 0;
    const norm = ((raw % 360) + 360) % 360;
    const idx = Math.round(norm / 45) % 8;
    return COMPASS_DIRS[idx];
}

export function formatSignedC(val, decimals = 1) {
    const n = toFiniteNumber(val);
    if (n === null) return '—';
    const fixedNum = Number(n.toFixed(decimals));
    const cleanNum = Object.is(fixedNum, -0) ? 0 : fixedNum;
    const str = cleanNum.toFixed(decimals);
    const sign = cleanNum > 0 ? '+' : '';
    return `${sign}${str}°C`;
}

/**
 * Stull (2011) wet-bulb temperature approximation from air temperature (°C) and RH (%).
 */
export function computeWetBulbC(tempC, rhPercent) {
    const T = toFiniteNumber(tempC);
    if (T === null) return null;
    const RH = clamp(toFiniteNumber(rhPercent) ?? 70, 1, 100);
    const tw =
        T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) +
        Math.atan(T + RH) -
        Math.atan(RH - 1.676331) +
        0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) -
        4.686035;
    return +tw.toFixed(2);
}

/**
 * Thermodynamic precipitation phase classification via Stull wet-bulb temperature + ground freeze check.
 * When precipMm is explicitly <= 0, returns phase='dry' alongside potentialPhase.
 * When precipMm is omitted/null or > 0, returns the thermodynamic phase ('snow'|'sleet'|'freezing_rain'|'rain').
 */
export function classifyPrecipPhase(tempC, rhPercent, precipMm = null, soil0C = null) {
    const T = toFiniteNumber(tempC) ?? 0;
    const RH = clamp(toFiniteNumber(rhPercent) ?? 75, 1, 100);
    const Tw = computeWetBulbC(T, RH);
    const soil = toFiniteNumber(soil0C);

    let potential;
    if (Tw < -0.5) {
        const slr = +clamp(10 + (-0.5 - Tw) * 0.55, 10, 18).toFixed(1);
        potential = {
            phase: 'snow',
            labelRu: 'Снег',
            shortRu: 'снег',
            snowLiquidRatio: slr
        };
    } else if (Tw <= 1.2) {
        potential = {
            phase: 'sleet',
            labelRu: 'Мокрый снег',
            shortRu: 'мокрый снег',
            snowLiquidRatio: 5.5
        };
    } else if (T < 0 || (soil !== null && soil < -0.3)) {
        potential = {
            phase: 'freezing_rain',
            labelRu: 'Гололёд / ледяной дождь',
            shortRu: 'гололёд',
            snowLiquidRatio: 0
        };
    } else {
        potential = {
            phase: 'rain',
            labelRu: 'Дождь',
            shortRu: 'дождь',
            snowLiquidRatio: 0
        };
    }

    const pMm = toFiniteNumber(precipMm);
    if (pMm !== null && pMm <= 0) {
        return {
            phase: 'dry',
            labelRu: 'Сухо',
            shortRu: 'Сухо',
            potentialPhase: potential.phase,
            potentialShortRu: potential.shortRu,
            snowLiquidRatio: 0
        };
    }

    return {
        ...potential,
        potentialPhase: potential.phase,
        potentialShortRu: potential.shortRu
    };
}

/**
 * Vector wind direction blending (u, v) paired with weighted scalar wind speed and upper gust.
 * Prevents 355° & 5° wrap-around artifacts and avoids vanishing scalar speeds for opposing light winds.
 * @param {Array<{ speedMs: number, gustMs?: number, dirDeg: number, weight?: number }>} samples
 */
export function blendWindVectors(samples) {
    const valid = (Array.isArray(samples) ? samples : []).filter(
        (s) => s && toFiniteNumber(s.speedMs) !== null
    );
    if (!valid.length) {
        return {
            windMs: null,
            windMph: null,
            gustMs: null,
            gustMph: null,
            windDeg: null,
            windDirShort: NO_DIRECTION.s,
            windDirFull: NO_DIRECTION.f
        };
    }

    let weightSum = 0;
    let sumU = 0;
    let sumV = 0;
    let sumSpeed = 0;
    let sumGust = 0;
    let maxGust = 0;
    let fallbackDeg = null;
    let maxDirWeight = -1;

    for (const s of valid) {
        const w = Math.max(0.001, toFiniteNumber(s.weight) ?? 1);
        const speed = Math.max(0, toFiniteNumber(s.speedMs) ?? 0);
        const gust = Math.max(speed, toFiniteNumber(s.gustMs) ?? speed * 1.6);

        // A sample without a direction still counts toward speed, but never toward the bearing:
        // inventing one (it used to default to north / 250°) fabricates a wind rose.
        const rawDir = toFiniteNumber(s.dirDeg);
        if (rawDir !== null) {
            const dir = ((rawDir % 360) + 360) % 360;
            const rad = (dir * Math.PI) / 180;
            // Meteorological wind vector: blowing FROM dirDeg
            const vecMag = Math.max(0.1, speed);
            sumU += w * (-vecMag * Math.sin(rad));
            sumV += w * (-vecMag * Math.cos(rad));
            if (w > maxDirWeight) {
                maxDirWeight = w;
                fallbackDeg = dir;
            }
        }

        sumSpeed += w * speed;
        sumGust += w * gust;
        if (gust > maxGust) maxGust = gust;
        weightSum += w;
    }

    let windDeg = null;
    if (fallbackDeg !== null) {
        const vecLen = Math.hypot(sumU, sumV);
        windDeg = vecLen > 1e-6
            ? Math.round(((Math.atan2(-sumU, -sumV) * 180) / Math.PI + 360) % 360) % 360
            : Math.round(fallbackDeg) % 360;
    }

    const windMs = +(sumSpeed / weightSum).toFixed(1);
    const weightedGust = sumGust / weightSum;
    const gustMs = +Math.max(windMs, 0.75 * weightedGust + 0.25 * maxGust).toFixed(1);
    const comp = windDeg !== null ? degToCompass(windDeg) : NO_DIRECTION;

    return {
        windMs,
        windMph: msToMph(windMs),
        gustMs,
        gustMph: msToMph(gustMs),
        windDeg,
        windDirShort: comp.s,
        windDirFull: comp.f
    };
}

/**
 * WMO Wind Chill (T <= 10°C & wind >= 1.3 m/s) or Australian BoM Steadman Apparent Temperature.
 */
export function computeApparentTempC(tempC, windMs, rhPercent) {
    const T = toFiniteNumber(tempC);
    if (T === null) return null;
    const vMs = Math.max(0, toFiniteNumber(windMs) ?? 0);
    const rh = clamp(toFiniteNumber(rhPercent) ?? 70, 1, 100);

    if (T <= 10 && vMs >= 1.3) {
        const vKmh = vMs * 3.6;
        const vPow = Math.pow(vKmh, 0.16);
        const wc = 13.12 + 0.6215 * T - 11.37 * vPow + 0.3965 * T * vPow;
        return +wc.toFixed(1);
    }

    const vaporHpa = (rh / 100) * 6.105 * Math.exp((17.27 * T) / (237.7 + T));
    const at = T + 0.33 * vaporHpa - 0.70 * vMs - 4.00;
    return +at.toFixed(1);
}

/**
 * Laplace barometric elevation adjustment between station surface pressure and sea-level pressure (MSL).
 */
export function convertPressure({ surfaceHpa = null, mslHpa = null, tempC = 0, elevM = ABAN_COORDS.elev } = {}) {
    const elev = toFiniteNumber(elevM) ?? ABAN_COORDS.elev;
    const T = toFiniteNumber(tempC) ?? 0;
    const tMeanK = Math.max(180, T + 273.15 + 0.00325 * elev);
    const factor = (0.034163 * elev) / tMeanK;

    const sIn = toFiniteNumber(surfaceHpa);
    const mIn = toFiniteNumber(mslHpa);

    let stationHpa;
    let resolvedMslHpa;

    if (sIn !== null && mIn !== null) {
        stationHpa = Math.round(sIn);
        resolvedMslHpa = Math.round(mIn);
    } else if (mIn !== null) {
        resolvedMslHpa = Math.round(mIn);
        stationHpa = Math.round(mIn * Math.exp(-factor));
    } else if (sIn !== null) {
        stationHpa = Math.round(sIn);
        resolvedMslHpa = Math.round(sIn * Math.exp(factor));
    } else {
        resolvedMslHpa = 1013;
        stationHpa = Math.round(1013 * Math.exp(-factor));
    }

    return {
        stationHpa,
        stationMm: hpaToMmHg(stationHpa),
        mslHpa: resolvedMslHpa,
        mslMm: hpaToMmHg(resolvedMslHpa)
    };
}

function formatHourDecimal(hr) {
    const wrapped = ((hr % 24) + 24) % 24;
    let h = Math.floor(wrapped);
    let m = Math.round((wrapped - h) * 60);
    if (m >= 60) {
        m = 0;
        h = (h + 1) % 24;
    }
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * NOAA solar geometry for sunrise, sunset, civil twilight dawn/dusk, and daylight duration.
 */
export function computeAstronomy(dateIso, lat = ABAN_COORDS.lat, lon = ABAN_COORDS.lon, utcOffsetHours = ABAN_COORDS.utcOffsetHours) {
    const str = String(dateIso || '').slice(0, 10);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    let y, m, d;
    if (match) {
        y = Number(match[1]);
        m = Number(match[2]);
        d = Number(match[3]);
    } else {
        const now = new Date(Date.now() + utcOffsetHours * 3600000);
        y = now.getUTCFullYear();
        m = now.getUTCMonth() + 1;
        d = now.getUTCDate();
    }

    const doy = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
    const gamma = ((2 * Math.PI) / 365) * (doy - 1);
    const eqTime =
        229.18 *
        (0.000075 +
            0.001868 * Math.cos(gamma) -
            0.032077 * Math.sin(gamma) -
            0.014615 * Math.cos(2 * gamma) -
            0.040849 * Math.sin(2 * gamma));

    const decl =
        0.006918 -
        0.399912 * Math.cos(gamma) +
        0.070257 * Math.sin(gamma) -
        0.006758 * Math.cos(2 * gamma) +
        0.000907 * Math.sin(2 * gamma) -
        0.002697 * Math.cos(3 * gamma) +
        0.00148 * Math.sin(3 * gamma);

    const latRad = (lat * Math.PI) / 180;
    const hourAngleDeg = (zenithDeg) => {
        const zenRad = (zenithDeg * Math.PI) / 180;
        const cosH = Math.cos(zenRad) / (Math.cos(latRad) * Math.cos(decl)) - Math.tan(latRad) * Math.tan(decl);
        return (Math.acos(clamp(cosH, -1, 1)) * 180) / Math.PI;
    };

    const solarNoonMin = 720 - 4 * lon - eqTime + utcOffsetHours * 60;
    const haSun = hourAngleDeg(90.833);
    const haCivil = hourAngleDeg(96.0);

    const sunriseHour = +((solarNoonMin - 4 * haSun) / 60).toFixed(2);
    const sunsetHour = +((solarNoonMin + 4 * haSun) / 60).toFixed(2);
    const dawnHour = +((solarNoonMin - 4 * haCivil) / 60).toFixed(2);
    const duskHour = +((solarNoonMin + 4 * haCivil) / 60).toFixed(2);
    const daylightHours = +Math.max(0, sunsetHour - sunriseHour).toFixed(2);

    return {
        sunriseStr: formatHourDecimal(sunriseHour),
        sunsetStr: formatHourDecimal(sunsetHour),
        dawnStr: formatHourDecimal(dawnHour),
        duskStr: formatHourDecimal(duskHour),
        sunriseHour,
        sunsetHour,
        daylightHours
    };
}

/**
 * Estimates radiative cold-air pooling / basin inversion in the Aban depression (Абанская котловина).
 */
export function detectBasinInversion({ nightMinC = 0, cloudCoverPct = 50, nightWindMs = 3, snowDepthCm = 0 } = {}) {
    const minT = toFiniteNumber(nightMinC) ?? 0;
    const cloud = clamp(toFiniteNumber(cloudCoverPct) ?? 50, 0, 100);
    const wind = Math.max(0, toFiniteNumber(nightWindMs) ?? 3);
    const snow = Math.max(0, toFiniteNumber(snowDepthCm) ?? 0);

    const cloudFactor = clamp((45 - cloud) / 45, 0, 1);
    const windFactor = clamp((3.5 - wind) / 3.5, 0, 1);
    const snowBoost = snow >= 5 ? 1.45 : snow > 0 ? 1.15 : 1.0;

    const rawDelta = 4.2 * cloudFactor * windFactor * snowBoost;
    const deltaC = +clamp(rawDelta, 0, 6.0).toFixed(1);
    const active = deltaC >= 1.2;
    const valleyMinC = +(minT - deltaC).toFixed(1);

    let noteRu;
    if (active) {
        noteRu = snow >= 5
            ? `Ясная тихая ночь над снегом: застой холодного воздуха в низинах Абана (до ${formatSignedC(valleyMinC)}, −${deltaC.toFixed(1)}°C)`
            : `Радиационное выхолаживание в Абанской котловине: в низинах холоднее на ${deltaC.toFixed(1)}°C (до ${formatSignedC(valleyMinC)})`;
    } else {
        noteRu = 'Ветер или облачность перемешивают приземный слой — котловинная инверсия не выражена';
    }

    return { active, deltaC, valleyMinC, noteRu };
}

/**
 * Computes field operational metrics for п. Абан (Р-255 highway risk, diesel cold-filter grade,
 * 4-layer soil freeze/trafficability, and diurnal 0°C crossing).
 */
export function computeFieldOpsMetrics(day, prevDays = []) {
    const maxC = toFiniteNumber(day?.maxC) ?? 0;
    const minC = toFiniteNumber(day?.minC) ?? 0;
    const precipMm = Math.max(0, toFiniteNumber(day?.precipMm) ?? 0);
    const snowMm = Math.max(0, toFiniteNumber(day?.snowMm) ?? 0);
    const snowDepthCm = Math.max(0, toFiniteNumber(day?.snowDepthCm) ?? 0);
    const humidity = clamp(toFiniteNumber(day?.humidity) ?? 70, 0, 100);
    const windMs = Math.max(0, toFiniteNumber(day?.windMs) ?? 0);
    const gustMs = Math.max(windMs, toFiniteNumber(day?.gustMs) ?? windMs);
    const precipPhase = day?.precipPhase || 'dry';

    const frostCrossZero = maxC > 0 && minC < 0;
    const hasFreezingRain =
        precipPhase === 'freezing_rain' ||
        (Array.isArray(day?.hours) && day.hours.some((h) => !h?.isSynthetic && h?.precipPhase === 'freezing_rain' && (h?.precipMm ?? 0) > 0));
    const roadSnowDepth = day?.dataQuality?.snowEstimated ? 0 : snowDepthCm;
    const hasBlizzard = (snowMm >= 4 && gustMs >= 13) || (roadSnowDepth >= 5 && gustMs >= 16);

    // 1. Road Risk (Р-255 Канск–Абан–Богучаны)
    let roadRisk;
    if (day?.dataQuality?.roadRiskInputsAvailable !== true ||
        !['minC', 'maxC', 'windMs', 'gustMs', 'precipMm'].every(key => Number.isFinite(day[key]))) {
        roadRisk = {
            level: 'unknown',
            code: 'insufficient_data',
            labelRu: 'Недостаточно данных',
            detailRu: 'Дорожный риск оценить нельзя без модельных данных о температуре, осадках, ветре и порывах за выбранные сутки.'
        };
    } else if (hasFreezingRain) {
        roadRisk = {
            level: 'severe',
            code: 'freezing_rain',
            labelRu: 'Опасно: Гололёд',
            detailRu: 'При переохлаждённых осадках возможно образование ледяной корки.'
        };
    } else if (hasBlizzard) {
        roadRisk = {
            level: 'severe',
            code: 'blizzard',
            labelRu: 'Опасно: Метель / Заносы',
            detailRu: `Снег ${snowMm.toFixed(1)} мм при порывах до ${gustMs.toFixed(1)} м/с: перемёты и падение видимости на трассе.`
        };
    } else if (frostCrossZero && (precipMm >= 0.3 || roadSnowDepth >= 0.5 || (!day.dataQuality.humidityEstimated && humidity >= 78))) {
        roadRisk = {
            level: 'high',
            code: 'black_ice',
            labelRu: 'Высокий риск: Гололедица',
            detailRu: `Переход через 0°C (${formatSignedC(minC)}..${formatSignedC(maxC)}) при влажном покрытии — утренний чёрный лёд.`
        };
    } else if (snowMm >= 2.5 || (gustMs >= 14 && roadSnowDepth >= 3)) {
        roadRisk = {
            level: 'high',
            code: 'snow_pack',
            labelRu: 'Высокий риск: Снежный накат',
            detailRu: `Снегопад (${snowMm.toFixed(1)} мм) и ветер до ${gustMs.toFixed(1)} м/с — удлинение тормозного пути.`
        };
    } else if (frostCrossZero || (precipMm >= 1.0 && minC <= 1.5) || gustMs >= 11.5) {
        roadRisk = {
            level: 'moderate',
            code: 'caution',
            labelRu: 'Умеренный риск',
            detailRu: frostCrossZero
                ? 'Суточный переход через 0°C: возможна локальная наледь на спусках и мостах.'
                : `Порывы до ${gustMs.toFixed(1)} м/с или сырые осадки: контроль дистанции.`
        };
    } else {
        roadRisk = {
            level: 'low',
            code: 'clear',
            labelRu: 'Низкий расчётный риск',
            detailRu: 'По модели для Абана пороги риска гололедицы, снега и сильного ветра за эти сутки не достигнуты.'
        };
    }

    // 2. Diesel Cold-Filterability Grade (accounting for basin cold-air pooling)
    const valleyMin = day?.inversion?.active ? toFiniteNumber(day.inversion.valleyMinC) : minC;
    const effMin = Math.min(minC, valleyMin ?? minC);
    let diesel;
    if (toFiniteNumber(day?.minC) === null) {
        diesel = { grade: 'Нет данных', cutoffC: null, noteRu: 'Для подбора топлива нужен ночной минимум.' };
    } else if (effMin <= -32) {
        diesel = {
            grade: 'Арктическое (А-45)',
            cutoffC: -45,
            noteRu: `Выхолаживание до ${formatSignedC(effMin)}: необходимо арктическое ДТ (ПТФ −45°C) и подогрев топливной рампы.`
        };
    } else if (effMin <= -18) {
        diesel = {
            grade: 'Зимнее (З-32)',
            cutoffC: -32,
            noteRu: `Ночной минимум ${formatSignedC(effMin)}: требуется зимнее ДТ класс 2 (до −32°C), контроль парафинизации.`
        };
    } else if (effMin <= -5) {
        diesel = {
            grade: 'Зимнее (З-20)',
            cutoffC: -20,
            noteRu: `Мороз до ${formatSignedC(effMin)}: переход на зимнее ДТ (−20°C), исключить остатки летнего топлива.`
        };
    } else if (effMin <= 2) {
        diesel = {
            grade: 'Межсезонное (Е-15)',
            cutoffC: -15,
            noteRu: `Околонулевой фон (${formatSignedC(effMin)}): рекомендуется межсезонное ДТ (−15°C) с запасом на утренник.`
        };
    } else {
        diesel = {
            grade: 'Летнее (Л-5)',
            cutoffC: -5,
            noteRu: `Устойчивый плюс (мин. ${formatSignedC(effMin)}): допускается штатное летнее ДТ.`
        };
    }

    // 3. 4-Layer Soil Profile & Ground Trafficability (0, 6, 18, 54 cm)
    const s0 = toFiniteNumber(day?.soil0C ?? day?.soilTempC) ?? +((maxC + minC) * 0.35).toFixed(1);
    const s6 = toFiniteNumber(day?.soil6C) ?? +(s0 * 0.85 + 0.3).toFixed(1);
    const s18 = toFiniteNumber(day?.soil18C) ?? +(s6 * 0.8 + 0.6).toFixed(1);
    const s54 = toFiniteNumber(day?.soil54C) ?? +(s18 * 0.7 + 1.4).toFixed(1);

    let freezeDepthCm = 0;
    let stateCode;
    let labelRu;
    let detailRu;

    const recentRainSum = (Array.isArray(prevDays) ? prevDays.slice(-3) : []).reduce(
        (acc, d) => acc + (toFiniteNumber(d?.precipMm) ?? 0),
        precipMm
    );

    if (toFiniteNumber(day?.soil0C ?? day?.soilTempC) === null &&
        (toFiniteNumber(day?.minC) === null || toFiniteNumber(day?.maxC) === null)) {
        freezeDepthCm = null;
        stateCode = 'unknown';
        labelRu = 'Нет данных о грунте';
        detailRu = 'Недостаточно температурных данных для оценки промерзания.';
    } else if (s54 <= 0) {
        freezeDepthCm = Math.round(54 + clamp(Math.abs(s54) * 9, 0, 75));
        stateCode = 'frozen_solid';
        labelRu = `Грунт промёрз (${freezeDepthCm} см)`;
        detailRu = `Отрицательная температура на всех горизонтах до 54 см (${formatSignedC(s54)}): высокая несущая способность для техники.`;
    } else if (s18 <= 0) {
        const frac = (-s18) / (-s18 + Math.max(0.1, s54));
        freezeDepthCm = Math.round(18 + 36 * frac);
        stateCode = 'frozen_crust';
        labelRu = `Промерзание ${freezeDepthCm} см`;
        detailRu = `Корка 0–18 см прочная (${formatSignedC(s18)}), на 54 см ${formatSignedC(s54)}: проезд тяжёлой техники стабилен.`;
    } else if (s6 <= 0) {
        const frac = (-s6) / (-s6 + Math.max(0.1, s18));
        freezeDepthCm = Math.round(6 + 12 * frac);
        stateCode = 'frozen_top';
        labelRu = `Мёрзлый верхний слой (${freezeDepthCm} см)`;
        detailRu = `Промёрзло до ${freezeDepthCm} см (6 см: ${formatSignedC(s6)}), ниже 18 см талый грунт (${formatSignedC(s18)}).`;
    } else if (s0 <= 0) {
        const frac = (-s0) / (-s0 + Math.max(0.1, s6));
        freezeDepthCm = Math.max(1, Math.round(6 * frac));
        stateCode = 'night_crust';
        labelRu = `Поверхностная корка (${freezeDepthCm} см)`;
        detailRu = `Схвачен только верхний горизонт (${formatSignedC(s0)}), на 6 см ${formatSignedC(s6)} — возможен продавливаемый наст.`;
    } else if ((s0 > 0 && s0 <= 3.5 && (recentRainSum >= 6 || snowDepthCm >= 1)) || recentRainSum >= 15) {
        freezeDepthCm = 0;
        stateCode = 'mud_thaw';
        labelRu = 'Оттаивание / Распутица';
        detailRu = `Верхний слой влажный (${formatSignedC(s0)}, сумма осадков ${recentRainSum.toFixed(1)} мм): риск колеи на полевых дорогах.`;
    } else {
        freezeDepthCm = 0;
        stateCode = 'firm_thawed';
        labelRu = 'Талый устойчивый грунт';
        detailRu = `Профиль 0–54 см прогрет (${formatSignedC(s0)} .. ${formatSignedC(s54)}), переувлажнения нет.`;
    }

    return {
        roadRisk,
        diesel,
        ground: { freezeDepthCm, stateCode, labelRu, detailRu },
        frostCrossZero
    };
}
