import { Platform } from 'react-native';
import {
  getContacts,
  setContacts,
  getCallLogs,
  setCallLogs,
  setLastAnalyzedAt,
  getLastAnalyzedAt,
  getReconnects,
  getContactGroupMap,
  getGroups,
  getDontSuggestMap,
  setPermsState,
  reconcileProvisionalCalls,
} from '../storage';
import { analyzeRelationships } from './relationshipEngine';
import { loadPhoneBookContacts, ensureContactsPermission } from '../utils/phoneBook';
import {
  loadDeviceCallLogs,
  ensureCallLogPermission,
} from '../utils/deviceCallLog';
import { cleanupContacts } from '../utils/contactsCleanup';

// The cached call-log snapshot only stores the fields the engine needs, which
// keeps the MMKV payload small (an unfiltered call log on Android can run
// into the tens of thousands of rows).
const slimLog = (log) => ({
  phoneNumber: log?.phoneNumber || log?.number || log?.phone || '',
  timestamp:
    typeof log?.timestamp === 'number' ? log.timestamp : parseInt(log?.timestamp, 10) || null,
  dateTime: log?.dateTime || null,
  type: log?.type || log?.callType || null,
  duration: typeof log?.duration === 'number' ? log.duration : parseInt(log?.duration, 10) || 0,
});

// 2-minute window before the last sync covers small clock skew and entries
// the OS sometimes writes a moment late.
const INCREMENTAL_SAFETY_MS = 2 * 60 * 1000;

// Merge fresh delta-fetched call-log rows into the existing cached snapshot,
// deduplicating by (phone + timestamp). Order doesn't matter here — the
// engine sorts internally before walking.
const mergeCallLogs = (existing, fresh) => {
  const seen = new Set();
  const out = [];
  const push = (log) => {
    const ts = log?.timestamp || log?.dateTime || '';
    const key = `${log?.phoneNumber || ''}|${ts}`;
    if (seen.has(key)) { return; }
    seen.add(key);
    out.push(log);
  };
  (existing || []).forEach(push);
  (fresh || []).forEach(push);
  return out;
};

/**
 * Loads contacts + call logs from the device, persists slim snapshots to MMKV
 * for instant subsequent loads, and runs the relationship engine.
 *
 * @param {Object} opts
 * @param {boolean} [opts.refreshContacts=true]
 * @param {boolean} [opts.refreshCallLogs=true]
 * @param {number}  [opts.callLogLimit=-1]
 */
