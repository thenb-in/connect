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
