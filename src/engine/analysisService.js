import { Platform } from 'react-native';
import {
  getContacts,
  setContacts,
  getCallLogs,
  setCallLogs,
  setLastAnalyzedAt,
  getLastAnalyzedAt,
  hasCallLogBaseline,
  setCallLogBaseline,
  getReconnects,
  getContactGroupMap,
  getGroups,
  getDontSuggestMap,
  setPermsState,
  reconcileProvisionalCalls,
} from '../storage';
import { analyzeRelationships } from './relationshipEngine';
import { isLogConnected } from '../utils/dateUtils';
import { loadPhoneBookContacts, ensureContactsPermission } from '../utils/phoneBook';
import {
  loadDeviceCallLogs,
  ensureCallLogPermission,
} from '../utils/deviceCallLog';
import { cleanupContacts } from '../utils/contactsCleanup';

// The cached call-log snapshot only stores the fields the engine needs, which
// keeps the MMKV payload small (an unfiltered call log on Android can run
// into the tens of thousands of rows).
const slimLog = (log) => {
  const duration =
    typeof log?.duration === 'number' ? log.duration : parseInt(log?.duration, 10) || 0;
  return {
    phoneNumber: log?.phoneNumber || log?.number || log?.phone || '',
    timestamp:
      typeof log?.timestamp === 'number' ? log.timestamp : parseInt(log?.timestamp, 10) || null,
    dateTime: log?.dateTime || null,
    type: log?.type || log?.callType || null,
    duration,
    // `connected` is the stored source of truth for "did we actually talk".
    // Default rule: a call that lasted over a minute counts as connected. The
    // user can override it per-row in the call-log viewer (e.g. a 2-minute call
    // that was really an IVR/robot → mark not connected); that override is
    // flagged `connectedManual` and preserved across re-imports.
    connected: duration > 60,
  };
};

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
    // Crucially, we only go incremental once a FULL import has actually
    // completed at least once (the call-log baseline). `lastAnalyzedAt` and a
    // non-empty cache are NOT sufficient signals on their own:
    //   - `lastAnalyzedAt` can be set by a run that never imported call logs
    //     (the onboarding stage that imports contacts only, or analysis that ran
    //     before call-log permission was granted).
    //   - `callLogs.length > 0` can be true from a single optimistic provisional
    //     "tap" row, or from a setup that was interrupted after writing only a
    //     partial snapshot.
    // In both cases a 2-minute delta would silently skip the user's entire call
    // history — the bug where an established install shows an empty
    // "Missed connections" lane forever. Until the baseline is recorded, every
    // refresh re-imports the full log, which self-heals those installs on the
    // next focus/refresh without forcing the user back through onboarding.
    const lastSync = getLastAnalyzedAt();
    const incremental =
      hasCallLogBaseline() && lastSync > 0 && callLogs.length > 0;
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
        // Rows we must carry across a full (non-incremental) re-import, before
        // the fresh device rows, so mergeCallLogs keeps OUR copy (it dedupes by
        // phone+timestamp, first-wins):
        //   - `manual`: hand-entered calls that aren't in the device log at all.
        //   - `connectedManual`: device calls whose connected flag the user
        //     overrode — re-deriving from duration would silently undo it.
        // In incremental mode the existing snapshot already holds both and the
        // merge below preserves them.
        const preserved = (callLogs || []).filter(
          (l) => l?.manual || l?.connectedManual,
        );
        callLogs = incremental
          ? mergeCallLogs(callLogs, slim)
          : mergeCallLogs(preserved, slim);
        // Now that the real device rows are in, collapse any optimistic
        // provisional "tap" rows into their actual call-log entry so the
        // monitored truth (real type/duration; missed/no-answer) replaces the
        // guess instead of leaving a duplicate.
        callLogs = reconcileProvisionalCalls(callLogs);
        // Backfill: any legacy row imported before `connected` was persisted
        // gets the flag written once (seeded from the duration default). From
        // here on every read is driven purely by the stored flag — duration only
        // ever sets the initial value, never overrides a later decision.
        callLogs = callLogs.map((l) =>
          typeof l?.connected === 'boolean' ? l : { ...l, connected: isLogConnected(l) },
        );
        setCallLogs(callLogs);
        // Record the baseline once a full device import has actually landed, so
        // subsequent refreshes can safely take the cheap incremental path. We do
        // this only on the full-import branch — an incremental delta is, by
        // definition, not a complete snapshot.
        if (!incremental) {
          setCallLogBaseline();
        }
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
