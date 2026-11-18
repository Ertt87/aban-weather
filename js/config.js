// ============================================================================
// ABAN METEO v4 — CONFIGURATION, CLIMATOLOGY & OFFLINE REFERENCE DATASET
// Station: п. Абан, Красноярский край (WMO 29485, 56.68°N, 96.07°E, 246m)
// ============================================================================

export const ABAN_COORDS = {
    name: 'п. Абан',
    region: 'Красноярский край',
    wmoId: '29485',
    lat: 56.68,
    lon: 96.07,
    elev: 246,
    tz: 'Asia/Krasnoyarsk',
    utcOffsetHours: 7
};

export const STORAGE_KEYS = {
    CACHE_V4: 'aban_weather_cache_v4',
    GOOGLE_API_KEY: 'aban_wn3_api_key',
    LEGACY_API_KEY: 'aban_google_wn3_api_key',
    PREFS: 'aban_ui_prefs_v4',
    MOS_CACHE: 'aban_mos_calibration_v4',
    ARCHIVE_LRU: 'aban_archive_lru_v4'
};

export const MODEL_META = {
    google_wn3: {
        id: 'google_wn3',
        name: 'Google WeatherNext 3',
        shortName: 'WN3',
        color: '#c084fc',
        weights: { short48h: 0.28, med10d: 0.30, ext16d: 0.0 }
    },
    ecmwf_aifs025: {
        id: 'ecmwf_aifs025',
        name: 'ECMWF AIFS 0.25° (AI)',
        shortName: 'AIFS',
        color: '#22d3ee',
        weights: { short48h: 0.23, med10d: 0.25, ext16d: 0.34 }
    },
    ecmwf_ifs025: {
        id: 'ecmwf_ifs025',
        name: 'ECMWF IFS 0.25°',
        shortName: 'IFS',
        color: '#34d399',
        weights: { short48h: 0.22, med10d: 0.24, ext16d: 0.36 }
    },
    icon_seamless: {
        id: 'icon_seamless',
        name: 'DWD ICON Seamless',
        shortName: 'ICON',
        color: '#fbbf24',
        weights: { short48h: 0.14, med10d: 0.10, ext16d: 0.08 }
    },
    met_no: {
        id: 'met_no',
        name: 'MET Norway Global',
        shortName: 'MET.no',
        color: '#f472b6',
        weights: { short48h: 0.07, med10d: 0.04, ext16d: 0.0 }
    },
    gfs_seamless: {
        id: 'gfs_seamless',
        name: 'NOAA GFS Seamless',
        shortName: 'GFS',
        color: '#fb7185',
        weights: { short48h: 0.06, med10d: 0.07, ext16d: 0.22 }
    }
};

export const TIME_WINDOWS = {
    full: {
        id: 'full',
        label: '24 часа (00:00–23:00)',
        shortLabel: '00–24ч',
        isHourActive: () => true
    },
    day_shift: {
        id: 'day_shift',
        label: 'Дневная смена (08:00–20:00)',
        shortLabel: '08–20ч',
        isHourActive: (h) => h >= 8 && h <= 20
    },
    daylight: {
        id: 'daylight',
        label: 'Световой день (астрономия Абана)',
        shortLabel: 'Световой',
        isHourActive: (h, day) => {
            const sr = Number.isFinite(day?.astronomy?.sunriseHour) ? day.astronomy.sunriseHour : 7;
            const ss = Number.isFinite(day?.astronomy?.sunsetHour) ? day.astronomy.sunsetHour : 18;
            return h >= sr && h <= ss;
        }
    },
    night: {
        id: 'night',
        label: 'Ночь (20:00–08:00)',
        shortLabel: '20–08ч',
        isHourActive: (h) => h >= 20 || h <= 8
    }
};

// ============================================================================
// WMO 29485 ABAN (1991–2020) 2-HARMONIC SMOOTH CLIMATOLOGY
// Fitted to normals: Jan -15.2/-24.5, Apr +6.8/-4.8, Jul +25.6/+12.4,
//                    Oct +4.8/-4.2, Nov -6.5/-14.5
// ============================================================================
const OMEGA = (2 * Math.PI) / 365;
const SNOW_SEASON_NORM = Math.pow(1.7 / 2.45, 1.7) * Math.pow(0.75 / 2.45, 0.75);

