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
// DYNAMIC SEASONAL COLD-OFFLINE FALLBACK (REFERENCE_DATASET v4)
// NEVER merged into live API payloads. Anchored on today's date in Aban (UTC+7)
// using WMO 29485 2-harmonic climatology so winter/summer starts stay realistic.
// ============================================================================
const REF_DIR_MAP = {
    'С': 'Северный', 'СВ': 'Северо-Восточный', 'В': 'Восточный', 'ЮВ': 'Юго-Восточный',
    'Ю': 'Южный', 'ЮЗ': 'Юго-Западный', 'З': 'Западный', 'СЗ': 'Северо-Западный'
};

const REF_WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const REF_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function getAbanNowIsoAndHour() {
    try {
        const now = new Date();
        const isoDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: ABAN_COORDS.tz || 'Asia/Krasnoyarsk',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(now);
        const hourStr = new Intl.DateTimeFormat('en-GB', {
            timeZone: ABAN_COORDS.tz || 'Asia/Krasnoyarsk',
            hour: '2-digit',
            hour12: false
        }).format(now);
        return { isoDate, hour: Math.min(23, Math.max(0, Number(hourStr === '24' ? 0 : hourStr) || 12)) };
    } catch (_) {
        const d = new Date(Date.now() + ABAN_COORDS.utcOffsetHours * 3600000);
        return { isoDate: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
    }
}

function addDaysIsoUtc(isoDate, deltaDays) {
    const [y, m, d] = String(isoDate).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

function computeAbanRefAstronomy(isoDate) {
    const doy = getDayOfYear(isoDate);
    const gamma = ((2 * Math.PI) / 365) * (doy - 1);
    const eqTime =
        229.18 *
        (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
    const decl =
        0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
    const latRad = (ABAN_COORDS.lat * Math.PI) / 180;
    const haDeg = (zen) => {
        const cosH = Math.cos((zen * Math.PI) / 180) / (Math.cos(latRad) * Math.cos(decl)) - Math.tan(latRad) * Math.tan(decl);
        return (Math.acos(Math.max(-1, Math.min(1, cosH))) * 180) / Math.PI;
    };
    const noonMin = 720 - 4 * ABAN_COORDS.lon - eqTime + ABAN_COORDS.utcOffsetHours * 60;
    const haSun = haDeg(90.833);
    const haCiv = haDeg(96.0);
    const fmt = (hr) => {
        const w = ((hr % 24) + 24) % 24;
        let hh = Math.floor(w);
        let mm = Math.round((w - hh) * 60);
        if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
        return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };
    const sunriseHour = +((noonMin - 4 * haSun) / 60).toFixed(2);
    const sunsetHour = +((noonMin + 4 * haSun) / 60).toFixed(2);
    return {
        sunriseStr: fmt(sunriseHour),
        sunsetStr: fmt(sunsetHour),
        dawnStr: fmt((noonMin - 4 * haCiv) / 60),
        duskStr: fmt((noonMin + 4 * haCiv) / 60),
        sunriseHour,
        sunsetHour,
        daylightHours: +Math.max(0, sunsetHour - sunriseHour).toFixed(2)
    };
}

export function buildDynamicReferenceDataset(baseIsoDate = null) {
    const nowParts = getAbanNowIsoAndHour();
    const todayIso = baseIsoDate || nowParts.isoDate;
    const curHour = nowParts.hour;

    const toF = (c) => Math.round((c * 9) / 5 + 32);
    const toMph = (ms) => Math.round(ms * 2.23694);
    const toMm = (hpa) => Math.round(hpa * 0.750062);
    const diurnalShape = [
        0.22, 0.16, 0.11, 0.07, 0.03, 0.0, 0.02, 0.12,
        0.28, 0.46, 0.64, 0.80, 0.92, 0.98, 1.0, 0.96,
        0.86, 0.72, 0.56, 0.44, 0.36, 0.31, 0.27, 0.24
    ];
    const wavePattern = [-0.6, 0.0, 1.1, 0.4, -1.4, -2.1, -0.8, 0.3, 1.2, -0.5, -1.2];
    const windDirs = [
        { deg: 135, s: 'ЮВ' }, { deg: 135, s: 'ЮВ' }, { deg: 225, s: 'ЮЗ' },
        { deg: 225, s: 'ЮЗ' }, { deg: 225, s: 'ЮЗ' }, { deg: 270, s: 'З' },
        { deg: 225, s: 'ЮЗ' }, { deg: 270, s: 'З' }, { deg: 315, s: 'СЗ' },
        { deg: 270, s: 'З' }, { deg: 270, s: 'З' }
    ];

    const days = [];
    for (let idx = 0; idx < 11; idx++) {
        const offset = idx - 1;
        const isArchive = offset < 0;
        const isoDate = addDaysIsoUtc(todayIso, offset);
        const dtUtc = new Date(`${isoDate}T00:00:00Z`);
        const dow = dtUtc.getUTCDay();
        const dayShort = REF_WEEKDAYS[dow];
        const dateStr = `${dtUtc.getUTCDate()} ${REF_MONTHS[dtUtc.getUTCMonth()]}`;
        const year = dtUtc.getUTCFullYear();

        const clim = getAbanClimatology(isoDate);
        const wave = wavePattern[idx];
        const maxC = +(clim.climMaxC + wave).toFixed(1);
        const minC = +(clim.climMinC + wave * 0.9).toFixed(1);
        const meanC = +((maxC + minC) / 2).toFixed(1);

        const isWetDay = idx === 4 || idx === 7 || idx === 10;
        const precipMm = isWetDay ? +(Math.max(0.8, clim.climPrecipMm * 1.4)).toFixed(1) : (idx === 3 || idx === 6 ? 0.3 : 0.0);
        const precipDay = isWetDay ? 35 : (precipMm > 0 ? 15 : 5);
        const precipNight = isWetDay ? 25 : (precipMm > 0 ? 10 : 5);
        const isFreezing = meanC <= 0.5;
        const snowMm = isFreezing ? precipMm : 0.0;
        const rainMm = isFreezing ? 0.0 : precipMm;
        const snowDepthCm = +(Math.max(0, clim.climSnowDepthCm + (snowMm > 0 ? snowMm * 0.4 : 0))).toFixed(1);
        const precipPhase = precipMm <= 0 ? 'dry' : (isFreezing ? 'snow' : 'rain');
        const precipTypeRu = isFreezing ? 'снег' : 'дождь';

        const windMs = +(2.6 + (isWetDay ? 2.4 : 0.9) + (idx % 3) * 0.4).toFixed(1);
        const gustMs = +(windMs * 1.8).toFixed(1);
        const wDir = windDirs[idx];
        const cloudCoverPct = isWetDay ? 84 : (idx === 0 || idx === 1 || idx === 8 ? 16 : 52);
        const humidity = Math.round(Math.min(92, Math.max(44, isWetDay ? 82 : 68 + (isFreezing ? 8 : -4))));
        const dewPointC = +(meanC - (100 - humidity) / 5).toFixed(1);

        const mslHpa = Math.round(1019 - (isWetDay ? 11 : 0) + (idx === 0 || idx === 8 ? 9 : 0));
        const baroFactor = (0.034163 * ABAN_COORDS.elev) / Math.max(180, meanC + 273.15 + 0.00325 * ABAN_COORDS.elev);
        const stationHpa = Math.round(mslHpa * Math.exp(-baroFactor));
        const stationMm = toMm(stationHpa);
        const mslMm = toMm(mslHpa);

        const soil0C = +(meanC * 0.65).toFixed(1);
        const soil6C = +(soil0C * 0.8 + 0.4).toFixed(1);
        const soil18C = +(soil6C * 0.75 + 0.9).toFixed(1);
        const soil54C = +(soil18C * 0.6 + 1.8).toFixed(1);

        const astronomy = computeAbanRefAstronomy(isoDate);
        const uv = Math.max(0, Math.min(8, Math.round((astronomy.daylightHours - 6) * 0.5)));
        const spread = isArchive ? 0 : +(0.5 + offset * 0.14).toFixed(1);

        let dayCond = 'Переменная облачность';
        let nightCond = 'Облачно с прояснениями';
        let iconType = 'partly-sunny';
        let nightIconType = 'partly-cloudy-night';
        if (isWetDay) {
            dayCond = isFreezing ? 'Небольшой снег' : 'Небольшой дождь';
            nightCond = isFreezing ? 'Снежные заряды' : 'Дождь ночью';
            iconType = isFreezing ? 'snow' : 'rain-cloudy';
            nightIconType = isFreezing ? 'snow' : 'rain-cloudy';
        } else if (cloudCoverPct <= 25) {
            dayCond = 'Ясно (Антициклон)';
            nightCond = isFreezing ? 'Ясно, морозно' : 'Ясно';
            iconType = 'sunny';
            nightIconType = 'clear-night';
        }

        const hours = diurnalShape.map((w, h) => {
            const tempC = +(minC + w * (maxC - minC)).toFixed(1);
            const hWind = +(windMs * (0.76 + 0.34 * w)).toFixed(1);
            const hGust = +(gustMs * (0.76 + 0.34 * w)).toFixed(1);
            const feelsC = +(tempC <= 10 && hWind >= 1.3
                ? 13.12 + 0.6215 * tempC - 11.37 * Math.pow(hWind * 3.6, 0.16) + 0.3965 * tempC * Math.pow(hWind * 3.6, 0.16)
                : tempC - 0.8).toFixed(1);
            const hum = Math.round(Math.min(96, Math.max(38, humidity + (1 - w) * 12 - w * 10)));
            const isDay = h >= astronomy.sunriseHour && h <= astronomy.sunsetHour;
            const slotPrecipMm = precipMm > 0 && isWetDay && h >= 10 && h <= 18 ? +(precipMm / 9).toFixed(2) : 0;
            const phase = slotPrecipMm <= 0 ? 'dry' : (tempC <= 0.5 ? 'snow' : 'rain');
            return {
                hour: h,
                hourStr: `${String(h).padStart(2, '0')}:00`,
                tempC,
                tempF: toF(tempC),
                feelsC,
                wetBulbC: +(tempC - (100 - hum) * 0.07).toFixed(1),
                dewPointC,
                humidity: hum,
                precipMm: slotPrecipMm,
                precipProb: isDay ? precipDay : precipNight,
                precipPhase: phase,
                windMs: hWind,
                windMph: toMph(hWind),
                gustMs: hGust,
                windDirShort: wDir.s,
                pressureStationMm: stationMm,
                pressureMslMm: mslMm,
                cloudCoverPct,
                soil0C: +(soil0C + (w - 0.5) * 0.7).toFixed(1),
                iconType: isDay ? iconType : nightIconType
            };
        });

        const invActive = cloudCoverPct <= 30 && windMs <= 3.6;
        const invDelta = invActive ? +(2.2 * (snowDepthCm > 0 ? 1.25 : 1.0)).toFixed(1) : 0;
        const isWeekend = dow === 0 || dow === 6;
        const label = offset === -1 ? 'Вчера (Архив)' : offset === 0 ? 'Сегодня' : offset === 1 ? 'Завтра' : (isWeekend ? `${dayShort} (Вых.)` : dayShort);

        days.push({
            id: `day_${isoDate}`,
            idx,
            isoDate,
            offsetFromToday: offset,
            dayShort,
            dateStr,
            fullDateLabel: `${dayShort}, ${dateStr} ${year}${isArchive ? ' (Архив)' : offset === 0 ? ' (Сегодня)' : ''}`,
            label,
            zone: isArchive ? 'archive' : 'deterministic',
            confidencePct: isArchive ? 99 : Math.round(93 - offset * 1.6),
            isArchive,
            dayCond,
            dayCondEn: dayCond,
            nightCond,
            nightCondEn: nightCond,
            iconType,
            nightIconType,
            maxC,
            maxF: toF(maxC),
            minC,
            minF: toF(minC),
            maxP10C: +(maxC - spread).toFixed(1),
            maxP25C: +(maxC - spread * 0.5).toFixed(1),
            maxP75C: +(maxC + spread * 0.5).toFixed(1),
            maxP90C: +(maxC + spread).toFixed(1),
            minP10C: +(minC - spread).toFixed(1),
            minP25C: +(minC - spread * 0.5).toFixed(1),
            minP75C: +(minC + spread * 0.5).toFixed(1),
            minP90C: +(minC + spread).toFixed(1),
            climMaxC: clim.climMaxC,
            climMinC: clim.climMinC,
            climAnomalyC: +(meanC - clim.climMeanC).toFixed(1),
            humidity,
            uv,
            precipDay,
            precipNight,
            precipDayType: precipTypeRu,
            precipNightType: precipTypeRu,
            precipMm,
            precipP75Mm: +(precipMm * 1.35).toFixed(1),
            rainMm,
            snowMm,
            snowDepthCm,
            precipPhase,
            windMs,
            windMph: toMph(windMs),
            gustMs,
            gustMph: toMph(gustMs),
            windDirShort: wDir.s,
            windDirFull: REF_DIR_MAP[wDir.s] || 'Западный',
            windDeg: wDir.deg,
            soil0C,
            soil6C,
            soil18C,
            soil54C,
            soilTempC: soil0C,
            dewPointC,
            cloudCoverPct,
            pressureStationHpa: stationHpa,
            pressureStationMm: stationMm,
            pressureMslHpa: mslHpa,
            pressureMslMm: mslMm,
            deltaP24hMm: 0,
            astronomy,
            inversion: {
                active: invActive,
                deltaC: invDelta,
                valleyMinC: +(minC - invDelta).toFixed(1),
                noteRu: invActive
                    ? `Ясная тихая ночь в Абанской котловине: возможно выхолаживание на ${invDelta.toFixed(1)}°C ниже`
                    : 'Перемешивание воздуха: котловинная инверсия ослаблена'
            },
            nextNightMinC: minC,
            nextNightMinF: toF(minC),
            nextNightMaxC: +(minC + 2.5).toFixed(1),
            nextNightMaxF: toF(minC + 2.5),
            nextNightPrecipProb: precipNight,
            nextNightPrecipMm: +(precipMm * 0.4).toFixed(1),
            nextNightPrecipType: precipTypeRu,
            nextNightWindMs: +(windMs * 0.85).toFixed(1),
            nextNightGustMs: +(gustMs * 0.85).toFixed(1),
            nextNightWindDirShort: wDir.s,
            nextNightCond: nightCond,
            nextNightIconType: nightIconType,
            probFrostBelowMinus20: minC <= -20 ? 85 : 0,
            probSnowOver5mm: snowMm >= 5 ? 70 : (snowMm >= 1.5 ? 18 : 2),
            modelBreakdown: {},
            hours
        });
    }

    for (let i = 1; i < days.length; i++) {
        days[i].deltaP24hMm = days[i].pressureStationMm - days[i - 1].pressureStationMm;
        days[i - 1].nextNightMinC = days[i].minC;
        days[i - 1].nextNightMinF = days[i].minF;
    }

    const today = days[1];
    const tomorrow = days[2];
    const slot = today.hours[curHour] || today.hours[12];
    const shiftHour = curHour < 8 ? 8 : (curHour < 20 ? 20 : 8);
    const shiftDay = curHour >= 20 ? tomorrow : today;
    const shiftSlot = shiftDay.hours[shiftHour] || slot;
    const h3 = (curHour + 3) % 24;
    const h3Day = curHour + 3 >= 24 ? tomorrow : today;
    const h3Slot = h3Day.hours[h3] || shiftSlot;

    return {
        version: 4,
        sourceType: 'reference_wn3',
        sourceLabel: 'Сезонный эталон ВМО 29485 (Офлайн, Абан)',
        syncedAt: `${today.dateStr}, ${String(curHour).padStart(2, '0')}:00 (UTC+7)`,
        latencyMs: 0,
        activeModels: [],
        channels: {},
        errors: {},
        mos: {
            models: {},
            bestModelId: null,
            summaryRu: 'Сезонный автономный эталон ВМО 29485 (подключите сеть или API-ключ для калибровки MOS)'
        },
        airQuality: {
            pm25: null,
            pm10: null,
            co: null,
            aqi: null,
            statusRu: 'Офлайн',
            smogRisk: 'unknown'
        },
        current: {
            tempC: slot.tempC,
            tempF: slot.tempF,
            feelsC: slot.feelsC,
            feelsF: toF(slot.feelsC),
            wetBulbC: slot.wetBulbC,
            condRu: today.dayCond,
            iconType: slot.iconType,
            windMs: slot.windMs,
            windMph: slot.windMph,
            gustMs: slot.gustMs,
            gustMph: toMph(slot.gustMs),
            windDeg: today.windDeg,
            windDirShort: today.windDirShort,
            precipProb: slot.precipProb,
            precipMm: slot.precipMm,
            precipPhase: slot.precipPhase,
            snowDepthCm: today.snowDepthCm,
            humidity: slot.humidity,
            dewPointC: today.dewPointC,
            cloudCoverPct: today.cloudCoverPct,
            soil0C: slot.soil0C,
            soil6C: today.soil6C,
            soil18C: today.soil18C,
            soil54C: today.soil54C,
            pressureStationHpa: today.pressureStationHpa,
            pressureStationMm: today.pressureStationMm,
            pressureMslHpa: today.pressureMslHpa,
            pressureMslMm: today.pressureMslMm,
            deltaP3hMm: 0,
            deltaP24hMm: today.deltaP24hMm,
            uv: today.uv,
            obsTimeLabel: `п. Абан • ${today.dateStr}, ${String(curHour).padStart(2, '0')}:00 (UTC+7)`
        },
        controlPoint: {
            targetLabel: `Смена ${String(shiftHour).padStart(2, '0')}:00${curHour >= 20 ? ' (завтра)' : ''}`,
            tempC: shiftSlot.tempC,
            tempF: shiftSlot.tempF,
            feelsC: shiftSlot.feelsC,
            condRu: shiftDay.dayCond,
            badgeRu: shiftDay.dayCond.split(' ')[0],
            iconType: shiftSlot.iconType,
            precipProb: shiftSlot.precipProb,
            windMs: shiftSlot.windMs,
            windMph: shiftSlot.windMph,
            windDirShort: shiftSlot.windDirShort,
            soil0C: shiftSlot.soil0C,
            next3hLabel: `Через 3 ч (${String(h3).padStart(2, '0')}:00)`,
            next3hTempC: h3Slot.tempC
        },
        days
    };
}

export const REFERENCE_DATASET = buildDynamicReferenceDataset();
