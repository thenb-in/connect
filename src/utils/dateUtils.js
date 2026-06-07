export const getMonthStart = (ref = new Date()) =>
  new Date(ref.getFullYear(), ref.getMonth(), 1, 0, 0, 0, 0);

/**
 * Returns a new Date at 00:00:00.000 local time on the same calendar day as `d`.
 */
export const startOfDay = (d) => {
  const next = new Date(d);
  next.setHours(0, 0, 0, 0);
  return next;
};

/**
 * Returns a new Date at 23:59:59.999 local time on the same calendar day as `d`.
 */
export const endOfDay = (d) => {
  const next = new Date(d);
  next.setHours(23, 59, 59, 999);
  return next;
};

/**
 * Number of whole calendar days between `ts` and now (local time), e.g. a call
 * at 10pm last night returns 1 even though only a few hours have elapsed. Use
 * this for "today / yesterday / Nd ago" labels — a raw elapsed-ms floor would
 * call last night "today". Returns null for falsy/unusable input.
 */
export const calendarDaysSince = (ts, now = new Date()) => {
  const t = typeof ts === 'number' ? ts : parseInt(ts, 10);
  if (!Number.isFinite(t) || t <= 0) return null;
  const days = Math.round((startOfDay(now) - startOfDay(new Date(t))) / 86400000);
  return Math.max(0, days);
};

/**
 * Formats a Date/number/string as a short human-readable date, e.g. "15 Apr 2026".
 * Returns an empty string for falsy input.
 */
export const formatDate = (d) => {
  if (!d) {
    return '';
  }
  return new Date(d).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

/**
 * Formats a numeric (ms) or string-parseable timestamp as a long human-readable
 * date-time string, e.g. "15 Apr 2026, 02:30:15 PM".
 */
export const formatTimestamp = (timestamp) => {
  const date = new Date(parseInt(timestamp, 10));
  return date.toLocaleString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
};

/**
 * Formats a numeric (ms) or string-parseable timestamp as a compact
 * date-time string suitable for list rows, e.g. "15 Apr, 02:30 PM".
 * Returns an empty string when the timestamp is unusable.
 */
export const formatShortDateTime = (timestamp) => {
  const t = parseInt(timestamp, 10);
  if (!Number.isFinite(t)) {
    return '';
  }
  return new Date(t).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
};

/**
 * Formats a numeric (ms) or string-parseable timestamp as a clock time only,
 * e.g. "10:27 PM". Useful for pairing with a relative day label like
 * "yesterday". Returns an empty string when the timestamp is unusable.
 */
export const formatClockTime = (timestamp) => {
  const t = typeof timestamp === 'number' ? timestamp : parseInt(timestamp, 10);
  if (!Number.isFinite(t)) {
    return '';
  }
  return new Date(t).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
};

/**
 * Formats a call duration given in seconds as a compact human string, e.g.
 * "45s", "5m 12s", "1h 03m". Returns "0s" for a zero/negative/unusable input
 * (e.g. a missed or rejected call that never connected).
 */
export const formatDuration = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) {
    return `${total}s`;
  }
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) {
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins.toString().padStart(2, '0')}m`;
};

/**
 * Extracts a millisecond timestamp from a call-log record, preferring the
 * numeric `timestamp` field and falling back to parsing `dateTime`.
 * Returns 0 when neither field is usable.
 */
export const getLogTimestamp = (log) => {
  const parsed = parseInt(log?.timestamp, 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  if (log?.dateTime) {
    const t = new Date(log.dateTime).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
};

/**
 * Whether a call-log row counts as a connected (answered) call. The stored
 * `connected` boolean is the sole authority: if it's set, that's the answer —
 * duration is NOT consulted, so a 10-second call flagged connected reads
 * connected, and a 5-minute call flagged not-connected (e.g. an IVR/robot)
 * reads not-connected. Duration only seeds the *initial* value when a row has
 * no flag yet (legacy rows; new rows always persist one). The single source of
 * truth for "did this call connect?", used by the call-log viewer, the storage
 * layer, and the reconnect query.
 */
export const isLogConnected = (log) => {
  if (typeof log?.connected === 'boolean') {
    return log.connected;
  }
  return (Math.max(0, parseInt(log?.duration, 10) || 0)) > 60;
};