function getDayOfYear(dateIso) {
    if (dateIso instanceof Date && !Number.isNaN(dateIso.getTime())) {
        const start = Date.UTC(dateIso.getUTCFullYear(), 0, 0);
        return Math.max(1, Math.min(366, Math.floor((dateIso.getTime() - start) / 86400000)));
    }
    const str = String(dateIso || '').slice(0, 10);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (match) {
        const y = Number(match[1]);
        const m = Number(match[2]) - 1;
        const d = Number(match[3]);
        const utc = Date.UTC(y, m, d);
        const start = Date.UTC(y, 0, 0);
        return Math.max(1, Math.min(366, Math.round((utc - start) / 86400000)));
    }
    const now = new Date(Date.now() + ABAN_COORDS.utcOffsetHours * 3600000);
    const start = Date.UTC(now.getUTCFullYear(), 0, 0);
    return Math.max(1, Math.min(366, Math.floor((now.getTime() - start) / 86400000)));
}

/**
 * Smooth 2-harmonic daily climatological normals for п. Абан (WMO 29485, 1991–2020).
 * @param {string|Date} dateIso - Date in 'YYYY-MM-DD' format
 * @returns {{ climMaxC: number, climMinC: number, climMeanC: number, climPrecipMm: number, climSnowDepthCm: number }}
 */
export function getAbanClimatology(dateIso) {
    const doy = getDayOfYear(dateIso);
    const c1 = Math.cos(OMEGA * doy);
    const s1 = Math.sin(OMEGA * doy);
    const c2 = Math.cos(2 * OMEGA * doy);
    const s2 = Math.sin(2 * OMEGA * doy);

    const climMaxC = +(5.5326 - 20.0782 * c1 - 3.9138 * s1 - 0.7790 * c2 + 0.7226 * s2).toFixed(1);
    const climMinC = +(-5.2362 - 17.8576 * c1 - 4.7024 * s1 - 0.9610 * c2 + 0.0773 * s2).toFixed(1);
    const climMeanC = +((climMaxC + climMinC) / 2).toFixed(1);

    // Continental forest-steppe daily precipitation normal (~445 mm/year)
    const rawPrecip = 1.32 - 0.90 * Math.cos(OMEGA * (doy - 19)) + 0.18 * Math.cos(2 * OMEGA * (doy - 19));
    const climPrecipMm = +Math.max(0.42, rawPrecip).toFixed(2);

    // Snow cover season in Aban: mid-October (~DOY 286) through late April (~DOY 114)
    let climSnowDepthCm = 0;
    if (doy >= 286 || doy <= 114) {
        const span = 365 - 286 + 114; // 193 days
        const x = doy >= 286 ? doy - 286 : doy + 365 - 286;
        const u = Math.max(0, Math.min(1, x / span));
        const bell = (Math.pow(u, 1.7) * Math.pow(1 - u, 0.75)) / SNOW_SEASON_NORM;
        climSnowDepthCm = +Math.max(0, Math.min(41, 39.0 * bell)).toFixed(1);
    }

    return { climMaxC, climMinC, climMeanC, climPrecipMm, climSnowDepthCm };
}

// ============================================================================
// COLD OFFLINE FALLBACK ONLY (REFERENCE_DATASET v4)
// NEVER merged into live API payloads. Used solely when offline & cache is empty.
// ============================================================================
const REF_DIR_MAP = {
    'С': 'Северный', 'СВ': 'Северо-Восточный', 'В': 'Восточный', 'ЮВ': 'Юго-Восточный',
    'Ю': 'Южный', 'ЮЗ': 'Юго-Западный', 'З': 'Западный', 'СЗ': 'Северо-Западный'
};

