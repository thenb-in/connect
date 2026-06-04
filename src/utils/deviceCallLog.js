import { PermissionsAndroid, Platform } from 'react-native';
import { requestPermission } from './makeImmediateCall';

// react-native-call-log is Android-only. Require lazily so iOS never
// attempts to resolve a native module that does not exist.
const CallLogs = Platform.OS === 'android' ? require('react-native-call-log') : null;

/** Message thrown when user denies call log permission; UI can show "Open settings" for this. */
export const CALL_LOG_PERMISSION_DENIED_MESSAGE =
  'Call log access was denied. You can enable it in app settings.';

/**
 * Ensures READ_CALL_LOG permission. Returns true on grant.
 * Throws on non-Android, returns false when the user denies.
 */
export const ensureCallLogPermission = async ({ throwOnDeny = false } = {}) => {
  if (Platform.OS !== 'android') {
    // iOS has no public CallLog API. Treat as "no permission" so callers
    // gracefully fall back to whatever local/server data they have instead
    // of throwing a noisy error from every focus effect.
    return false;
  }

  const granted = await requestPermission(
    PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
    'Call log access',
    'Call Buddy uses call history to sync your calls with contacts and show them in Recent Calls.',
  );

  if (!granted) {
    if (throwOnDeny) {
      throw new Error(CALL_LOG_PERMISSION_DENIED_MESSAGE);
    }
    return false;
  }
  return true;
};

/**
 * Unified wrapper around `react-native-call-log` that handles permission and
 * filter shape. This is the ONLY place the app should call `CallLogs.load`.
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit=-1]        Max rows to return (-1 = unbounded).
 * @param {Date|number} [opts.from]       Lower bound (ms epoch or Date).
 * @param {Date|number} [opts.to]         Upper bound (ms epoch or Date).
 * @param {Array<string>} [opts.phoneNumbers] Optional phone filter. When a single
 *                                            element, the native module expects a string.
 * @param {boolean} [opts.throwOnDeny=false] Throw instead of returning [] on deny.
 * @returns {Promise<Array<Object>>} Device call log rows (raw shape from native module).
 */
export const loadDeviceCallLogs = async ({
  limit = -1,
  from,
  to,
  phoneNumbers,
  throwOnDeny = false,
} = {}) => {
  const hasPermission = await ensureCallLogPermission({ throwOnDeny });
  if (!hasPermission) {
    return [];
  }

  const filter = {};
  if (from !== undefined) {
    filter.minTimestamp = from instanceof Date ? from.getTime() : Number(from);
  }
  if (to !== undefined) {
    filter.maxTimestamp = to instanceof Date ? to.getTime() : Number(to);
  }
  if (Array.isArray(phoneNumbers) && phoneNumbers.length > 0) {
    filter.phoneNumbers = phoneNumbers.length === 1 ? phoneNumbers[0] : phoneNumbers;
  }

  const hasFilter = Object.keys(filter).length > 0;
  return hasFilter ? CallLogs.load(limit, filter) : CallLogs.load(limit);
};
