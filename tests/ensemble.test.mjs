import test from 'node:test';
import assert from 'node:assert/strict';

import { ABAN_COORDS, REFERENCE_DATASET, getAbanClimatology } from '../js/config.js';
import {
  computeRollingMos,
  buildUnifiedDataset,
  mergeArchiveDaysIntoDataset,
  computeDayWindowStats,
  buildPentadSummary,
} from '../js/ensemble.js';

function addDaysIso(baseIso, deltaDays) {
  const [y, m, d] = baseIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function buildMockRawBundle({ todayIso = '2026-11-17', extremeDay35 = false } = {}) {
  const pastDays = 14;
  const forecastDays = 16; // offsets 0..15
  const totalDetDays = pastDays + forecastDays; // 30 days: -14..+15
  const models = ['ecmwf_ifs025', 'ecmwf_aifs025', 'icon_seamless', 'gfs_seamless'];

  const hourlyTimes = [];
  const dailyTimes = [];

  for (let d = -pastDays; d < forecastDays; d++) {
    const iso = addDaysIso(todayIso, d);
    dailyTimes.push(iso);
    for (let h = 0; h < 24; h++) {
      hourlyTimes.push(`${iso}T${String(h).padStart(2, '0')}:00`);
    }
  }

  const omHourly = { time: hourlyTimes };
  const omDaily = { time: dailyTimes };

  const modelOffsets = {
    ecmwf_ifs025: 0.2,
    ecmwf_aifs025: -0.1,
    icon_seamless: 0.5,
    gfs_seamless: -1.8,
  };

  for (const model of models) {
    const off = modelOffsets[model];
    const tArr = [];
    const appArr = [];
    const rhArr = [];
    const dpArr = [];
    const pArr = [];
    const rArr = [];
    const sArr = [];
    const wcArr = [];
    const pmslArr = [];
    const spArr = [];
    const ccArr = [];
    const wsArr = [];
    const wdArr = [];
    const wgArr = [];

    for (let idx = 0; idx < hourlyTimes.length; idx++) {
      const dayIdx = Math.floor(idx / 24) - pastDays;
      const hour = idx % 24;
      const base = -5 - dayIdx * 0.25 + off;
      const diurnal = -4.5 * Math.cos(((hour - 4) / 24) * 2 * Math.PI);
      const t = Number((base + diurnal).toFixed(1));
      tArr.push(t);
      appArr.push(Number((t - 3.2).toFixed(1)));
      rhArr.push(75 + (hour < 8 ? 10 : -5));
      dpArr.push(Number((t - 3.5).toFixed(1)));
      const precip = hour === 13 && dayIdx % 3 === 0 ? 0.6 : 0;
      pArr.push(precip);
      rArr.push(t > 1 ? precip : 0);
      sArr.push(t <= 1 ? Number((precip * 0.7).toFixed(2)) : 0);
      wcArr.push(precip > 0 ? (t <= 0 ? 71 : 61) : hour % 5 === 0 ? 2 : 0);
      pmslArr.push(Number((1015 + Math.sin(idx / 30) * 6).toFixed(1)));
      spArr.push(Number((984 + Math.sin(idx / 30) * 6).toFixed(1)));
      ccArr.push(precip > 0 ? 90 : 35);
      wsArr.push(Number((3.2 + (hour % 6) * 0.4).toFixed(1)));
      wdArr.push((210 + (idx % 40)) % 360);
      wgArr.push(Number((6.5 + (hour % 5) * 0.6).toFixed(1)));
    }

    omHourly[`temperature_2m_${model}`] = tArr;
    omHourly[`apparent_temperature_${model}`] = appArr;
    omHourly[`relative_humidity_2m_${model}`] = rhArr;
    omHourly[`dew_point_2m_${model}`] = dpArr;
    omHourly[`precipitation_${model}`] = pArr;
    omHourly[`rain_${model}`] = rArr;
    omHourly[`snowfall_${model}`] = sArr;
    omHourly[`weather_code_${model}`] = wcArr;
    omHourly[`pressure_msl_${model}`] = pmslArr;
    omHourly[`surface_pressure_${model}`] = spArr;
    omHourly[`cloud_cover_${model}`] = ccArr;
    omHourly[`wind_speed_10m_${model}`] = wsArr;
    omHourly[`wind_direction_10m_${model}`] = wdArr;
    omHourly[`wind_gusts_10m_${model}`] = wgArr;

    const dMax = [];
    const dMin = [];
    const dPrecip = [];
    const dRain = [];
    const dSnow = [];
    const dWMax = [];
    const dGMax = [];
    const dWDir = [];
    const dCode = [];
    for (let d = 0; d < totalDetDays; d++) {
      const slice = tArr.slice(d * 24, (d + 1) * 24);
      const mx = Math.max(...slice);
      const mn = Math.min(...slice);
      dMax.push(mx);
      dMin.push(mn);
      const pSum = Number(pArr.slice(d * 24, (d + 1) * 24).reduce((a, b) => a + b, 0).toFixed(1));
      dPrecip.push(pSum);
      dRain.push(mx > 2 ? pSum : 0);
      dSnow.push(mx <= 2 ? Number((pSum * 0.7).toFixed(1)) : 0);
      dWMax.push(5.6);
      dGMax.push(9.5);
      dWDir.push(225);
      dCode.push(pSum > 0 ? 71 : 2);
    }

    omDaily[`weather_code_${model}`] = dCode;
    omDaily[`temperature_2m_max_${model}`] = dMax;
    omDaily[`temperature_2m_min_${model}`] = dMin;
    omDaily[`precipitation_sum_${model}`] = dPrecip;
    omDaily[`rain_sum_${model}`] = dRain;
    omDaily[`snowfall_sum_${model}`] = dSnow;
    omDaily[`wind_speed_10m_max_${model}`] = dWMax;
    omDaily[`wind_gusts_10m_max_${model}`] = dGMax;
    omDaily[`wind_direction_10m_dominant_${model}`] = dWDir;
  }

  // Companion best_match
  const compHourly = {
    time: hourlyTimes,
    precipitation_probability: hourlyTimes.map((_, i) => (i % 24 === 13 ? 45 : 10)),
    snow_depth: hourlyTimes.map((_, i) => Number((0.15 + Math.floor(i / 24) * 0.005).toFixed(3))),
    soil_temperature_0cm: hourlyTimes.map((_, i) => Number((-1.2 - Math.floor(i / 24) * 0.05).toFixed(1))),
    soil_temperature_6cm: hourlyTimes.map(() => -0.6),
    soil_temperature_18cm: hourlyTimes.map(() => 0.4),
    soil_temperature_54cm: hourlyTimes.map(() => 2.1),
    soil_moisture_0_to_1cm: hourlyTimes.map(() => 0.28),
    soil_moisture_3_to_9cm: hourlyTimes.map(() => 0.31),
    pressure_msl: hourlyTimes.map(() => 1015),
    surface_pressure: hourlyTimes.map(() => 984),
  };
  const compDaily = {
    time: dailyTimes,
    uv_index_max: dailyTimes.map(() => 1.2),
    precipitation_probability_max: dailyTimes.map((_, i) => (i % 3 === 0 ? 45 : 15)),
    shortwave_radiation_sum: dailyTimes.map(() => 4.2),
  };

  // Previous runs over past 14 days (for MOS)
  const prevTimes = hourlyTimes.slice(0, pastDays * 24 + 24);
  const prevHourly = { time: prevTimes };
  // Give ecmwf_ifs025 tight error (MAE ~0.5), gfs_seamless warm bias (+3.5C)
  for (const model of models) {
    const obs = prevTimes.map((_, idx) => {
      const h = idx % 24;
      return Number((-5 - 4 * Math.cos(((h - 4) / 24) * 2 * Math.PI)).toFixed(1));
    });
    const bias = model === 'gfs_seamless' ? -3.5 : model === 'ecmwf_ifs025' ? 0.4 : 1.0;
    prevHourly[`temperature_2m_${model}`] = obs;
    prevHourly[`temperature_2m_previous_day1_${model}`] = obs.map((v) => Number((v + bias).toFixed(1)));
    prevHourly[`temperature_2m_previous_day2_${model}`] = obs.map((v) => Number((v + bias * 1.1).toFixed(1)));
  }

  // 35-day ensemble quantiles (offsets 0..34)
  const dailyQuantiles = Array.from({ length: 35 }, (_, offset) => {
    const isoDate = addDaysIso(todayIso, offset);
    const clim = getAbanClimatology(isoDate);
    // On day 34 (35th forecast day), optionally inject extreme warm raw noise to test climatology regularization
    const maxP50C = extremeDay35 && offset === 34 ? clim.climMaxC + 25.0 : clim.climMaxC - 1.5;
    const minP50C = extremeDay35 && offset === 34 ? clim.climMinC + 25.0 : clim.climMinC - 1.5;
    return {
      isoDate,
      maxP10C: Number((maxP50C - 6).toFixed(1)),
      maxP25C: Number((maxP50C - 3).toFixed(1)),
      maxP50C: Number(maxP50C.toFixed(1)),
      maxP75C: Number((maxP50C + 3).toFixed(1)),
      maxP90C: Number((maxP50C + 6).toFixed(1)),
      minP10C: Number((minP50C - 7).toFixed(1)),
      minP25C: Number((minP50C - 3.5).toFixed(1)),
      minP50C: Number(minP50C.toFixed(1)),
      minP75C: Number((minP50C + 3.5).toFixed(1)),
      minP90C: Number((minP50C + 7).toFixed(1)),
      precipP50Mm: offset % 4 === 0 ? 1.8 : 0.1,
      precipP75Mm: offset % 4 === 0 ? 3.5 : 0.7,
      precipP90Mm: offset % 4 === 0 ? 6.2 : 2.1,
      windP50Ms: 3.8,
      windP90Ms: 8.5,
      probBelowMinus20: minP50C < -18 ? 65 : 15,
      probPrecipOver5: offset % 4 === 0 ? 30 : 5,
      memberCount: 51,
    };
  });

  return {
    mode: 'hybrid',
    preferredOmModel: 'multi',
    latencyMs: 340,
    fetchedAtIso: `${todayIso}T03:00:00.000Z`,
    google: null,
    openMeteoMulti: {
      latitude: ABAN_COORDS.lat,
      longitude: ABAN_COORDS.lon,
      elevation: ABAN_COORDS.elev,
      timezone: ABAN_COORDS.tz,
      hourly: omHourly,
      daily: omDaily,
    },
    openMeteoCompanion: {
      hourly: compHourly,
      daily: compDaily,
    },
    previousRuns: {
      hourly: prevHourly,
    },
    ensemble35: {
      sources: ['ecmwf_ifs025_ensemble'],
      dailyQuantiles,
    },
    metNo: null,
    airQuality: {
      current: {
        pm2_5: 14.2,
        pm10: 21.8,
        carbon_monoxide: 260,
        european_aqi: 28,
      },
    },
  };
}

test('computeRollingMos computes per-model MAE, day/night bias, and skill ranking', () => {
  const bundle = buildMockRawBundle();
  const mos = computeRollingMos(bundle.previousRuns);

  assert.ok(mos && mos.models, 'MOS must return models dictionary');
  assert.ok(mos.models.ecmwf_ifs025, 'MOS should include ecmwf_ifs025');
  assert.ok(mos.models.gfs_seamless, 'MOS should include gfs_seamless');

  assert.ok(
    mos.models.ecmwf_ifs025.maeC < mos.models.gfs_seamless.maeC,
    `expected ecmwf_ifs025 MAE (${mos.models.ecmwf_ifs025.maeC}) < gfs_seamless MAE (${mos.models.gfs_seamless.maeC})`,
  );
  assert.ok(
    mos.models.ecmwf_ifs025.weightMultiplier >= mos.models.gfs_seamless.weightMultiplier,
    'better-performing model should receive higher/equal weightMultiplier',
  );
  assert.equal(mos.bestModelId, 'ecmwf_ifs025');
  assert.ok(typeof mos.models.gfs_seamless.dayBiasC === 'number');
  assert.ok(typeof mos.models.gfs_seamless.nightBiasC === 'number');
  assert.ok(typeof mos.summaryRu === 'string' && mos.summaryRu.length > 0);
});

test('buildUnifiedDataset builds all 4 zones covering past + 35d with monotonic quantiles and zero reference leakage', () => {
  const bundle = buildMockRawBundle({ todayIso: '2026-11-17' });
  const dataset = buildUnifiedDataset(bundle, { todayIso: '2026-11-17' });

  assert.equal(dataset.version, 4);
  assert.ok(dataset.current && Number.isFinite(dataset.current.tempC));
  assert.ok(dataset.controlPoint && Number.isFinite(dataset.controlPoint.tempC));
  assert.ok(dataset.airQuality && dataset.airQuality.pm25 === 14.2);

  const zones = new Set(dataset.days.map((d) => d.zone));
  for (const z of ['archive', 'deterministic', 'extended_ensemble', 'subseasonal']) {
    assert.ok(zones.has(z), `dataset.days missing zone '${z}'`);
  }

  const maxOffset = Math.max(...dataset.days.map((d) => d.offsetFromToday));
  const minOffset = Math.min(...dataset.days.map((d) => d.offsetFromToday));
  assert.ok(minOffset <= -10, `expected >= 10 archive days, got minOffset=${minOffset}`);
  assert.ok(maxOffset >= 34, `expected 35 days ahead (offset 34), got maxOffset=${maxOffset}`);

  // Zero REFERENCE_DATASET leakage (live dataset must come from bundle models, not offline reference)
  assert.notEqual(dataset.sourceType, REFERENCE_DATASET.sourceType);
  assert.notEqual(dataset.sourceLabel, REFERENCE_DATASET.sourceLabel);
  assert.notEqual(dataset.syncedAt, REFERENCE_DATASET.syncedAt);
  assert.ok(dataset.channels && typeof dataset.channels === 'object');
  assert.ok(dataset.errors && typeof dataset.errors === 'object');

  // Monotonic quantiles on all forecast days
  for (const day of dataset.days) {
    if (day.maxP10C != null && day.maxP90C != null) {
      assert.ok(
        day.maxP10C <= day.maxP25C &&
          day.maxP25C <= day.maxC &&
          day.maxC <= day.maxP75C &&
          day.maxP75C <= day.maxP90C,
        `max quantiles not monotonic on ${day.isoDate}: ${day.maxP10C} <= ${day.maxP25C} <= ${day.maxC} <= ${day.maxP75C} <= ${day.maxP90C}`,
      );
    }
    if (day.minP10C != null && day.minP90C != null) {
      assert.ok(
        day.minP10C <= day.minP25C &&
          day.minP25C <= day.minC &&
          day.minC <= day.minP75C &&
          day.minP75C <= day.minP90C,
        `min quantiles not monotonic on ${day.isoDate}: ${day.minP10C} <= ${day.minP25C} <= ${day.minC} <= ${day.minP75C} <= ${day.minP90C}`,
      );
    }
    assert.ok(day.minC <= day.maxC, `minC (${day.minC}) must be <= maxC (${day.maxC}) on ${day.isoDate}`);
  }

  // Deterministic days have real 24h hours and modelBreakdown
  const day0 = dataset.days.find((d) => d.offsetFromToday === 0);
  assert.ok(day0);
  assert.equal(day0.hours.length, 24);
  assert.ok(day0.modelBreakdown && Object.keys(day0.modelBreakdown).length >= 3);
});

test('climatology regularization on day 35 keeps temperature anchored toward Aban normals', () => {
  const bundle = buildMockRawBundle({ todayIso: '2026-11-17', extremeDay35: true });
  const dataset = buildUnifiedDataset(bundle, { todayIso: '2026-11-17' });

  const day35 = dataset.days.find((d) => d.offsetFromToday === 34);
  assert.ok(day35, 'expected day with offsetFromToday === 34');
  assert.equal(day35.zone, 'subseasonal');

  const rawP50 = bundle.ensemble35.dailyQuantiles[34].maxP50C;
  const clim = getAbanClimatology(day35.isoDate);
  const distReg = Math.abs(day35.maxC - clim.climMaxC);
  const distRaw = Math.abs(rawP50 - clim.climMaxC);

  assert.ok(
    distReg < distRaw * 0.75,
    `day 35 maxC (${day35.maxC}) must be regularized toward climMaxC (${clim.climMaxC}) vs raw P50 (${rawP50})`,
  );
  assert.ok(Number.isFinite(day35.climAnomalyC));
});

test('MOS bias damping decays smoothly over deterministic horizon', () => {
  // Compare two bundles differing only by systematic model bias in previousRuns
  const biasedBundle = buildMockRawBundle({ todayIso: '2026-11-17' });
  const neutralBundle = buildMockRawBundle({ todayIso: '2026-11-17' });

  // Make ALL models consistently +4C too warm in previousRuns of biasedBundle, 0 bias in neutralBundle
  for (const model of ['ecmwf_ifs025', 'ecmwf_aifs025', 'icon_seamless', 'gfs_seamless']) {
    const obs = neutralBundle.previousRuns.hourly[`temperature_2m_${model}`];
    neutralBundle.previousRuns.hourly[`temperature_2m_previous_day1_${model}`] = [...obs];
    neutralBundle.previousRuns.hourly[`temperature_2m_previous_day2_${model}`] = [...obs];
    biasedBundle.previousRuns.hourly[`temperature_2m_previous_day1_${model}`] = obs.map((v) => v + 4.0);
    biasedBundle.previousRuns.hourly[`temperature_2m_previous_day2_${model}`] = obs.map((v) => v + 4.0);
  }

  const dsNeutral = buildUnifiedDataset(neutralBundle, { todayIso: '2026-11-17' });
  const dsBiased = buildUnifiedDataset(biasedBundle, { todayIso: '2026-11-17' });

  const shiftOffset0 = Math.abs(
    dsBiased.days.find((d) => d.offsetFromToday === 0).maxC -
      dsNeutral.days.find((d) => d.offsetFromToday === 0).maxC,
  );
  const shiftOffset8 = Math.abs(
    dsBiased.days.find((d) => d.offsetFromToday === 8).maxC -
      dsNeutral.days.find((d) => d.offsetFromToday === 8).maxC,
  );

  assert.ok(shiftOffset0 > 0.5, `expected noticeable MOS correction at offset 0, got ${shiftOffset0}`);
  assert.ok(
    shiftOffset0 > shiftOffset8,
    `expected MOS damping decay: offset 0 shift (${shiftOffset0}) > offset 8 shift (${shiftOffset8})`,
  );
});

test('mergeArchiveDaysIntoDataset inserts historical ERA5 days cleanly in chronological order', () => {
  const bundle = buildMockRawBundle({ todayIso: '2026-11-17' });
  const dataset = buildUnifiedDataset(bundle, { todayIso: '2026-11-17' });

  const customArchiveDays = [
    {
      isoDate: '1985-01-16',
      maxC: -22.5,
      minC: -34.2,
      meanC: -28.4,
      weatherCode: 0,
      precipMm: 0.0,
      rainMm: 0.0,
      snowfallCm: 0.0,
      snowDepthCm: 48,
      windMs: 1.4,
      gustMs: 2.8,
      windDeg: 140,
      humidity: 76,
      dewPointC: -31.0,
      cloudCoverPct: 10,
      pressureMslHpa: 1038,
      surfacePressureHpa: 1006,
      soil0C: -12.0,
      soil6C: -9.5,
      soil18C: -6.2,
      soil54C: -2.0,
    },
    {
      isoDate: '1985-01-15',
      maxC: -24.0,
      minC: -36.1,
      meanC: -30.1,
      weatherCode: 0,
      precipMm: 0.0,
      rainMm: 0.0,
      snowfallCm: 0.0,
      snowDepthCm: 48,
      windMs: 1.1,
      gustMs: 2.2,
      windDeg: 135,
      humidity: 74,
      dewPointC: -33.0,
      cloudCoverPct: 5,
      pressureMslHpa: 1041,
      surfacePressureHpa: 1009,
      soil0C: -12.5,
      soil6C: -9.8,
      soil18C: -6.4,
      soil54C: -2.1,
    },
  ];

  const merged = mergeArchiveDaysIntoDataset(dataset, customArchiveDays);
  assert.ok(merged.days.length >= dataset.days.length + 2);
  assert.equal(merged.days[0].isoDate, '1985-01-15');
  assert.equal(merged.days[1].isoDate, '1985-01-16');
  assert.equal(merged.days[0].zone, 'archive');

  // Chronological order & no duplicate isoDate
  for (let i = 1; i < merged.days.length; i++) {
    assert.ok(
      merged.days[i - 1].isoDate < merged.days[i].isoDate,
      `days not strictly sorted/unique at ${i}: ${merged.days[i - 1].isoDate} vs ${merged.days[i].isoDate}`,
    );
  }
});

test('computeDayWindowStats and buildPentadSummary aggregate cleanly', () => {
  const bundle = buildMockRawBundle({ todayIso: '2026-11-17' });
  const dataset = buildUnifiedDataset(bundle, { todayIso: '2026-11-17' });
  const day0 = dataset.days.find((d) => d.offsetFromToday === 0);

  const statsFull = computeDayWindowStats(day0, 'full');
  const statsDay = computeDayWindowStats(day0, 'day_shift');
  assert.ok(statsFull.activeHours.length === 24);
  assert.ok(statsDay.activeHours.length < 24 && statsDay.activeHours.length >= 12);
  assert.ok(statsFull.minC <= statsFull.avgC && statsFull.avgC <= statsFull.maxC);

  const pentads = buildPentadSummary(dataset.days.filter((d) => d.offsetFromToday >= 0));
  assert.ok(Array.isArray(pentads) && pentads.length >= 6);
});

test('buildUnifiedDataset integrates Google WeatherNext 3 and MET Norway alongside Open-Meteo', () => {
  const bundle = buildMockRawBundle({ todayIso: '2026-11-17' });
  bundle.google = {
    current: {
      temperature: { degrees: -4.2 },
      relativeHumidity: 74,
      airPressure: { meanSeaLevelMillibars: 1018 },
      precipitation: { qpf: { quantity: 0.2 }, probability: { percent: 30 } },
      wind: { speed: { value: 14.4, unit: 'KILOMETERS_PER_HOUR' }, gust: { value: 25.2, unit: 'KILOMETERS_PER_HOUR' }, direction: { degrees: 225 } },
      cloudCover: 60,
      uvIndex: 1,
      weatherCondition: { type: 'SNOW', description: { text: 'Небольшой снег' } },
    },
    forecastDays: [
      {
        displayDate: { year: 2026, month: 11, day: 17 },
        maxTemperature: { degrees: -2.1 },
        minTemperature: { degrees: -9.8 },
        daytimeForecast: {
          weatherCondition: { type: 'SNOW', description: { text: 'Небольшой снег' } },
          precipitation: { probability: { percent: 45 }, qpf: { quantity: 1.2 } },
          relativeHumidity: 78,
          uvIndex: 1,
          wind: { speed: { value: 14.4, unit: 'KILOMETERS_PER_HOUR' }, gust: { value: 25.2, unit: 'KILOMETERS_PER_HOUR' }, direction: { degrees: 225 } },
          cloudCover: 75,
        },
        nighttimeForecast: {
          weatherCondition: { type: 'MOSTLY_CLEAR', description: { text: 'Прояснения' } },
          precipitation: { probability: { percent: 15 }, qpf: { quantity: 0.1 } },
          relativeHumidity: 82,
        },
      },
    ],
    forecastHours: [
      {
        interval: { startTime: '2026-11-17T07:00:00Z' },
        isDaytime: true,
        temperature: { degrees: -2.5 },
        feelsLikeTemperature: { degrees: -7.2 },
        relativeHumidity: 75,
        dewPoint: { degrees: -6.3 },
        precipitation: { probability: { percent: 40 }, qpf: { quantity: 0.3 } },
        cloudCover: 70,
        airPressure: { meanSeaLevelMillibars: 1018 },
        wind: { speed: { value: 4.0, unit: 'METERS_PER_SECOND' }, gust: { value: 7.5, unit: 'METERS_PER_SECOND' }, direction: { degrees: 225 } },
        weatherCondition: { type: 'SNOW', description: { text: 'Снег' } },
      },
    ],
    historyHours: [],
  };
  bundle.metNo = {
    properties: {
      timeseries: [
        {
          time: '2026-11-17T06:00:00Z',
          data: {
            instant: {
              details: {
                air_temperature: -3.0,
                relative_humidity: 76,
                dew_point_temperature: -6.5,
                wind_speed: 3.8,
                wind_speed_of_gust: 7.0,
                wind_from_direction: 230,
                air_pressure_at_sea_level: 1017,
                cloud_area_fraction: 65,
              },
            },
            next_1_hours: { details: { precipitation_amount: 0.2 } },
          },
        },
      ],
    },
  };

  const dataset = buildUnifiedDataset(bundle, { todayIso: '2026-11-17' });
  assert.equal(dataset.sourceType, 'live_super_ensemble');
  assert.ok(dataset.activeModels.includes('google_wn3'));
  assert.ok(dataset.activeModels.includes('met_no'));
  const day0 = dataset.days.find((d) => d.offsetFromToday === 0);
  assert.ok(day0?.modelBreakdown?.google_wn3);
});