const REF_PROFILES = [
    { isoDate: '2026-10-17', dayShort: 'Сб', dateStr: '17 окт', label: 'Вчера (Архив)', maxC: 3.9, minC: -5.0, humidity: 72, uv: 1, precipDay: 5, precipNight: 0, precipMm: 0.0, rainMm: 0.0, snowMm: 0.0, snowDepthCm: 0.0, windMs: 2.7, gustMs: 5.1, windDeg: 135, windDirShort: 'ЮВ', soil0C: 0.2, soil6C: 0.9, soil18C: 2.2, soil54C: 4.9, dewPointC: -4.1, cloudCoverPct: 14, pressureStationHpa: 1006, dayCond: 'Ясно (Антициклон)', dayCondEn: 'Sunny', nightCond: 'Ясно, морозно', nightCondEn: 'Clear', iconType: 'sunny', nightIconType: 'clear-night', precipDayType: 'снег', precipNightType: 'снег' },
    { isoDate: '2026-10-18', dayShort: 'Вс', dateStr: '18 окт', label: 'Сегодня', maxC: 5.6, minC: -3.9, humidity: 68, uv: 1, precipDay: 5, precipNight: 5, precipMm: 0.0, rainMm: 0.0, snowMm: 0.0, snowDepthCm: 0.0, windMs: 3.1, gustMs: 6.0, windDeg: 135, windDirShort: 'ЮВ', soil0C: 0.9, soil6C: 1.4, soil18C: 2.6, soil54C: 4.8, dewPointC: -3.0, cloudCoverPct: 12, pressureStationHpa: 1004, dayCond: 'Ясно', dayCondEn: 'Sunny', nightCond: 'Ясно с прояснениями', nightCondEn: 'Mostly clear', iconType: 'sunny', nightIconType: 'clear-night', precipDayType: 'снег', precipNightType: 'снег' },
    { isoDate: '2026-10-19', dayShort: 'Пн', dateStr: '19 окт', label: 'Завтра', maxC: 7.8, minC: 0.6, humidity: 58, uv: 1, precipDay: 0, precipNight: 5, precipMm: 0.0, rainMm: 0.0, snowMm: 0.0, snowDepthCm: 0.0, windMs: 4.5, gustMs: 8.4, windDeg: 225, windDirShort: 'ЮЗ', soil0C: 2.3, soil6C: 2.0, soil18C: 2.7, soil54C: 4.7, dewPointC: -0.9, cloudCoverPct: 24, pressureStationHpa: 999, dayCond: 'Ясно и тепло', dayCondEn: 'Sunny & Warm', nightCond: 'Переменная облачность', nightCondEn: 'Partly cloudy', iconType: 'sunny', nightIconType: 'partly-cloudy-night', precipDayType: 'дождь', precipNightType: 'дождь' },
    { isoDate: '2026-10-20', dayShort: 'Вт', dateStr: '20 окт', label: 'Вт', maxC: 6.1, minC: 1.1, humidity: 63, uv: 1, precipDay: 10, precipNight: 15, precipMm: 0.4, rainMm: 0.4, snowMm: 0.0, snowDepthCm: 0.0, windMs: 5.4, gustMs: 9.8, windDeg: 225, windDirShort: 'ЮЗ', soil0C: 2.6, soil6C: 2.4, soil18C: 2.9, soil54C: 4.6, dewPointC: 0.2, cloudCoverPct: 48, pressureStationHpa: 994, dayCond: 'Малооблачно', dayCondEn: 'Mostly sunny', nightCond: 'Облачно с прояснениями', nightCondEn: 'Mostly cloudy', iconType: 'mostly-sunny', nightIconType: 'partly-cloudy-night', precipDayType: 'дождь', precipNightType: 'дождь' },
    { isoDate: '2026-10-21', dayShort: 'Ср', dateStr: '21 окт', label: 'Ср', maxC: 4.4, minC: -2.8, humidity: 74, uv: 0, precipDay: 30, precipNight: 25, precipMm: 1.8, rainMm: 1.1, snowMm: 0.7, snowDepthCm: 0.5, windMs: 6.7, gustMs: 11.8, windDeg: 225, windDirShort: 'ЮЗ', soil0C: 1.5, soil6C: 1.9, soil18C: 2.8, soil54C: 4.5, dewPointC: -1.1, cloudCoverPct: 86, pressureStationHpa: 989, dayCond: 'Облачно, небольшой дождь', dayCondEn: 'Light rain', nightCond: 'Переход в снег', nightCondEn: 'Rain to snow', iconType: 'rain-cloudy', nightIconType: 'snow', precipDayType: 'дождь', precipNightType: 'снег' },
    { isoDate: '2026-10-22', dayShort: 'Чт', dateStr: '22 окт', label: 'Чт', maxC: 1.1, minC: -6.1, humidity: 71, uv: 0, precipDay: 15, precipNight: 10, precipMm: 0.5, rainMm: 0.0, snowMm: 0.5, snowDepthCm: 1.0, windMs: 4.9, gustMs: 8.6, windDeg: 225, windDirShort: 'ЮЗ', soil0C: -0.4, soil6C: 0.8, soil18C: 2.3, soil54C: 4.4, dewPointC: -4.8, cloudCoverPct: 54, pressureStationHpa: 997, dayCond: 'Переменная облачность', dayCondEn: 'Partly sunny', nightCond: 'Ясно, выхолаживание', nightCondEn: 'Clear & Cold', iconType: 'partly-sunny', nightIconType: 'clear-night', precipDayType: 'снег', precipNightType: 'снег' },
    { isoDate: '2026-10-23', dayShort: 'Пт', dateStr: '23 окт', label: 'Пт', maxC: 2.8, minC: -3.3, humidity: 75, uv: 0, precipDay: 10, precipNight: 10, precipMm: 0.3, rainMm: 0.0, snowMm: 0.3, snowDepthCm: 1.1, windMs: 4.5, gustMs: 7.9, windDeg: 225, windDirShort: 'ЮЗ', soil0C: -0.1, soil6C: 0.6, soil18C: 2.0, soil54C: 4.3, dewPointC: -3.2, cloudCoverPct: 62, pressureStationHpa: 1001, dayCond: 'Переменная облачность', dayCondEn: 'Partly sunny', nightCond: 'Облачно с прояснениями', nightCondEn: 'Mostly cloudy', iconType: 'partly-sunny', nightIconType: 'partly-cloudy-night', precipDayType: 'снег', precipNightType: 'снег' },
    { isoDate: '2026-10-24', dayShort: 'Сб', dateStr: '24 окт', label: 'Сб (Вых.)', maxC: 1.7, minC: -4.4, humidity: 82, uv: 0, precipDay: 35, precipNight: 25, precipMm: 1.6, rainMm: 0.0, snowMm: 1.6, snowDepthCm: 2.4, windMs: 5.2, gustMs: 9.4, windDeg: 270, windDirShort: 'З', soil0C: -0.3, soil6C: 0.4, soil18C: 1.8, soil54C: 4.2, dewPointC: -3.6, cloudCoverPct: 88, pressureStationHpa: 993, dayCond: 'Небольшой снег', dayCondEn: 'Light snow', nightCond: 'Снежные заряды', nightCondEn: 'Snow showers', iconType: 'snow', nightIconType: 'snow', precipDayType: 'снег', precipNightType: 'снег' },
    { isoDate: '2026-10-25', dayShort: 'Вс', dateStr: '25 окт', label: 'Вс (Вых.)', maxC: 0.6, minC: -6.7, humidity: 74, uv: 1, precipDay: 10, precipNight: 5, precipMm: 0.1, rainMm: 0.0, snowMm: 0.1, snowDepthCm: 2.4, windMs: 3.6, gustMs: 6.5, windDeg: 315, windDirShort: 'СЗ', soil0C: -0.8, soil6C: 0.1, soil18C: 1.5, soil54C: 4.0, dewPointC: -5.4, cloudCoverPct: 28, pressureStationHpa: 1005, dayCond: 'Малооблачно', dayCondEn: 'Mostly sunny', nightCond: 'Морозно и ясно', nightCondEn: 'Clear & Frosty', iconType: 'mostly-sunny', nightIconType: 'clear-night', precipDayType: 'снег', precipNightType: 'снег' },
    { isoDate: '2026-10-26', dayShort: 'Пн', dateStr: '26 окт', label: 'Пн', maxC: 2.2, minC: -3.9, humidity: 76, uv: 1, precipDay: 15, precipNight: 15, precipMm: 0.4, rainMm: 0.0, snowMm: 0.4, snowDepthCm: 2.5, windMs: 4.1, gustMs: 7.4, windDeg: 270, windDirShort: 'З', soil0C: -0.5, soil6C: 0.1, soil18C: 1.4, soil54C: 3.9, dewPointC: -3.8, cloudCoverPct: 58, pressureStationHpa: 1002, dayCond: 'Переменная облачность', dayCondEn: 'Partly sunny', nightCond: 'Облачно с прояснениями', nightCondEn: 'Mostly cloudy', iconType: 'partly-sunny', nightIconType: 'partly-cloudy-night', precipDayType: 'снег', precipNightType: 'снег' },
    { isoDate: '2026-10-27', dayShort: 'Вт', dateStr: '27 окт', label: 'Вт', maxC: 1.1, minC: -5.0, humidity: 80, uv: 0, precipDay: 25, precipNight: 20, precipMm: 1.1, rainMm: 0.0, snowMm: 1.1, snowDepthCm: 3.3, windMs: 4.4, gustMs: 8.1, windDeg: 270, windDirShort: 'З', soil0C: -0.6, soil6C: 0.0, soil18C: 1.3, soil54C: 3.8, dewPointC: -4.2, cloudCoverPct: 82, pressureStationHpa: 998, dayCond: 'Облачно с прояснениями', dayCondEn: 'Mostly cloudy', nightCond: 'Небольшой снег', nightCondEn: 'Light snow', iconType: 'cloudy-snow', nightIconType: 'snow', precipDayType: 'снег', precipNightType: 'снег' }
];

