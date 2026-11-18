import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cToF,
  msToMph,
  hpaToMmHg,
  degToCompass,
  formatSignedC,
  computeWetBulbC,
  classifyPrecipPhase,
  blendWindVectors,
  computeApparentTempC,
  convertPressure,
  computeAstronomy,
  detectBasinInversion,
  computeFieldOpsMetrics,
} from '../js/physics.js';

test('basic unit conversions and formatting helpers', () => {
  assert.equal(cToF(0), 32);
  assert.equal(cToF(100), 212);
  assert.equal(cToF(-40), -40);

  assert.ok(Math.abs(msToMph(10) - 22.4) < 1);
  assert.ok(Math.abs(hpaToMmHg(1013.25) - 760) <= 1);

  assert.deepEqual(degToCompass(0), { s: 'С', f: 'Северный' });
  assert.deepEqual(degToCompass(360), { s: 'С', f: 'Северный' });
  assert.deepEqual(degToCompass(135), { s: 'ЮВ', f: 'Юго-Восточный' });
  assert.deepEqual(degToCompass(-45), { s: 'СЗ', f: 'Северо-Западный' });

  assert.match(formatSignedC(4.2), /^\+4\.2/);
  assert.match(formatSignedC(-5.0), /^-5\.0/);
  assert.match(formatSignedC(0), /^0\.0/);
});

test('computeWetBulbC follows Stull (2011) physical sanity', () => {
  const twSat = computeWetBulbC(20, 100);
  assert.ok(Math.abs(twSat - 20) < 0.3, `saturated Tw should be ~20C, got ${twSat}`);

  const twDry = computeWetBulbC(2.0, 40);
  assert.ok(twDry < -0.5, `+2C at RH=40% should have Tw < -0.5C, got ${twDry}`);

  const twHumid = computeWetBulbC(2.0, 95);
  assert.ok(twHumid > 1.2 && twHumid <= 2.0, `+2C at RH=95% should have Tw > 1.2C, got ${twHumid}`);

  assert.ok(computeWetBulbC(15, 80) > computeWetBulbC(15, 30), 'Tw increases with RH');
  assert.ok(computeWetBulbC(25, 60) > computeWetBulbC(5, 60), 'Tw increases with air temperature');
});

test('classifyPrecipPhase handles dry, snow, sleet, rain, and freezing_rain', () => {
  const dry = classifyPrecipPhase(5, 50, 0, 4);
  assert.equal(dry.phase, 'dry');

  const dryEvapSnow = classifyPrecipPhase(2.0, 40, 1.5, 1.0);
  assert.equal(dryEvapSnow.phase, 'snow', '+2.0C at RH=40% has Tw < -0.5C -> snow');
  assert.ok(
    dryEvapSnow.snowLiquidRatio >= 10 && dryEvapSnow.snowLiquidRatio <= 18,
    `expected SLR 10..18, got ${dryEvapSnow.snowLiquidRatio}`,
  );

  const wetRain = classifyPrecipPhase(2.0, 95, 1.5, 2.0);
  assert.equal(wetRain.phase, 'rain', '+2.0C at RH=95% above-zero soil -> rain');

  const sleet = classifyPrecipPhase(0.5, 95, 1.5, 0.5);
  assert.equal(sleet.phase, 'sleet', 'Tw in -0.5..1.2C -> sleet');

  const freezingRainFrozenSoil = classifyPrecipPhase(2.0, 95, 1.5, -1.0);
  assert.equal(
    freezingRainFrozenSoil.phase,
    'freezing_rain',
    'liquid precipitation on frozen ground (soil0C < -0.3) -> freezing_rain',
  );
});

test('blendWindVectors averages across 0/360 wrap and preserves scalar speed for opposing winds', () => {
  const northWrap = blendWindVectors([
    { speedMs: 6, gustMs: 10, dirDeg: 355, weight: 1 },
    { speedMs: 6, gustMs: 10, dirDeg: 5, weight: 1 },
  ]);
  assert.equal(northWrap.windDirShort, 'С');
  assert.ok(northWrap.windDeg <= 2 || northWrap.windDeg >= 358, `expected ~0 deg, got ${northWrap.windDeg}`);
  assert.ok(northWrap.windMs > 5.0 && northWrap.windMs <= 6.5, `expected ~6 m/s, got ${northWrap.windMs}`);
  assert.ok(northWrap.gustMs >= 9.0, `expected gust >= 9 m/s, got ${northWrap.gustMs}`);

  const opposing = blendWindVectors([
    { speedMs: 4.5, gustMs: 8.0, dirDeg: 90, weight: 1 },
    { speedMs: 4.5, gustMs: 8.0, dirDeg: 270, weight: 1 },
  ]);
  assert.ok(
    opposing.windMs >= 4.0 && opposing.windMs <= 5.0,
    `opposing winds should retain weighted scalar speed (~4.5 m/s), got ${opposing.windMs}`,
  );
  assert.ok(Number.isFinite(opposing.windMph) && opposing.windMph > 0);
  assert.ok(typeof opposing.windDirFull === 'string' && opposing.windDirFull.length > 0);
});

