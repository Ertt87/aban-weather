import { getAbanNowParts, missingForecastDay } from './config.js';

const weekday = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'short' });
const calendarDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short' });

// Relative labels belong to the viewing date. Model zones and archive provenance belong to the snapshot.
export function calendarDaysAt(dataset, todayIso) {
  if (!dataset?.days?.length) return [];
  const days = dataset.sourceType === 'reference_wn3' ? dataset.days.map(missingForecastDay) : [...dataset.days];
  if (!days.some(d => d.isoDate === todayIso)) {
    days.push(missingForecastDay({ isoDate: todayIso }));
    days.sort((a, b) => a.isoDate.localeCompare(b.isoDate));
  }
  const today = Date.parse(todayIso);
  return days.map((day, idx) => {
    const date = new Date(day.isoDate);
    if (!Number.isFinite(date.getTime())) return day;
    const offset = Math.round((date.getTime() - today) / 86400000);
    const short = weekday.format(date);
    const dayShort = day.dayShort || short[0].toUpperCase() + short.slice(1);
    const dateStr = day.dateStr || calendarDate.format(date).replace(/\.$/, '');
    const relative = offset === 0 ? 'Сегодня' : offset === -1 ? 'Вчера' : offset === 1 ? 'Завтра' : '';
    const weekend = [0, 6].includes(date.getUTCDay());
    const label = relative ? relative + (day.isArchive ? ' (Архив)' : '') :
      day.isArchive ? 'Архив' : dayShort + (weekend ? ' (Вых.)' : '');
    const suffix = [relative, day.isArchive ? 'Архив' : ''].filter(Boolean).join(', ');
    return { ...day, idx, offsetFromToday: offset, dayShort, dateStr, label,
      fullDateLabel: `${dayShort}, ${dateStr} ${date.getUTCFullYear()}${suffix ? ` (${suffix})` : ''}` };
  });
}

// Work in Aban calendar hours so the next date is correct even on a device in another timezone.
export function upcomingForecastHours(days, clock) {
  const start = Date.parse(clock.isoDate + 'T00:00:00Z') + clock.hour * 3600000;
  const result = [];
  for (let offset = 0; offset < 6; offset++) {
    const time = new Date(start + offset * 3600000);
    const isoDate = time.toISOString().slice(0, 10);
    const hour = time.getUTCHours();
    const day = days.find(d => d.isoDate === isoDate && d.hasForecast !== false);
    const slot = day?.hours?.find(h => h.hour === hour);
    if (!slot) continue;
    const tempC = slot.isSynthetic ? null : slot.tempC;
    if (![tempC, slot.precipMm, slot.precipProb].some(Number.isFinite) && !slot.weather?.ru) continue;
    result.push({ isoDate, hour, tempC, precipMm: slot.precipMm, precipProb: slot.precipProb,
      condition: slot.weather?.ru, label: isoDate === clock.isoDate ? 'Сегодня' : 'Завтра' });
  }
  return result;
}

export function fallbackSnapshot(dataset, origin, cached) {
  const usable = ds => ds?.sourceType !== 'reference_wn3' && ds?.days?.some(d => d.hasForecast !== false);
  if (!usable(dataset)) return usable(cached) ? { dataset: cached, origin: 'disk' } : { dataset, origin: 'reference' };
  if (origin === 'file') return { dataset, origin };
  const timestamp = dataset.receivedAtIso || dataset.syncedAt || dataset.cacheSavedAtIso;
  const same = usable(cached) && dataset.sourceType === cached.sourceType &&
    timestamp && timestamp === (cached.receivedAtIso || cached.syncedAt || cached.cacheSavedAtIso);
  if (same) return { dataset, origin: origin === 'disk' ? 'disk' : 'saved' };
  return { dataset, origin: 'memory' };
}

export function snapshotTimeText(dataset, now = Date.now()) {
  const received = Date.parse(dataset.receivedAtIso);
  const saved = Date.parse(dataset.cacheSavedAtIso);
  const ms = Number.isFinite(received) ? received : saved;
  if (!Number.isFinite(ms)) return dataset.syncedAt || 'Время неизвестно';
  const ageMinutes = Math.max(0, Math.floor((now - ms) / 60000));
  const age = ageMinutes < 60 ? `${ageMinutes} мин` :
    ageMinutes < 1440 ? `${Math.floor(ageMinutes / 60)} ч` : `${Math.floor(ageMinutes / 1440)} дн.`;
  return `${Number.isFinite(received) ? 'Получено' : 'Сохранено'} ${abanTimeText(ms)} · ${age} назад`;
}

export function abanTimeText(ms) {
  const { isoDate, hour } = getAbanNowParts(ms);
  const [year, month, day] = isoDate.split('-');
  const minutes = String(new Date(ms).getUTCMinutes()).padStart(2, '0');
  return `${day}.${month}.${year} ${String(hour).padStart(2, '0')}:${minutes}`;
}