function buildReferenceDays() {
    const toF = (c) => Math.round((c * 9) / 5 + 32);
    const toMph = (ms) => Math.round(ms * 2.23694);
    const toMm = (hpa) => Math.round(hpa * 0.750062);
    const diurnalShape = [
        0.22, 0.16, 0.11, 0.07, 0.03, 0.0, 0.02, 0.12,
        0.28, 0.46, 0.64, 0.80, 0.92, 0.98, 1.0, 0.96,
        0.86, 0.72, 0.56, 0.44, 0.36, 0.31, 0.27, 0.24
    ];

    return REF_PROFILES.map((p, idx) => {
        const offset = idx - 1;
        const isArchive = offset < 0;
        const clim = getAbanClimatology(p.isoDate);
        const stationMm = toMm(p.pressureStationHpa);
        const mslHpa = Math.round(p.pressureStationHpa / Math.exp((-0.034163 * ABAN_COORDS.elev) / (273.15 + (p.maxC + p.minC) / 2 + 0.00325 * ABAN_COORDS.elev)));
        const mslMm = toMm(mslHpa);
        const prevStationMm = idx > 0 ? toMm(REF_PROFILES[idx - 1].pressureStationHpa) : stationMm;
        const spread = isArchive ? 0 : +(0.5 + offset * 0.12).toFixed(1);
        const sunriseHour = +(7.52 + idx * 0.03).toFixed(2);
        const sunsetHour = +(17.65 - idx * 0.035).toFixed(2);
        const fmtHm = (hr) => {
            const h = Math.floor(hr);
            const m = Math.round((hr - h) * 60);
            return `${String(h).padStart(2, '0')}:${String(m === 60 ? 59 : m).padStart(2, '0')}`;
        };

        const hours = diurnalShape.map((w, h) => {
            const tempC = +(p.minC + w * (p.maxC - p.minC)).toFixed(1);
            const windMs = +(p.windMs * (0.76 + 0.34 * w)).toFixed(1);
            const gustMs = +(p.gustMs * (0.76 + 0.34 * w)).toFixed(1);
            const feelsC = +(tempC <= 10 && windMs >= 1.3
                ? 13.12 + 0.6215 * tempC - 11.37 * Math.pow(windMs * 3.6, 0.16) + 0.3965 * tempC * Math.pow(windMs * 3.6, 0.16)
                : tempC - 1.8).toFixed(1);
            const hum = Math.round(Math.min(96, Math.max(38, p.humidity + (1 - w) * 14 - w * 10)));
            const isDay = h >= sunriseHour && h <= sunsetHour;
            const slotPrecipProb = isDay ? p.precipDay : p.precipNight;
            const slotPrecipMm = p.precipMm > 0 && ((isDay && p.precipDay >= 15) || (!isDay && p.precipNight >= 15))
                ? +(p.precipMm / 12).toFixed(2)
                : 0;
            const phase = slotPrecipMm <= 0 ? 'dry' : (tempC <= 0.5 ? 'snow' : 'rain');
            return {
                hour: h,
                hourStr: `${String(h).padStart(2, '0')}:00`,
                tempC,
                tempF: toF(tempC),
                feelsC,
                wetBulbC: +(tempC - (100 - hum) * 0.07).toFixed(1),
                dewPointC: p.dewPointC,
                humidity: hum,
                precipMm: slotPrecipMm,
                precipProb: slotPrecipProb,
                precipPhase: phase,
                windMs,
                windMph: toMph(windMs),
                gustMs,
                windDirShort: p.windDirShort,
                pressureStationMm: stationMm,
                pressureMslMm: mslMm,
                cloudCoverPct: p.cloudCoverPct,
                soil0C: +(p.soil0C + (w - 0.5) * 0.8).toFixed(1),
                iconType: isDay ? p.iconType : p.nightIconType
            };
        });

        const invActive = p.cloudCoverPct <= 30 && p.windMs <= 3.6;
        const invDelta = invActive ? +(2.2 * (p.snowDepthCm > 0 ? 1.25 : 1.0)).toFixed(1) : 0;
        const nextProf = REF_PROFILES[idx + 1] || p;

        return {
            id: `day_${p.isoDate}`,
            idx,
            isoDate: p.isoDate,
            offsetFromToday: offset,
            dayShort: p.dayShort,
            dateStr: p.dateStr,
            fullDateLabel: `${p.dayShort}, ${p.dateStr} 2026${isArchive ? ' (Архив)' : offset === 0 ? ' (Сегодня)' : ''}`,
            label: p.label,
            zone: isArchive ? 'archive' : 'deterministic',
            confidencePct: isArchive ? 99 : Math.round(93 - offset * 1.6),
            isArchive,
            dayCond: p.dayCond,
            dayCondEn: p.dayCondEn,
            nightCond: p.nightCond,
            nightCondEn: p.nightCondEn,
            iconType: p.iconType,
            nightIconType: p.nightIconType,
            maxC: p.maxC,
            maxF: toF(p.maxC),
            minC: p.minC,
            minF: toF(p.minC),
            maxP10C: +(p.maxC - spread).toFixed(1),
            maxP25C: +(p.maxC - spread * 0.5).toFixed(1),
            maxP75C: +(p.maxC + spread * 0.5).toFixed(1),
            maxP90C: +(p.maxC + spread).toFixed(1),
            minP10C: +(p.minC - spread).toFixed(1),
            minP25C: +(p.minC - spread * 0.5).toFixed(1),
            minP75C: +(p.minC + spread * 0.5).toFixed(1),
            minP90C: +(p.minC + spread).toFixed(1),
            climMaxC: clim.climMaxC,
            climMinC: clim.climMinC,
            climAnomalyC: +((((p.maxC + p.minC) / 2) - clim.climMeanC)).toFixed(1),
            humidity: p.humidity,
            uv: p.uv,
            precipDay: p.precipDay,
            precipNight: p.precipNight,
            precipDayType: p.precipDayType,
            precipNightType: p.precipNightType,
            precipMm: p.precipMm,
            precipP75Mm: +(p.precipMm * 1.35).toFixed(1),
            rainMm: p.rainMm,
            snowMm: p.snowMm,
            snowDepthCm: p.snowDepthCm,
            precipPhase: p.precipMm <= 0 ? 'dry' : (p.snowMm >= p.rainMm ? 'snow' : 'rain'),
            windMs: p.windMs,
            windMph: toMph(p.windMs),
            gustMs: p.gustMs,
            gustMph: toMph(p.gustMs),
            windDirShort: p.windDirShort,
            windDirFull: REF_DIR_MAP[p.windDirShort] || 'Западный',
            windDeg: p.windDeg,
            soil0C: p.soil0C,
            soil6C: p.soil6C,
            soil18C: p.soil18C,
            soil54C: p.soil54C,
            soilTempC: p.soil0C,
            dewPointC: p.dewPointC,
            cloudCoverPct: p.cloudCoverPct,
            pressureStationHpa: p.pressureStationHpa,
            pressureStationMm: stationMm,
            pressureMslHpa: mslHpa,
            pressureMslMm: mslMm,
            deltaP24hMm: stationMm - prevStationMm,
            astronomy: {
                sunriseStr: fmtHm(sunriseHour),
                sunsetStr: fmtHm(sunsetHour),
                dawnStr: fmtHm(sunriseHour - 0.65),
                duskStr: fmtHm(sunsetHour + 0.65),
                sunriseHour,
                sunsetHour,
                daylightHours: +(sunsetHour - sunriseHour).toFixed(2)
            },
            inversion: {
                active: invActive,
                deltaC: invDelta,
                valleyMinC: +(p.minC - invDelta).toFixed(1),
                noteRu: invActive
                    ? `Ясная тихая ночь в Абанской котловине: возможно выхолаживание на ${invDelta.toFixed(1)}°C ниже`
                    : 'Перемешивание воздуха: котловинная инверсия ослаблена'
            },
            nextNightMinC: nextProf.minC,
            nextNightMinF: toF(nextProf.minC),
            nextNightMaxC: +(nextProf.minC + 2.5).toFixed(1),
            nextNightMaxF: toF(nextProf.minC + 2.5),
            nextNightPrecipProb: p.precipNight,
            nextNightPrecipMm: +(p.precipMm * 0.4).toFixed(1),
            nextNightPrecipType: p.precipNightType,
            nextNightWindMs: +(p.windMs * 0.85).toFixed(1),
            nextNightGustMs: +(p.gustMs * 0.85).toFixed(1),
            nextNightWindDirShort: p.windDirShort,
            nextNightCond: p.nightCond,
            nextNightIconType: p.nightIconType,
            probFrostBelowMinus20: p.minC <= -20 ? 85 : 0,
            probSnowOver5mm: p.snowMm >= 5 ? 70 : (p.snowMm >= 1.5 ? 18 : 2),
            modelBreakdown: {
                google_wn3: { maxC: p.maxC, minC: p.minC, precipMm: p.precipMm, windMs: p.windMs }
            },
            hours
        };
    });
}

