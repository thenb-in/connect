import { PermissionsAndroid, Platform } from 'react-native';
import Contacts from 'react-native-contacts';
import { normalizeLast10 } from './phone';

/**
 * Checks (and requests if needed) the READ_CONTACTS permission.
 * @returns {Promise<{granted: boolean, blocked: boolean}>}
 */
export const ensureContactsPermission = async () => {
  if (Platform.OS !== 'android') {
    try {
      const status = await Contacts.requestPermission();
      return {
        granted: status === 'authorized' || status === 'limited',
        blocked: status === 'denied',
      };
    } catch {
      return { granted: false, blocked: false };
    }
  }
  try {
    const already = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
    );
    if (already) return { granted: true, blocked: false };
    const res = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
      {
        title: 'Contacts Permission',
        message: 'Allow access to your phone book to import contacts.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      },
    );
    return {
      granted: res === PermissionsAndroid.RESULTS.GRANTED,
      blocked: res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
    };
  } catch (err) {
    console.warn('[phoneBook] permission error:', err);
    return { granted: false, blocked: false };
  }
};

// Builds the human-readable name, INCLUDING prefix/suffix when present.
// Prefix ("Dr.", "Prof.", "Adv.") and suffix ("Sir", "Jr", "PhD") are strong
// categorisation signals that the platform's displayName may strip.
const buildDisplayName = (c) => {
  const prefix = (c.prefix || '').trim();
  const suffix = (c.suffix || '').trim();
  const display = (c.displayName || '').trim();
  if (display) {
    const lower = display.toLowerCase();
    const parts = [];
    if (prefix && !lower.startsWith(prefix.toLowerCase())) parts.push(prefix);
    parts.push(display);
    if (suffix && !lower.endsWith(suffix.toLowerCase())) parts.push(suffix);
    return parts.join(' ');
  }
  const composed = [c.prefix, c.givenName, c.middleName, c.familyName, c.suffix]
    .filter(Boolean)
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(' ');
  return composed || 'Unknown';
};

const extractContactExtras = (c) => {
  const birthday = c.birthday && (
    c.birthday.year != null ||
    c.birthday.month != null ||
    c.birthday.day != null
  )
    ? {
        year: c.birthday.year ?? null,
        month: c.birthday.month ?? null,
        day: c.birthday.day ?? null,
      }
    : null;
  const postalAddresses = Array.isArray(c.postalAddresses)
    ? c.postalAddresses
        .map((a) => ({
          label: a?.label || '',
          street: a?.street || '',
          city: a?.city || '',
          state: a?.state || a?.region || '',
          postCode: a?.postCode || '',
          country: a?.country || '',
        }))
        .filter((a) => a.street || a.city || a.state || a.postCode || a.country)
    : [];
  const emailAddresses = Array.isArray(c.emailAddresses)
    ? c.emailAddresses
        .map((e) => ({ label: e?.label || '', email: (e?.email || '').trim() }))
        .filter((e) => e.email)
    : [];
  return {
    prefix: (c.prefix || '').trim(),
    suffix: (c.suffix || '').trim(),
    middleName: (c.middleName || '').trim(),
    company: (c.company || '').trim(),
    jobTitle: (c.jobTitle || '').trim(),
    department: (c.department || '').trim(),
    note: (c.note || '').trim(),
    birthday,
    postalAddresses,
    emailAddresses,
  };
};

const flattenPhoneBookContacts = (raw) => {
  const flat = [];
  raw.forEach((c) => {
    const name = buildDisplayName(c);
    const extras = extractContactExtras(c);
    (c.phoneNumbers || []).forEach((pn, idx) => {
      const digits = (pn?.number || '').replace(/\s|-|\(|\)/g, '');
      if (!digits) return;
      flat.push({
        key: `${c.recordID}-${idx}`,
        recordID: c.recordID,
        name,
        phone: digits,
        normalized: normalizeLast10(digits),
        label: pn.label || '',
        ...extras,
      });
    });
  });
  return flat;
};

const dedupeByPhone = (list) => {
  const seen = new Set();
  const result = [];
  list.forEach((item) => {
    const key = item.normalized || item.phone;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(item);
  });
  return result;
};

/**
 * Reads the device phone book, flattens each phone number into its own row,
 * deduplicates by last-10 digits, and sorts alphabetically.
 */
export const loadPhoneBookContacts = async () => {
  const raw = await Contacts.getAllWithoutPhotos();
  const flat = dedupeByPhone(flattenPhoneBookContacts(raw || []));
  flat.sort((a, b) => a.name.localeCompare(b.name));
  return flat;
};
