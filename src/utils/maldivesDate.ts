const MALDIVES_IANA_TZ = 'Indian/Maldives';
const MALDIVES_OFFSET_MS = 5 * 60 * 60 * 1000;

function formatWithMaldivesTz(
  date: Date,
  locale: string,
  options: Intl.DateTimeFormatOptions
): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: MALDIVES_IANA_TZ,
    }).format(date);
  } catch {
    // Maldives Time (MVT) is permanently UTC+05:00 with no DST.
    const shifted = new Date(date.getTime() + MALDIVES_OFFSET_MS);
    return new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: 'UTC',
    }).format(shifted);
  }
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Returns today's date in Maldives timezone (Asia/Male / Indian/Maldives, UTC+5) as YYYY-MM-DD.
 */
export function getTodayInMaldives(): string {
  return formatWithMaldivesTz(new Date(), 'en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * Returns the current calendar year in Maldives timezone (UTC+5).
 */
export function getCurrentYearInMaldives(): number {
  const today = getTodayInMaldives();
  return Number(today.slice(0, 4));
}

/**
 * Returns current Maldives time formatted for display (e.g. "13 Nov 2026, 14:22 MVT").
 */
export function getCurrentMaldivesTimeDisplay(): string {
  const formatted = formatWithMaldivesTz(new Date(), 'en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${formatted} MVT`;
}

export function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function parseDateKeyToUtcMs(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function utcMsToDateKey(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysToDateKey(dateKey: string, deltaDays: number): string {
  const ms = parseDateKeyToUtcMs(dateKey);
  return utcMsToDateKey(ms + deltaDays * 86400000);
}

/**
 * Expands an inclusive [startDate, endDate] range into an array of YYYY-MM-DD strings.
 * Uses pure UTC calendar arithmetic so local browser timezone never shifts dates.
 */
export function expandDateRange(
  startDate: string,
  endDate: string,
  maxDays = 30
): { dates: string[]; error?: string } {
  if (!isValidDateKey(startDate) || !isValidDateKey(endDate)) {
    return { dates: [], error: 'Dates must be valid calendar dates in YYYY-MM-DD format.' };
  }
  if (startDate > endDate) {
    return { dates: [], error: 'End date cannot be earlier than start date.' };
  }
  const startMs = parseDateKeyToUtcMs(startDate);
  const endMs = parseDateKeyToUtcMs(endDate);
  const diffDays = Math.round((endMs - startMs) / 86400000) + 1;
  if (diffDays > maxDays) {
    return {
      dates: [],
      error: `A single leave period cannot exceed ${maxDays} calendar days (selected ${diffDays} days).`,
    };
  }
  const dates: string[] = [];
  for (let i = 0; i < diffDays; i++) {
    dates.push(utcMsToDateKey(startMs + i * 86400000));
  }
  return { dates };
}

export function getMonthMetadata(year: number, monthIndex0: number): {
  label: string;
  startDate: string;
  endDate: string;
  daysInMonth: number;
  leadingEmptyCells: number;
} {
  const daysInMonth = new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
  const firstDayOfWeek = new Date(Date.UTC(year, monthIndex0, 1)).getUTCDay(); // 0=Sun
  const monthStr = String(monthIndex0 + 1).padStart(2, '0');
  const startDate = `${year}-${monthStr}-01`;
  const endDate = `${year}-${monthStr}-${String(daysInMonth).padStart(2, '0')}`;
  return {
    label: `${MONTH_NAMES[monthIndex0]} ${year}`,
    startDate,
    endDate,
    daysInMonth,
    leadingEmptyCells: firstDayOfWeek,
  };
}

export function buildMonthDays(year: number, monthIndex0: number): string[] {
  const { daysInMonth } = getMonthMetadata(year, monthIndex0);
  const monthStr = String(monthIndex0 + 1).padStart(2, '0');
  const result: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    result.push(`${year}-${monthStr}-${String(d).padStart(2, '0')}`);
  }
  return result;
}

export function formatDisplayDate(dateKey: string): string {
  if (!isValidDateKey(dateKey)) return dateKey;
  const [y, m, d] = dateKey.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${SHORT_MONTHS[m - 1]} ${y}`;
}

export function formatShortDate(dateKey: string): string {
  if (!isValidDateKey(dateKey)) return dateKey;
  const [, m, d] = dateKey.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${SHORT_MONTHS[m - 1]}`;
}

export function formatTimestampForDisplay(ts: unknown): string {
  if (!ts) return '—';
  let date: Date | null = null;
  if (typeof ts === 'string') {
    date = new Date(ts);
  } else if (ts instanceof Date) {
    date = ts;
  } else if (typeof ts === 'object' && ts !== null && 'toDate' in ts && typeof (ts as { toDate: () => Date }).toDate === 'function') {
    date = (ts as { toDate: () => Date }).toDate();
  } else if (typeof ts === 'object' && ts !== null && 'seconds' in ts && typeof (ts as { seconds: number }).seconds === 'number') {
    date = new Date((ts as { seconds: number }).seconds * 1000);
  }
  if (!date || Number.isNaN(date.getTime())) return '—';
  return (
    formatWithMaldivesTz(date, 'en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' MVT'
  );
}