export const REFERENCE_DATASET = {
    version: 4,
    sourceType: 'reference_wn3',
    sourceLabel: 'Эталон WeatherNext 3 (Офлайн, Абан)',
    syncedAt: '18.10.2026, 10:00 (UTC+7)',
    latencyMs: 0,
    activeModels: ['google_wn3'],
    mos: {
        models: {},
        bestModelId: null,
        summaryRu: 'Автономный эталон WeatherNext 3 (подключите сеть или API-ключ для калибровки MOS)'
    },
    airQuality: {
        pm25: 6.4,
        pm10: 12.1,
        co: 215,
        aqi: 18,
        statusRu: 'Отличный',
        smogRisk: 'low'
    },
    current: {
        tempC: 4.8,
        tempF: 41,
        feelsC: 1.9,
        feelsF: 35,
        wetBulbC: 2.3,
        condRu: 'Ясно (Антициклон)',
        iconType: 'sunny',
        windMs: 3.1,
        windMph: 7,
        gustMs: 6.0,
        gustMph: 13,
        windDeg: 135,
        windDirShort: 'ЮВ',
        precipProb: 5,
        precipMm: 0.0,
        precipPhase: 'dry',
        snowDepthCm: 0.0,
        humidity: 68,
        dewPointC: -0.6,
        cloudCoverPct: 12,
        soil0C: 0.9,
        soil6C: 1.4,
        soil18C: 2.6,
        soil54C: 4.8,
        pressureStationHpa: 1004,
        pressureStationMm: 753,
        pressureMslHpa: 1035,
        pressureMslMm: 776,
        deltaP3hMm: -1,
        deltaP24hMm: -2,
        uv: 1,
        obsTimeLabel: 'Вс, 18 октября 2026 • 10:00 (UTC+7)'
    },
    controlPoint: {
        targetLabel: 'Смена 20:00',
        tempC: 0.2,
        tempF: 32,
        feelsC: -3.2,
        condRu: 'Ясно, прохладно',
        badgeRu: 'Ясно',
        iconType: 'clear-night',
        precipProb: 5,
        windMs: 2.8,
        windMph: 6,
        windDirShort: 'ЮВ',
        soil0C: 0.5,
        next3hLabel: 'Через 3 ч (13:00)',
        next3hTempC: 5.2
    },
    days: buildReferenceDays()
};