export const refreshAnalysis = async (opts = {}) => {
  const {
    refreshContacts = true,
    refreshCallLogs = true,
    callLogLimit = -1,
  } = opts;

  let contacts = getContacts();
  let callLogs = getCallLogs();

  if (refreshContacts) {
    try {
      const fresh = await loadPhoneBookContacts();
      if (Array.isArray(fresh) && fresh.length) {
        // Cleanup: merge same names, drop no-number rows. Keeps the dashboard
        // calm even when the address book is noisy.
        contacts = cleanupContacts(fresh);
        setContacts(contacts);
      }
    } catch (err) {
      console.warn('[connect/analysis] contacts refresh failed:', err?.message || err);
    }
  }

  let callLogRefreshError = null;
  if (refreshCallLogs && Platform.OS === 'android') {
    // Incremental mode: once we have a baseline, only fetch entries newer
    // than lastAnalyzedAt (minus a small safety buffer) and merge into the
    // existing cache. This makes pull-to-refresh and focus syncs nearly
    // instant on devices with large call logs, instead of re-reading every
    // row from the content provider each time.
    //
    // Crucially, we only go incremental when we actually have a prior call-log
    // snapshot to merge into. `lastAnalyzedAt` can be set by a run that never
    // imported call logs at all — e.g. the onboarding stage that imports
    // contacts only, or analysis that ran before call-log permission was
    // granted. In those cases the cache is empty and a 2-minute delta would
    // silently skip the user's entire call history, so we force a full import.
    const lastSync = getLastAnalyzedAt();
    const incremental = lastSync > 0 && callLogs.length > 0;
    try {
      // throwOnDeny so a silent permission revoke surfaces as a real error
      // instead of returning [] and wiping the cached snapshot below.
      const raw = await loadDeviceCallLogs(
        incremental
          ? {
              from: Math.max(0, lastSync - INCREMENTAL_SAFETY_MS),
              throwOnDeny: true,
            }
          : { limit: callLogLimit, throwOnDeny: true },
      );
      if (Array.isArray(raw)) {
        const slim = raw.map(slimLog).filter((l) => l.phoneNumber);
        // Hand-entered ("manual") rows aren't in the device call log, so a full
        // (non-incremental) import would drop them. Carry them across so a user
        // who logged a call by hand never loses it on a fresh re-import. In
        // incremental mode the existing snapshot already holds them, and the
        // merge below preserves them.
        const manual = (callLogs || []).filter((l) => l?.manual);
        callLogs = incremental
          ? mergeCallLogs(callLogs, slim)
          : mergeCallLogs(manual, slim);
        // Now that the real device rows are in, collapse any optimistic
        // provisional "tap" rows into their actual call-log entry so the
        // monitored truth (real type/duration; missed/no-answer) replaces the
        // guess instead of leaving a duplicate.
        callLogs = reconcileProvisionalCalls(callLogs);
        setCallLogs(callLogs);
      }
    } catch (err) {
      console.warn('[connect/analysis] call log refresh failed:', err?.message || err);
      callLogRefreshError = err?.message || 'Could not read your call log.';
      // Intentionally do NOT call setCallLogs(): preserve the previous
      // snapshot so the dashboard does not blank out on a transient failure.
    }
  }

  const contactGroups = getContactGroupMap();
  const groupsList = getGroups();
  const dontSuggest = getDontSuggestMap();

  // Reconnects are derived directly from the call-log store now, so a call made
  // from the system dialer (after a long quiet stretch) already counts as a
  // connected interaction — no separate auto-record pass is needed.
  const analysis = analyzeRelationships({
    contacts,
    callLogs,
    reconnects: getReconnects(),
    contactGroups,
    groups: groupsList,
    dontSuggest,
  });

  setLastAnalyzedAt(analysis.generatedAt);
  return { ...analysis, refreshError: callLogRefreshError };
};

/**
 * Lightweight refresh used on screen focus. Pulls only the call-log delta
 * since the last sync (skips the full phone-book re-import, since contacts
 * rarely change between focuses) and runs the engine. Designed to feel
 * "real-time" without the cost of a full re-import on every navigation.
 */
export const refreshAnalysisOnFocus = () =>
  refreshAnalysis({ refreshContacts: false });

/**
 * Runs analysis using whatever is in MMKV right now. No device IO.
 */
export const analyzeFromCache = () =>
  analyzeRelationships({
    contacts: getContacts(),
    callLogs: getCallLogs(),
    reconnects: getReconnects(),
    contactGroups: getContactGroupMap(),
    groups: getGroups(),
    dontSuggest: getDontSuggestMap(),
  });

/**
 * Convenience wrapper used by the onboarding flow. Asks for contacts (iOS +
 * Android) and, on Android only, the call log permission, then persists the
 * resolved permission state to MMKV so every entry point — not just
 * onboarding — leaves a consistent record behind. iOS has no public call-log
 * API, so its `callLog` is reported (and stored) as 'unsupported'.
 *
 * @returns {Promise<{contacts:Object, callLog:Object, perms:Object}>}
 */
export const requestImportPermissions = async () => {
  const contactsResult = await ensureContactsPermission();
  let callLogResult = { granted: false, supported: false };
  if (Platform.OS === 'android') {
    try {
      const ok = await ensureCallLogPermission();
      callLogResult = { granted: ok, supported: true };
    } catch (err) {
      callLogResult = { granted: false, supported: true, error: err?.message };
    }
  }

  // Normalised, persisted shape the UI and gates read back from MMKV.
  const perms = {
    contacts: contactsResult.granted
      ? 'granted'
      : contactsResult.blocked
      ? 'blocked'
      : 'denied',
    callLog:
      Platform.OS !== 'android'
        ? 'unsupported'
        : callLogResult.granted
        ? 'granted'
        : 'denied',
  };
  setPermsState(perms);

  return { contacts: contactsResult, callLog: callLogResult, perms };
};
