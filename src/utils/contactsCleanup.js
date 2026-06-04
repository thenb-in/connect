import { normalizeLast10 } from './phone';

// ---------------------------------------------------------------------------
// Connect Mode contact cleanup
// ---------------------------------------------------------------------------
// Pure functions that operate on the flattened phone-book shape produced by
// `loadPhoneBookContacts` — `[{ key, recordID, name, phone, normalized,
// label }]` — and return a tighter list with:
//
//   1. Rows that have no number stripped out.
//   2. Same-name rows merged. Each surviving row keeps the canonical key but
//      gains a `numbers: [{ phone, normalized, label }]` list of every number
//      seen for that name. The first numeric row stays as `phone` so the rest
//      of the app (which only reads `phone`) keeps working.
//
// We DO NOT delete entries that share a number with a differently-named
// contact — those are already deduped by phone in `phoneBook.js`. We only
// fold by name here. Two real people who happen to share a name are extremely
// rare in a personal address book; if it does happen the user can split them
// later. Trading a tiny merge-mistake risk for a much calmer dashboard.

const trimName = (name) => (name || '').trim();

const isPlaceholderName = (name) => {
  const lower = trimName(name).toLowerCase();
  return !lower || lower === 'unknown' || lower === 'no name';
};

const numberKey = (n) => (n?.normalized || normalizeLast10(n?.phone));

// When two rows for the same person merge, pick the first non-empty value
// across them so we don't lose org / birthday / address info that only one
// of the duplicate rows happened to carry.
const firstNonEmpty = (rows, key) => {
  for (const r of rows) {
    const v = r?.[key];
    if (v && (typeof v !== 'string' || v.trim())) return v;
  }
  return typeof rows[0]?.[key] === 'string' ? '' : null;
};

const mergeArrays = (rows, key) => {
  const out = [];
  const seen = new Set();
  rows.forEach((r) => {
    (r?.[key] || []).forEach((item) => {
      const sig = JSON.stringify(item);
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push(item);
    });
  });
  return out;
};

const collectExtras = (rows) => ({
  prefix: firstNonEmpty(rows, 'prefix'),
  suffix: firstNonEmpty(rows, 'suffix'),
  middleName: firstNonEmpty(rows, 'middleName'),
  company: firstNonEmpty(rows, 'company'),
  jobTitle: firstNonEmpty(rows, 'jobTitle'),
  department: firstNonEmpty(rows, 'department'),
  note: firstNonEmpty(rows, 'note'),
  birthday: firstNonEmpty(rows, 'birthday'),
  postalAddresses: mergeArrays(rows, 'postalAddresses'),
  emailAddresses: mergeArrays(rows, 'emailAddresses'),
});

/**
 * Drops rows that have no usable phone number.
 */
export const removeContactsWithoutNumber = (contacts) =>
  (contacts || []).filter((c) => {
    const phone = (c?.phone || '').toString().trim();
    const normalized = c?.normalized || normalizeLast10(phone);
    return Boolean(phone) && Boolean(normalized);
  });

/**
 * Merge same-name contacts into a single row. Placeholder names ("Unknown",
 * "No name", blank) are never merged — those are anonymous numbers that
 * shouldn't collapse into one synthetic contact.
 */
export const mergeContactsBySameName = (contacts) => {
  const buckets = new Map();
  const standalone = [];

  (contacts || []).forEach((c) => {
    const name = trimName(c?.name);
    if (isPlaceholderName(name)) {
      standalone.push(c);
      return;
    }
    const bucketKey = name.toLowerCase();
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(c);
  });

  const merged = [];
  buckets.forEach((rows) => {
    if (rows.length === 1) {
      merged.push({ ...rows[0], numbers: [
        { phone: rows[0].phone, normalized: rows[0].normalized, label: rows[0].label || '' },
      ] });
      return;
    }
    // Multiple rows share a name. Keep the first row's identity (recordID,
    // key, name) and collect every distinct number on it.
    const head = rows[0];
    const seen = new Set();
    const numbers = [];
    rows.forEach((r) => {
      const k = numberKey(r);
      if (!k || seen.has(k)) return;
      seen.add(k);
      numbers.push({ phone: r.phone, normalized: r.normalized, label: r.label || '' });
    });
    merged.push({
      key: head.key,
      recordID: head.recordID,
      name: head.name,
      phone: numbers[0]?.phone || head.phone,
      normalized: numbers[0]?.normalized || head.normalized,
      label: numbers[0]?.label || head.label || '',
      numbers,
      ...collectExtras(rows),
    });
  });

  // Append the placeholders (Unknown, No name, ...) untouched.
  standalone.forEach((c) =>
    merged.push({ ...c, numbers: [{ phone: c.phone, normalized: c.normalized, label: c.label || '' }] }),
  );

  return merged;
};

/**
 * Convenience wrapper: remove no-number rows, then merge by name.
 */
export const cleanupContacts = (contacts) =>
  mergeContactsBySameName(removeContactsWithoutNumber(contacts));