test('convertPressure accurately converts MSL <-> station pressure at Aban 246m', () => {
  const fromMsl = convertPressure({ mslHpa: 1013.25, tempC: 0, elevM: 246 });
  assert.ok(
    fromMsl.stationHpa >= 980 && fromMsl.stationHpa <= 986,
    `expected ~983 hPa at 246m, got ${fromMsl.stationHpa}`,
  );
  assert.ok(
    fromMsl.stationMm >= 736 && fromMsl.stationMm <= 741,
    `expected ~737-740 mmHg at 246m, got ${fromMsl.stationMm}`,
  );
  assert.ok(Math.abs(fromMsl.mslHpa - 1013.25) < 0.5);
  assert.ok(fromMsl.mslMm >= 759 && fromMsl.mslMm <= 761);

  const fromStation = convertPressure({ surfaceHpa: 983.0, tempC: 0, elevM: 246 });
  assert.ok(
    fromStation.mslHpa >= 1011 && fromStation.mslHpa <= 1016,
    `expected ~1013 hPa MSL from 983 hPa station, got ${fromStation.mslHpa}`,
  );
});

test('computeAstronomy produces realistic winter and summer daylight durations for Aban', () => {
  const winter = computeAstronomy('2026-12-21', 56.68, 96.07, 7);
  assert.ok(winter.daylightHours < 7.5 && winter.daylightHours > 5.5, `Dec 21 daylight=${winter.daylightHours}`);
  assert.ok(winter.sunriseHour < winter.sunsetHour);
  assert.match(winter.sunriseStr, /^\d{2}:\d{2}$/);
  assert.match(winter.sunsetStr, /^\d{2}:\d{2}$/);
  assert.match(winter.dawnStr, /^\d{2}:\d{2}$/);
  assert.match(winter.duskStr, /^\d{2}:\d{2}$/);

  const summer = computeAstronomy('2026-06-21', 56.68, 96.07, 7);
  assert.ok(summer.daylightHours > 17.0 && summer.daylightHours < 19.0, `Jun 21 daylight=${summer.daylightHours}`);
  assert.ok(summer.sunriseHour < summer.sunsetHour);
});

test('detectBasinInversion triggers on clear calm snowy night and stays off when windy/overcast', () => {
  const calmClear = detectBasinInversion({
    nightMinC: -22,
    cloudCoverPct: 5,
    nightWindMs: 0.7,
    snowDepthCm: 35,
  });
  assert.equal(calmClear.active, true);
  assert.ok(calmClear.deltaC > 0);
  assert.ok(calmClear.valleyMinC < -22);
  assert.ok(typeof calmClear.noteRu === 'string' && calmClear.noteRu.length > 5);

  const windyOvercast = detectBasinInversion({
    nightMinC: -5,
    cloudCoverPct: 92,
    nightWindMs: 7.5,
    snowDepthCm: 10,
  });
  assert.equal(windyOvercast.active, false);
});

test('computeApparentTempC and computeFieldOpsMetrics produce valid physical outputs', () => {
  const windChill = computeApparentTempC(-15, 6, 75);
  assert.ok(windChill < -15, `expected wind chill colder than -15C, got ${windChill}`);

  const warmApparent = computeApparentTempC(28, 1.0, 75);
  assert.ok(warmApparent >= 27, `expected muggy apparent temp >= 27C, got ${warmApparent}`);

  const coldDay = {
    isoDate: '2026-11-25',
    maxC: -18,
    minC: -32,
    windMs: 3.5,
    gustMs: 7.0,
    precipMm: 0.2,
    precipPhase: 'snow',
    snowDepthCm: 28,
    soil0C: -6.5,
    soil6C: -4.2,
    soil18C: -1.8,
    soil54C: 0.4,
    humidity: 78,
    cloudCoverPct: 20,
    pressureStationMm: 752,
    deltaP24hMm: 4,
  };
  const ops = computeFieldOpsMetrics(coldDay, [
    { isoDate: '2026-11-24', maxC: 1.2, minC: -12, soil0C: 0.3, precipMm: 2.0 },
  ]);
  assert.ok(['low', 'moderate', 'high', 'severe'].includes(ops.roadRisk.level));
  assert.ok(typeof ops.diesel.grade === 'string' && ops.diesel.grade.length > 0);
  assert.ok(typeof ops.diesel.cutoffC === 'number');
  assert.ok(typeof ops.ground.freezeDepthCm === 'number');
  assert.equal(typeof ops.frostCrossZero, 'boolean');
});
