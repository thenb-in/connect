import { Platform } from 'react-native';
import { storage } from './mmkv';
import { normalizeLast10 } from './utils/phone';
import { readJson, writeJson } from './utils/syncStoreMmkv';
import { getLogTimestamp, isLogConnected } from './utils/dateUtils';
import bundledMilestones from './data/milestones.json';
import {
  isOnboardingCompleteForCtx,
  firstIncompleteStep,
  evaluateSteps,
} from './onboarding/steps';

// All Connect Mode local state lives behind the `connect.*` namespace so it
// never collides with CRM Mode keys. Connect Mode is local-first: nothing
// here is required to be synced with the backend.
const K = {
  // Legacy completion flag from the pre-step-table onboarding. No longer
  // written; read once by migrateOnboardingState() to backfill the step table
  // for upgrading users, then consumed (deleted). The step table (below) is the
  // single source of truth.
  SETUP_COMPLETED: 'connect.setupCompleted',
  // The step-status table: the single authority for app entry and onboarding
  // resume. Stores only one-way decisions with no live OS signal to re-derive
  // from ({ welcome, llmKey, userContext, wantToConnect, analysed }) — permission
  // steps derive live from PERMS instead (see src/onboarding/steps.js). Walked
  // by clearConnectStorage on a full wipe like every key here.
  ONBOARDING_ACKS: 'connect.onboardingAcks',
  CONTACTS: 'connect.contacts',
  CALL_LOGS: 'connect.callLogs',
  LAST_ANALYZED_AT: 'connect.lastAnalyzedAt',
  // Timestamp of the first time a FULL device call-log import succeeded. This is
  // the real "we have a complete baseline" signal — distinct from "the cache is
  // non-empty", which can be true from a single provisional dialer row or an
  // interrupted setup. Incremental (delta) imports are only safe once this is
  // set; until then every refresh re-imports the full log, which self-heals
  // installs whose cache was only ever partially populated.
  CALL_LOG_BASELINE_AT: 'connect.callLogBaselineAt',
  GROUPS: 'connect.groups',
  CONTACT_GROUPS: 'connect.contactGroups',
  // Name-token clusters the user picked during onboarding's local clustering
  // step ("keywords you relate to" — recurring surnames/first names). Stored
  // as `[{ id, name, token, count, members:[normalizedPhone] }]`. These seed
  // the merge/delete review that turns them into real groups, and are kept so
  // the selection survives a re-run / can be revisited later.
  SELECTED_CLUSTERS: 'connect.selectedClusters',
  // Milestone definitions (achievements like "connect with 25 people" or a
  // "7-day streak"). These ship bundled in src/data/milestones.json and can
  // later be overwritten by a webserver payload via setMilestoneDefinitions.
  // MILESTONES_STATE tracks which ones the user has earned, keyed by id ->
  // achievedAt timestamp, so an earned badge survives a streak later lapsing.
  MILESTONE_DEFS: 'connect.milestoneDefs',
  MILESTONES_STATE: 'connect.milestonesState',
  // Forward-only cutoff for milestone progress: a timestamp stamped the first
  // time milestones are read, so achievements reward reconnecting from when the
  // user starts using the app rather than their imported call history. Only
  // connected calls at or after this count toward streaks / people / weekly.
  MILESTONE_SINCE: 'connect.milestoneSince',
  // Phones (normalised, last-10) whose group memberships the user has
  // edited by hand. The categoriser skips these on re-runs so manual
  // corrections never get overwritten by the LLM.
  MANUAL_CONTACTS: 'connect.manualContacts',
  NOTES: 'connect.notes',
  GOALS: 'connect.goals',
  PREFERRED_MODE: 'connect.preferredMode',
  // When true the user opts into the power-user flow: LLM key, "tell us about
  // you", contact clustering, and the relationship-analysis step. Off by
  // default so first-run onboarding stays a quick import + hand-pick.
  ADVANCED_MODE: 'connect.advancedMode',
  // iOS-only, advanced-mode opt-in: force-show home lanes that are normally
  // hidden on iOS when they have no data (e.g. "Missed connections").
  SHOW_HIDDEN_CARDS: 'connect.showHiddenCards',
  PERMS: 'connect.permsState',
  // Legacy single-key shape — migrated into LLM_KEYS / LLM_ACTIVE on first
  // read, then deleted. Kept here so clearConnectStorage still nukes them.
  LLM_PROVIDER: 'connect.llmProvider',
  LLM_KEY: 'connect.llmKey',
  // Multi-provider shape. LLM_KEYS is `{ google, openai, openrouter, ... }`,
  // LLM_ACTIVE is which provider's key to use for categorisation.
  LLM_KEYS: 'connect.llmKeys',
  LLM_ACTIVE: 'connect.llmActiveProvider',
  LAST_CATEGORIZED_AT: 'connect.lastCategorizedAt',
  CACHED_PROPOSAL: 'connect.cachedCategorization',
  GEMINI_MODEL: 'connect.geminiModel',
  DONT_SUGGEST: 'connect.dontSuggest',
  // Per-person "swipe up to dismiss" counter for the home spotlight deck.
  // Stored as `{ [normalizedPhone]: timesDismissed }`. A dismissed person is
  // held back from the deck while anyone un-dismissed remains; once everyone is
  // dismissed they resurface (least-dismissed first). Past CARD_DISMISS_LIMIT
  // dismissals a person is dropped from the deck entirely. Persisted so the
  // suppression escalates across sessions rather than resetting each launch.
  CARD_DISMISSALS: 'connect.cardDismissals',
  // Lightweight "about you" facts the user shares during onboarding (schools,
  // colleges, workplaces, places lived, free-text notes on how they save
  // contacts). All optional. Threaded into the LLM categorisation prompt so
  // the model can match contact-name cues against real institutions instead
  // of guessing — turns generic "DPS friends" / "IIT classmates" into the
  // user's actual cohorts.
  USER_PROFILE: 'connect.userProfile',
};

// ---------- Hardcoded categories ----------
// Every group (Family, College friends, Company A colleagues, ...) hangs off
// exactly one of these. Categories are not user-editable — they are a stable
// taxonomy the categorisation engine can reason about.

// Named ids let downstream code reference categories by symbol instead of
// re-typing the string literal in a dozen places. If a category id ever
// changes, only this block needs to move.
export const CATEGORY_ID = Object.freeze({
  FRIENDS: 'friends',
  RELATIVES: 'relatives',
  COLLEAGUES: 'colleagues',
  HELPERS: 'helpers',
  UNKNOWN: 'unknown',
});

export const CATEGORIES = Object.freeze([
  { id: CATEGORY_ID.FRIENDS, name: 'Friends', color: '#3C9D6A' },
  { id: CATEGORY_ID.RELATIVES, name: 'Family', color: '#C98A2E' },
  { id: CATEGORY_ID.COLLEAGUES, name: 'Office', color: '#5E35B1' },
  { id: CATEGORY_ID.HELPERS, name: 'Helpers', color: '#2F6F8F' },
  { id: CATEGORY_ID.UNKNOWN, name: 'Unknown', color: '#8C949B' },
]);

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

export const getCategoryById = (id) =>
  CATEGORIES.find((c) => c.id === id) || CATEGORIES.find((c) => c.id === CATEGORY_ID.UNKNOWN);

// ---------- Onboarding step table ----------
// The acks map holds the one-way "this step is done" decisions. See
// src/onboarding/steps.js for the registry that turns these (plus live perms,
// advanced mode, key/profile presence) into a single completeness verdict.

export const getOnboardingAcks = () => readJson(K.ONBOARDING_ACKS, {});

// Idempotent set-true. Returns the new map.
export const markOnboardingStep = (key) => {
  const acks = getOnboardingAcks();
  if (acks[key]) return acks;
  acks[key] = true;
  writeJson(K.ONBOARDING_ACKS, acks);
  return acks;
};

export const clearOnboardingAcks = () => storage.delete(K.ONBOARDING_ACKS);

// One-time bridge so users who completed the OLD multi-flag onboarding
// (SETUP_COMPLETED=true, no acks map) aren't bounced back through it. We backfill
// the step table, then CONSUME the legacy flag (delete it) so it can never
// resurrect completion after a deliberate acks-clear (delete-data / reset).
// Permission steps still derive live, which stays correct. Runs from
// buildOnboardingCtx; the acks-map presence check short-circuits it once seeded.
const migrateOnboardingState = () => {
  if (storage.getString(K.ONBOARDING_ACKS)) return; // already have a table
  if (storage.getBoolean(K.SETUP_COMPLETED)) {
    writeJson(K.ONBOARDING_ACKS, {
      welcome: true,
      llmKey: true,
      userContext: true,
      wantToConnect: true,
      analysed: true,
    });
  }
  storage.delete(K.SETUP_COMPLETED); // consume the legacy signal
};

// Live snapshot consumed by the step registry. Reads the OS permission state
// fresh so the gate always reflects reality (a revoke re-opens onboarding).
export const buildOnboardingCtx = () => {
  migrateOnboardingState();
  return {
    platform: Platform.OS,
    perms: getPermsState(),
    acks: getOnboardingAcks(),
  };
};

// Dev-only: dump the step-by-step gate evaluation to the console so the
// onboarding decision is observable in dev tools. Shows each step's
// applicable/complete/satisfied state, the first blocker, and the verdict.
const logOnboardingGate = (ctx, complete, firstBlocker) => {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  console.log(
    `[onboarding] gate → ${complete ? 'COMPLETE (Home)' : `incomplete, resume at "${firstBlocker?.key}"`}`,
    { platform: ctx.platform, perms: ctx.perms, acks: ctx.acks },
  );
  (console.table || console.log)(evaluateSteps(ctx));
};

export const isOnboardingComplete = () => {
  const ctx = buildOnboardingCtx();
  const complete = isOnboardingCompleteForCtx(ctx);
  logOnboardingGate(ctx, complete, complete ? null : firstIncompleteStep(ctx));
  return complete;
};

export const getPermsState = () =>
  readJson(K.PERMS, { contacts: 'unknown', callLog: 'unknown' });

export const setPermsState = (next) => writeJson(K.PERMS, next);

// ---------- Contacts ----------
// Stored as a flat array of { id, name, phone, normalized, label }
// where `normalized` is the last-10 digit key used everywhere as the join key.

export const getContacts = () => readJson(K.CONTACTS, []);

export const setContacts = (contacts) => writeJson(K.CONTACTS, contacts || []);

// ---------- Selected name-token clusters (onboarding "keywords") ----------
// The clusters the user picked in the local-clustering onboarding step. Each
// entry keeps its members so the proposal review can rebuild groups without
// re-running the clusterer.

export const getSelectedClusters = () => readJson(K.SELECTED_CLUSTERS, []);

export const setSelectedClusters = (clusters) =>
  writeJson(K.SELECTED_CLUSTERS, clusters || []);

// ---------- Call logs (raw, lightweight cache) ----------
// We only persist the fields the relationship engine needs so the snapshot
// stays small enough to keep in MMKV.

export const getCallLogs = () => readJson(K.CALL_LOGS, []);

export const setCallLogs = (logs) => writeJson(K.CALL_LOGS, logs || []);

// Append a hand-entered call to the saved snapshot. Mirrors the slim shape the
// engine reads (phoneNumber / timestamp / type / duration) and tags the row
// `manual: true` so a full device re-import — which replaces the whole
// snapshot — preserves it (see analysisService). Returns the stored entry, or
// null when no usable number was supplied.
//
// `madeBy` audits who created the row: 'user' for hand-logged calls (the
// default), 'system' for app-recorded reconnect taps. `connected` can be forced
// (system reconnect rows are connected with a blank duration); when omitted it
// falls back to the app-wide "lasted over a minute" rule.
//
// Call-monitoring fields (all optional, the engine ignores them):
//   callId      links a tapped call to its dialer entry and final monitored
//               result so the iOS CXCallObserver can fill in / remove the row.
//   provisional true for an optimistic "tap" row awaiting monitor correction.
//   source      'tap' | 'callkit' | 'calllog' | 'manual' — audit of origin.
export const addCallLog = ({
  phoneNumber,
  type,
  timestamp,
  duration,
  connected,
  madeBy = 'user',
  callId = null,
  provisional = false,
  source = null,
} = {}) => {
  const hasDuration = duration !== null && duration !== undefined && duration !== '';
  const durationSec = hasDuration ? Math.max(0, parseInt(duration, 10) || 0) : null;
  const entry = {
    phoneNumber: (phoneNumber || '').toString().trim(),
    timestamp: Number(timestamp) || Date.now(),
    dateTime: null,
    type: type || null,
    duration: durationSec,
    // A call counts as "connected" only when it actually lasted over a minute,
    // unless the caller forces the flag (system reconnect rows do).
    connected: typeof connected === 'boolean' ? connected : durationSec > 60,
    madeBy,
    manual: true,
    callId,
    provisional: Boolean(provisional),
    source,
  };
  if (!entry.phoneNumber) {
    return null;
  }
  const logs = getCallLogs();
  logs.unshift(entry);
  setCallLogs(logs);
  return entry;
};

// Patch a single saved call log by its index in the stored snapshot (e.g. to
// manually correct its `connected` status from the call-log viewer). Returns
// true when an entry was updated, false when the index was out of range.
export const updateCallLogAt = (index, patch = {}) => {
  const logs = getCallLogs();
  if (index < 0 || index >= logs.length) {
    return false;
  }
  logs[index] = { ...logs[index], ...patch };
  setCallLogs(logs);
  return true;
};

// Remove a single saved call log by its index in the stored snapshot. Returns
// true when an entry was removed, false when the index was out of range.
export const deleteCallLogAt = (index) => {
  const logs = getCallLogs();
  if (index < 0 || index >= logs.length) {
    return false;
  }
  logs.splice(index, 1);
  setCallLogs(logs);
  return true;
};

// ---------- Call monitoring: provisional rows ----------
// A "tap" writes a provisional, optimistic OUTGOING/connected row immediately so
// the UI feels responsive. The call monitor (iOS CXCallObserver, or the Android
// device call-log import) then reconciles it against what actually happened:
// filling in the real duration, or removing the row if the call never connected.

// Patch the call-log row carrying `callId`. Returns true when a row was updated.
export const updateCallByCallId = (callId, patch = {}) => {
  if (!callId) { return false; }
  const logs = getCallLogs();
  const idx = logs.findIndex((l) => l?.callId === callId);
  if (idx === -1) { return false; }
  logs[idx] = { ...logs[idx], ...patch };
  setCallLogs(logs);
  return true;
};

// Remove the call-log row carrying `callId`. Returns true when one was removed.
export const removeCallByCallId = (callId) => {
  if (!callId) { return false; }
  const logs = getCallLogs();
  const next = logs.filter((l) => l?.callId !== callId);
  if (next.length === logs.length) { return false; }
  setCallLogs(next);
  return true;
};

// How close (in ms) a real device call-log row must be to a provisional tap row,
// for the same number, to be considered the same call. The device writes the row
// at the actual call start, a beat or two after the tap.
const PROVISIONAL_MATCH_WINDOW_MS = 3 * 60 * 1000;

// Pure: drop provisional rows that a real (non-provisional) row for the same
// number now supersedes. Used after a device call-log import so the optimistic
// tap row collapses into the real entry (correct type/duration; missed/no-answer
// reflected) instead of leaving a duplicate. Returns a new array.
export const reconcileProvisionalCalls = (logs) => {
  const list = Array.isArray(logs) ? logs : [];
  const real = list.filter((l) => l && !l.provisional);
  return list.filter((log) => {
    if (!log?.provisional) { return true; }
    const key = normalizeLast10(log.phoneNumber);
    if (!key) { return true; }
    const ts = getLogTimestamp(log);
    const superseded = real.some((r) => {
      if (normalizeLast10(r.phoneNumber) !== key) { return false; }
      const rts = getLogTimestamp(r);
      return ts && rts && Math.abs(rts - ts) <= PROVISIONAL_MATCH_WINDOW_MS;
    });
    return !superseded;
  });
};

export const getLastAnalyzedAt = () => storage.getNumber(K.LAST_ANALYZED_AT) || 0;

export const setLastAnalyzedAt = (ms) =>
  storage.set(K.LAST_ANALYZED_AT, Number(ms) || Date.now());

// True once a full device call-log import has ever completed. Gates whether a
// refresh may take the cheap incremental (delta) path; see CALL_LOG_BASELINE_AT.
export const hasCallLogBaseline = () =>
  (storage.getNumber(K.CALL_LOG_BASELINE_AT) || 0) > 0;

export const setCallLogBaseline = (ms) =>
  storage.set(K.CALL_LOG_BASELINE_AT, Number(ms) || Date.now());

export const clearCallLogBaseline = () => storage.delete(K.CALL_LOG_BASELINE_AT);

// ---------- Groups ----------
// Groups are sub-labels (e.g. "IIT-B batch", "Company A colleagues",
// "Cousins"). A contact can belong to multiple groups. Every group hangs off
// exactly one hardcoded category via `categoryId`. We persist two structures
// so reads from either direction are fast:
//   - groups: [{ id, name, color, categoryId }]
//   - contactGroups: { [normalizedPhone]: [groupId, ...] }

const DEFAULT_GROUP_COLOR = '#E07856';

const normaliseGroup = (g) => {
  if (!g || typeof g !== 'object') return null;
  const categoryId = CATEGORY_IDS.has(g.categoryId) ? g.categoryId : 'unknown';
  const out = {
    id: g.id,
    name: g.name,
    color: g.color || DEFAULT_GROUP_COLOR,
    categoryId,
    doNotRemind: Boolean(g.doNotRemind),
  };
  // Standard groups (e.g. "Want to connect") carry a flag so surfaces can
  // treat them as built-in. Only persist it when true to keep the shape lean.
  if (g.standard) out.standard = true;
  return out;
};

// ---------- Standard groups ----------
// Built-in groups that ship with the app and are seeded during onboarding.
// Unlike the synthetic Unknown group these are REAL, persisted groups the user
// can add contacts to — they just start life with a stable, known id so we can
// reference and re-seed them. "Want to connect" is the first: the people the
// user hand-picks during setup to stay in touch with.
export const WANT_TO_CONNECT_GROUP_ID = 'g_want_to_connect';

const STANDARD_GROUPS = Object.freeze([
  Object.freeze({
    id: WANT_TO_CONNECT_GROUP_ID,
    name: 'Want to connect',
    color: '#E07856',
    categoryId: CATEGORY_ID.FRIENDS,
    standard: true,
  }),
]);

// Seeds any missing standard groups into the stored list, preserving the
// curated order (standard groups first). Idempotent — safe to call on every
// onboarding/setup pass. Returns the resulting groups list.
export const ensureStandardGroups = () => {
  const groups = getGroups();
  const existing = new Set(groups.map((g) => g.id));
  const missing = STANDARD_GROUPS.filter((g) => !existing.has(g.id));
  if (!missing.length) return groups;
  const next = [...missing, ...groups];
  setGroups(next);
  return getGroups();
};

// Returns the user's current groups. A missing key (fresh install or after a
// reset) returns an empty array — categorisation and manual creation fill it,
// and we never silently re-create groups that the user just deleted.
export const getGroups = () => {
  const groups = readJson(K.GROUPS, null);
  if (groups === null) return [];
  // Migrate pre-category groups in-place so older installs get a categoryId.
  let migrated = false;
  const normalised = (groups || []).map((g) => {
    if (!g) return null;
    if (g.categoryId && CATEGORY_IDS.has(g.categoryId)) return g;
    migrated = true;
    return normaliseGroup(g);
  }).filter(Boolean);
  if (migrated) writeJson(K.GROUPS, normalised);
  return normalised;
};

export const setGroups = (groups) =>
  writeJson(K.GROUPS, (groups || []).map(normaliseGroup).filter(Boolean));

export const addGroup = (name, color = DEFAULT_GROUP_COLOR, categoryId = CATEGORY_ID.UNKNOWN) => {
  const groups = getGroups();
  const id = `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const next = [
    ...groups,
    {
      id,
      name: name.trim(),
      color,
      categoryId: CATEGORY_IDS.has(categoryId) ? categoryId : CATEGORY_ID.UNKNOWN,
    },
  ];
  setGroups(next);
  return next.find((g) => g.id === id);
};

export const setGroupCategory = (groupId, categoryId) => {
  const next = getGroups().map((g) =>
    g.id === groupId
      ? { ...g, categoryId: CATEGORY_IDS.has(categoryId) ? categoryId : CATEGORY_ID.UNKNOWN }
      : g,
  );
  setGroups(next);
};

export const setGroupDoNotRemind = (groupId, value) => {
  const next = getGroups().map((g) =>
    g.id === groupId ? { ...g, doNotRemind: Boolean(value) } : g,
  );
  setGroups(next);
};

export const renameGroup = (id, name) => {
  const groups = getGroups().map((g) => (g.id === id ? { ...g, name } : g));
  setGroups(groups);
};

export const deleteGroup = (id) => {
  setGroups(getGroups().filter((g) => g.id !== id));
  const map = getContactGroupMap();
  Object.keys(map).forEach((phone) => {
    map[phone] = map[phone].filter((gid) => gid !== id);
    if (map[phone].length === 0) delete map[phone];
  });
  writeJson(K.CONTACT_GROUPS, map);
};

export const getContactGroupMap = () => readJson(K.CONTACT_GROUPS, {});

export const getGroupsForContact = (phone) => {
  const key = normalizeLast10(phone);
  if (!key) return [];
  const ids = getContactGroupMap()[key] || [];
  const groups = getGroups();
  return ids
    .map((id) => groups.find((g) => g.id === id))
    .filter(Boolean);
};

export const setGroupsForContact = (phone, groupIds) => {
  const key = normalizeLast10(phone);
  if (!key) return;
  const map = getContactGroupMap();
  if (groupIds && groupIds.length) {
    map[key] = [...new Set(groupIds)];
  } else {
    delete map[key];
  }
  writeJson(K.CONTACT_GROUPS, map);
  markContactsManual([key]);
};

/**
 * Append-merge the given groupId onto many contacts at once. Used by the
 * bulk-categorise screen — never replaces a contact's existing group list,
 * just unions the new group in. Returns the count of contacts actually
 * touched (skipping ones already in the group).
 */
export const addContactsToGroup = (phones, groupId) => {
  if (!groupId || !Array.isArray(phones) || !phones.length) return 0;
  const map = getContactGroupMap();
  let added = 0;
  const touchedKeys = [];
  phones.forEach((phone) => {
    const key = normalizeLast10(phone);
    if (!key) return;
    touchedKeys.push(key);
    const cur = new Set(map[key] || []);
    if (cur.has(groupId)) return;
    cur.add(groupId);
    map[key] = [...cur];
    added += 1;
  });
  if (added > 0) writeJson(K.CONTACT_GROUPS, map);
  // Mark every targeted contact as manual, even ones already in the group —
  // a user picking them into the bulk selection is an explicit signal.
  if (touchedKeys.length) markContactsManual(touchedKeys);
  return added;
};

/**
 * Remove the given groupId from many contacts at once — the inverse of
 * addContactsToGroup. Used by the group detail screen's multi-select to pull a
 * batch of members out of one group without touching their other memberships.
 * Returns the count of contacts actually removed (skipping ones not in the
 * group). A contact left in no groups is dropped from the map entirely.
 */
export const removeContactsFromGroup = (phones, groupId) => {
  if (!groupId || !Array.isArray(phones) || !phones.length) return 0;
  const map = getContactGroupMap();
  let removed = 0;
  const touchedKeys = [];
  phones.forEach((phone) => {
    const key = normalizeLast10(phone);
    if (!key) return;
    const cur = map[key];
    if (!cur || !cur.includes(groupId)) return;
    touchedKeys.push(key);
    const next = cur.filter((gid) => gid !== groupId);
    if (next.length) map[key] = next;
    else delete map[key];
    removed += 1;
  });
  if (removed > 0) writeJson(K.CONTACT_GROUPS, map);
  // A user hand-picking members to remove is an explicit signal, so lock them.
  if (touchedKeys.length) markContactsManual(touchedKeys);
  return removed;
};

export const toggleContactInGroup = (phone, groupId) => {
  const key = normalizeLast10(phone);
  if (!key) return [];
  const map = getContactGroupMap();
  const current = new Set(map[key] || []);
  if (current.has(groupId)) current.delete(groupId);
  else current.add(groupId);
  const arr = [...current];
  if (arr.length) map[key] = arr;
  else delete map[key];
  writeJson(K.CONTACT_GROUPS, map);
  markContactsManual([key]);
  return arr;
};

export const getContactsInGroup = (groupId, allContacts = null) => {
  const map = getContactGroupMap();
  if (groupId === UNKNOWN_GROUP_ID) {
    // Synthetic "Unknown" group = every contact not in any real group. We
    // need the full contact list to compute this; without it return [] so
    // call sites that just want a phone list (and didn't pass contacts) get
    // a safe default.
    if (!allContacts) return [];
    const grouped = new Set(
      Object.entries(map)
        .filter(([_, ids]) => ids && ids.length > 0)
        .map(([phone]) => phone),
    );
    return allContacts.filter((c) => !grouped.has(c.normalized));
  }
  const phones = Object.keys(map).filter((p) => (map[p] || []).includes(groupId));
  if (!allContacts) return phones;
  const set = new Set(phones);
  return (allContacts || []).filter((c) => set.has(c.normalized));
};

// ---------- Manual contact lock ----------
// Tracks contacts whose group memberships the user has touched by hand.
// `applyProposal` in the categoriser skips these so re-runs never overwrite
// a manual correction. Stored as a flat array of normalised phones.

export const getManualContacts = () => readJson(K.MANUAL_CONTACTS, []);

export const getManualContactsSet = () => new Set(getManualContacts());

export const markContactsManual = (phones) => {
  if (!Array.isArray(phones) || !phones.length) return;
  const current = new Set(getManualContacts());
  let changed = false;
  phones.forEach((p) => {
    const key = normalizeLast10(p);
    if (!key || current.has(key)) return;
    current.add(key);
    changed = true;
  });
  if (changed) writeJson(K.MANUAL_CONTACTS, [...current]);
};

export const isContactManual = (phone) => {
  const key = normalizeLast10(phone);
  if (!key) return false;
  return getManualContactsSet().has(key);
};

// The "Unknown" group is a virtual catch-all that dynamically contains every
// contact who isn't in any user-defined group. It's never stored in
// connect.groups or connect.contactGroups — getDisplayGroups appends it for
// surfaces that want to render it, and getContactsInGroup resolves its
// members on demand. Keeping it out of `getGroups()` means mutation paths
// (setGroups, deleteGroup, categoriser) stay simple and can never
// accidentally persist or delete the synthetic group.
export const UNKNOWN_GROUP_ID = '__unknown__';

const UNKNOWN_GROUP = Object.freeze({
  id: UNKNOWN_GROUP_ID,
  name: 'Unknown',
  color: '#8C949B',
  categoryId: CATEGORY_ID.UNKNOWN,
  synthetic: true,
});

export const getDisplayGroups = () => [...getGroups(), { ...UNKNOWN_GROUP }];

// Count of contacts currently in the synthetic Unknown group. Cheaper than
// resolving the full contact list when you only need the badge number.
export const getUnknownGroupCount = () => {
  const totalContacts = getContacts().length;
  const map = getContactGroupMap();
  // A contact only counts as "in some group" if at least one of its stored
  // groupIds still resolves to a real group — otherwise stale ids from
  // deleted groups would falsely shrink the Unknown badge.
  const validIds = new Set(getGroups().map((g) => g.id));
  const inSome = Object.values(map).filter(
    (ids) => Array.isArray(ids) && ids.some((id) => validIds.has(id)),
  ).length;
  return Math.max(0, totalContacts - inSome);
};

// ---------- Recently reconnected ----------
// "Reconnecting" with someone is recorded as a connected call-log row rather
// than a separate store, so there is one source of truth. Tapping "Call" or
// "Mark reconnected" appends a system-audited, connected row (blank duration)
// — this is the only reconnect signal on iOS (no call-log import) and for
// in-app actions the OS never sees. Reads derive the per-contact "last
// reconnected at" by scanning the call-log store for the newest connected row.

// Append a system-audited connected call for `phone`, stamping the reconnect.
// Returns true when a row was written. Kept name-compatible with the old
// reconnects-map API so existing call sites need no change.
export const recordReconnect = (phone, ts = Date.now()) => {
  const key = normalizeLast10(phone);
  if (!key) { return false; }
  return Boolean(
    addCallLog({
      phoneNumber: phone,
      type: 'OUTGOING',
      timestamp: ts,
      duration: null,
      connected: true,
      madeBy: 'system',
    }),
  );
};

// Optimistically record a tapped call as a provisional, connected reconnect row
// tagged with `callId`. The call monitor later corrects its duration or removes
// it (see updateCallByCallId / removeCallByCallId / reconcileProvisionalCalls).
// Returns true when a row was written.
export const recordProvisionalCall = (phone, callId, ts = Date.now()) => {
  const key = normalizeLast10(phone);
  if (!key) { return false; }
  return Boolean(
    addCallLog({
      phoneNumber: phone,
      type: 'OUTGOING',
      timestamp: ts,
      duration: null,
      connected: true,
      madeBy: 'system',
      callId,
      provisional: true,
      source: 'tap',
    }),
  );
};

// Derives { [normalizedPhone]: latestConnectedTs } from the call-log store,
// keeping the newest connected row per number. Replaces the old standalone
// reconnects map; every consumer (engine, milestones) reads the same shape.
export const getReconnects = () => {
  const map = {};
  (getCallLogs() || []).forEach((log) => {
    // Provisional rows are optimistic "tap" guesses awaiting reconciliation by
    // the iOS call monitor or an Android import. Don't count them as a confirmed
    // reconnect — an unanswered tap that the monitor later removes (or never
    // resolves) would otherwise inflate reconnect/milestone counts forever. Once
    // reconciled, the row is non-provisional and counts here.
    if (log?.provisional) { return; }
    if (!isLogConnected(log)) { return; }
    const key = normalizeLast10(log?.phoneNumber);
    if (!key) { return; }
    const ts = getLogTimestamp(log);
    if (!ts) { return; }
    if (!map[key] || ts > map[key]) { map[key] = ts; }
  });
  return map;
};

// The forward-only milestone cutoff. Lazily stamped to "now" the first time it
// is read so a returning user's imported call history never backfills
// achievements — only calls from when they start using Connect count. Persisted
// in MMKV so the cutoff survives restarts and call-log re-imports.
const getMilestoneSince = () => {
  let since = storage.getNumber(K.MILESTONE_SINCE) || 0;
  if (!since) {
    since = Date.now();
    storage.set(K.MILESTONE_SINCE, since);
  }
  return since;
};

// Every connected call (any direction) at or after the milestone cutoff, as a
// flat list of { phone, ts } — one entry per call, NOT collapsed per person, so
// the milestones engine can measure real per-day streaks. Provisional taps are
// excluded until the monitor/import confirms them (same rule as getReconnects).
// This is the milestones counterpart to getReconnects: the latter keeps the
// newest connected call per number (for the "recently reconnected" lane), this
// keeps every connected call (for streak / people / weekly progress).
export const getReconnectEvents = () => {
  const since = getMilestoneSince();
  const out = [];
  (getCallLogs() || []).forEach((log) => {
    if (log?.provisional) { return; }
    if (!isLogConnected(log)) { return; }
    const ts = getLogTimestamp(log);
    if (!ts || ts < since) { return; }
    const phone = normalizeLast10(log?.phoneNumber);
    if (!phone) { return; }
    out.push({ phone, ts });
  });
  return out;
};

// ---------- Milestones ----------
// Definitions are data: bundled defaults today, a webserver payload later.
// `getMilestoneDefinitions` returns the server-synced copy when present, else
// the bundled JSON, so the rest of the app reads from one place regardless of
// where the list came from. State is the per-id achievedAt map.

export const getMilestoneDefinitions = () => {
  const synced = readJson(K.MILESTONE_DEFS, null);
  if (synced && (Array.isArray(synced) ? synced.length : synced.milestones?.length)) {
    return synced;
  }
  return bundledMilestones;
};

// Persist a webserver-fetched milestone payload. Pass null to drop back to the
// bundled defaults. The shape is whatever the server sends — the engine
// normalises it before use, so this stays a dumb cache.
export const setMilestoneDefinitions = (defs) => {
  if (!defs) {
    storage.delete(K.MILESTONE_DEFS);
    return;
  }
  writeJson(K.MILESTONE_DEFS, defs);
};

export const getMilestonesState = () => readJson(K.MILESTONES_STATE, {});

// Records that a milestone was earned, stamping the first time we saw it as
// achieved. Never overwrites an existing timestamp, so the original earn date
// is preserved. Returns true when it actually recorded something new.
export const markMilestoneAchieved = (id, ts = Date.now()) => {
  if (!id) return false;
  const map = getMilestonesState();
  if (map[id]) return false;
  map[id] = Number(ts) || Date.now();
  writeJson(K.MILESTONES_STATE, map);
  return true;
};

// ---------- Don't suggest ----------
// Per-contact opt-out for the suggestion engine. Stored as
// `{ [normalizedPhone]: true }`. Contacts in the map are filtered out of every
// reminder lane (reconnectToday, lostConnections, neverConnected,
// missedCallsToReturn) but stay visible in informational surfaces (group
// detail, contact detail, recently reconnected).

export const getDontSuggestMap = () => readJson(K.DONT_SUGGEST, {});

export const isDontSuggest = (phone) => {
  const key = normalizeLast10(phone);
  if (!key) return false;
  return Boolean(getDontSuggestMap()[key]);
};

export const setDontSuggest = (phone, value) => {
  const key = normalizeLast10(phone);
  if (!key) return;
  const map = getDontSuggestMap();
  if (value) map[key] = true;
  else delete map[key];
  writeJson(K.DONT_SUGGEST, map);
};

export const toggleDontSuggest = (phone) => {
  const next = !isDontSuggest(phone);
  setDontSuggest(phone, next);
  return next;
};

// ---------- Card dismissals (home spotlight deck) ----------
// Counts how many times each person has been swiped up off the spotlight deck.
// Distinct from DONT_SUGGEST (a hard, explicit opt-out): a dismissal is a soft
// "not now" that escalates — see CARD_DISMISSALS above for how the home deck
// reads it. Past this many dismissals a person is never shown in the deck again.
export const CARD_DISMISS_LIMIT = 4000;  // want to turn this feature off, but not remove it hence marked a large number.

export const getCardDismissalMap = () => readJson(K.CARD_DISMISSALS, {});

export const getCardDismissalCount = (phone) => {
  const key = normalizeLast10(phone);
  if (!key) return 0;
  return getCardDismissalMap()[key] || 0;
};

// Bumps a person's dismissal count by one and persists it. Returns the new
// count (0 when the phone can't be normalised).
export const incrementCardDismissal = (phone) => {
  const key = normalizeLast10(phone);
  if (!key) return 0;
  const map = getCardDismissalMap();
  const next = (map[key] || 0) + 1;
  map[key] = next;
  writeJson(K.CARD_DISMISSALS, map);
  return next;
};

// ---------- Notes ----------

export const getAllNotes = () => readJson(K.NOTES, {});

export const getNote = (phone) => {
  const key = normalizeLast10(phone);
  if (!key) return '';
  return getAllNotes()[key] || '';
};

export const setNote = (phone, note) => {
  const key = normalizeLast10(phone);
  if (!key) return;
  const map = getAllNotes();
  if (note && note.trim()) map[key] = note;
  else delete map[key];
  writeJson(K.NOTES, map);
};

// ---------- Goals ----------
// Lightweight, soft goals like "reconnect with 5 people a week". Stored as a
// small list; the engine will use them only to render gentle progress hints.

export const getGoals = () =>
  readJson(K.GOALS, [
    { id: 'weekly-5', label: 'Reconnect with 5 people this week', target: 5, period: 'week' },
  ]);

export const setGoals = (goals) => writeJson(K.GOALS, goals || []);

// ---------- User profile ----------
// Optional context the user volunteers during onboarding. Every field is a
// short list of plain strings (or, for `savingLogic`, one free-text blob).
// Stored as a single JSON object so a fresh install can be exported / imported
// in one scope.

const EMPTY_USER_PROFILE = Object.freeze({
  schools: [],
  colleges: [],
  workplaces: [],
  placesStayed: [],
  savingLogic: '',
});

const sanitiseProfileList = (v) =>
  (Array.isArray(v) ? v : [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);

export const getUserProfile = () => {
  const raw = readJson(K.USER_PROFILE, null);
  if (!raw || typeof raw !== 'object') return { ...EMPTY_USER_PROFILE };
  return {
    schools: sanitiseProfileList(raw.schools),
    colleges: sanitiseProfileList(raw.colleges),
    workplaces: sanitiseProfileList(raw.workplaces),
    placesStayed: sanitiseProfileList(raw.placesStayed),
    savingLogic:
      typeof raw.savingLogic === 'string' ? raw.savingLogic.trim() : '',
  };
};

export const setUserProfile = (profile) => {
  if (!profile) {
    storage.delete(K.USER_PROFILE);
    return;
  }
  const clean = {
    schools: sanitiseProfileList(profile.schools),
    colleges: sanitiseProfileList(profile.colleges),
    workplaces: sanitiseProfileList(profile.workplaces),
    placesStayed: sanitiseProfileList(profile.placesStayed),
    savingLogic: (profile.savingLogic || '').toString().trim(),
  };
  const empty =
    !clean.schools.length &&
    !clean.colleges.length &&
    !clean.workplaces.length &&
    !clean.placesStayed.length &&
    !clean.savingLogic;
  if (empty) storage.delete(K.USER_PROFILE);
  else writeJson(K.USER_PROFILE, clean);
};

// Sum of all answers the user has given. Zero means the profile has never
// been touched — used to drive the onboarding step state.
export const userProfileEntryCount = (profile = null) => {
  const p = profile || getUserProfile();
  return (
    (p.schools?.length || 0) +
    (p.colleges?.length || 0) +
    (p.workplaces?.length || 0) +
    (p.placesStayed?.length || 0) +
    (p.savingLogic ? 1 : 0)
  );
};

export const hasUserProfile = () => userProfileEntryCount() > 0;

// ---------- LLM config ----------
// User-supplied API key for an LLM that does contact categorisation. Stored
// on-device so the categorisation engine can be called without a backend.
// Provider is one of 'google' (Google AI Studio / Gemini) or 'openai'.

export const LLM_PROVIDERS = Object.freeze(['google', 'openai', 'openrouter']);

// Single source of truth for the user-facing provider metadata. Every surface
// that mentions a provider (the modal, onboarding, settings) reads from here
// so the labels/links stay in sync.
export const LLM_PROVIDER_META = Object.freeze({
  google: Object.freeze({
    label: 'Google AI Studio',
    placeholder: 'AIza...',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    hint: 'Gemini models. Free tier works.',
  }),
  openai: Object.freeze({
    label: 'OpenAI',
    placeholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
    hint: 'gpt-4o-mini by default. Pay per token.',
  }),
  openrouter: Object.freeze({
    label: 'OpenRouter',
    placeholder: 'sk-or-...',
    docsUrl: 'https://openrouter.ai/keys',
    hint: 'Routes to many models (Gemini, Claude, GPT) with one key.',
  }),
});

// One-time migration from the legacy single-key shape (connect.llmProvider +
// connect.llmKey) into the keyed-by-provider shape. Runs lazily on first
// access — we don't want a side-effecting top-level call when the module is
// loaded in a test harness.
let migrated = false;
const migrateLegacyLlmConfig = () => {
  if (migrated) return;
  migrated = true;
  const legacyProvider = storage.getString(K.LLM_PROVIDER);
  const legacyKey = storage.getString(K.LLM_KEY);
  if (!legacyProvider || !legacyKey) return;
  // Don't overwrite if the new shape already has something.
  const existing = readJson(K.LLM_KEYS, null);
  if (existing && Object.keys(existing).length) {
    storage.delete(K.LLM_PROVIDER);
    storage.delete(K.LLM_KEY);
    return;
  }
  writeJson(K.LLM_KEYS, { [legacyProvider]: legacyKey });
  storage.set(K.LLM_ACTIVE, legacyProvider);
  storage.delete(K.LLM_PROVIDER);
  storage.delete(K.LLM_KEY);
};

// Returns `{ [provider]: key }` for every configured key. Empty object when
// nothing is set up.
export const getLlmKeys = () => {
  migrateLegacyLlmConfig();
  return readJson(K.LLM_KEYS, {}) || {};
};

export const getActiveLlmProvider = () => {
  migrateLegacyLlmConfig();
  const v = storage.getString(K.LLM_ACTIVE) || null;
  if (v && LLM_PROVIDERS.includes(v)) return v;
  return null;
};

export const setActiveLlmProvider = (provider) => {
  if (provider && LLM_PROVIDERS.includes(provider)) {
    storage.set(K.LLM_ACTIVE, provider);
  } else {
    storage.delete(K.LLM_ACTIVE);
  }
};

// Save (or remove, with `key = null`) a single provider's key. When a key is
// added and no provider is currently active, this one becomes active. When
// the active provider's key is removed, the next remaining key becomes
// active so categorisation keeps working.
export const setLlmKeyForProvider = (provider, key) => {
  if (!provider || !LLM_PROVIDERS.includes(provider)) return;
  const keys = getLlmKeys();
  const trimmed = (key || '').trim();
  if (trimmed) {
    keys[provider] = trimmed;
  } else {
    delete keys[provider];
  }
  writeJson(K.LLM_KEYS, keys);

  const active = getActiveLlmProvider();
  if (trimmed && !active) {
    setActiveLlmProvider(provider);
  } else if (!trimmed && active === provider) {
    const remaining = Object.keys(keys);
    setActiveLlmProvider(remaining[0] || null);
  }
};

export const removeLlmKey = (provider) => setLlmKeyForProvider(provider, null);

// Returns the active { provider, key } pair, or both-null when nothing is
// configured. Used everywhere categorisation needs to call out.
export const getLlmConfig = () => {
  const provider = getActiveLlmProvider();
  if (!provider) {
    // No explicit active — fall back to first configured key.
    const keys = getLlmKeys();
    const first = Object.keys(keys)[0];
    if (first) {
      setActiveLlmProvider(first);
      return { provider: first, key: keys[first] };
    }
    return { provider: null, key: null };
  }
  const keys = getLlmKeys();
  return { provider, key: keys[provider] || null };
};

// Back-compat shim: previously this took (provider, key) and stored a single
// pair. Now it sets that provider's key in the dict and makes it active.
// Passing nullish either argument clears EVERY configured key.
export const setLlmConfig = (provider, key) => {
  if (!provider || !key) {
    storage.delete(K.LLM_KEYS);
    storage.delete(K.LLM_ACTIVE);
    return;
  }
  if (!LLM_PROVIDERS.includes(provider)) return;
  setLlmKeyForProvider(provider, key);
  setActiveLlmProvider(provider);
};

export const clearLlmConfig = () => {
  storage.delete(K.LLM_KEYS);
  storage.delete(K.LLM_ACTIVE);
  storage.delete(K.LLM_PROVIDER);
  storage.delete(K.LLM_KEY);
};

// True when ANY provider has a key configured.
export const hasLlmKey = () => Object.keys(getLlmKeys()).length > 0;

// Per-provider check (e.g. "do we have a Gemini key?").
export const hasLlmKeyFor = (provider) => Boolean(getLlmKeys()[provider]);

// The active Gemini model is discovered via the ListModels endpoint on first
// use and cached here so we don't pay the discovery round-trip every time.
// On a 404 from the cached model (the most common deprecation symptom) the
// categoriser clears this and re-discovers.
export const getCachedGeminiModel = () => storage.getString(K.GEMINI_MODEL) || null;

export const setCachedGeminiModel = (model) => {
  if (model) storage.set(K.GEMINI_MODEL, model);
  else storage.delete(K.GEMINI_MODEL);
};

export const getLastCategorizedAt = () =>
  storage.getNumber(K.LAST_CATEGORIZED_AT) || 0;

export const setLastCategorizedAt = (ms) =>
  storage.set(K.LAST_CATEGORIZED_AT, Number(ms) || Date.now());

// ---------- Preferred mode ----------
// When a logged-in user chooses Connect, remember that across sessions so the
// app respects their preference instead of always defaulting back to CRM.

export const getPreferredMode = () =>
  storage.getString(K.PREFERRED_MODE) || null;

export const setPreferredMode = (mode) => {
  if (mode === 'crm' || mode === 'connect') {
    storage.set(K.PREFERRED_MODE, mode);
  } else {
    storage.delete(K.PREFERRED_MODE);
  }
};

// ---------- Advanced mode ----------
// Power-user opt-in. Gates the LLM key, user-context, clustering, and
// relationship-analysis steps in onboarding, and the AI-categorisation
// section in Settings. Defaults to false (simple mode).

export const getAdvancedMode = () => Boolean(storage.getBoolean(K.ADVANCED_MODE));

export const setAdvancedMode = (value) =>
  storage.set(K.ADVANCED_MODE, Boolean(value));

// ---------- Show hidden cards (iOS) ----------
// On iOS the call-history-derived home lanes are hidden when they have no data
// (there's no call log to populate them). This advanced-mode toggle forces them
// to show anyway, with their empty states — useful for debugging / power users.

export const getShowHiddenCards = () =>
  Boolean(storage.getBoolean(K.SHOW_HIDDEN_CARDS));

export const setShowHiddenCards = (value) =>
  storage.set(K.SHOW_HIDDEN_CARDS, Boolean(value));

// ---------- Clear all (used by logout or factory reset) ----------

export const clearConnectStorage = () => {
  Object.values(K).forEach((key) => {
    try {
      storage.delete(key);
    } catch {}
  });
};

// Scopes the user can selectively wipe from Settings → Delete data. Each
// scope maps to the set of MMKV keys it owns. `everything` is the existing
// `clearConnectStorage` behaviour and also clears onboarding/setup flags so
// the user lands back at the welcome screen.
const SCOPE_KEYS = {
  llmKey: [K.LLM_PROVIDER, K.LLM_KEY, K.LLM_KEYS, K.LLM_ACTIVE, K.GEMINI_MODEL],
  groups: [K.GROUPS, K.CONTACT_GROUPS, K.MANUAL_CONTACTS, K.LAST_CATEGORIZED_AT, K.CACHED_PROPOSAL],
  callLogs: [K.CALL_LOGS, K.LAST_ANALYZED_AT, K.CALL_LOG_BASELINE_AT],
  contacts: [K.CONTACTS, K.DONT_SUGGEST, K.CARD_DISMISSALS],
  notes: [K.NOTES],
  goals: [K.GOALS],
  milestones: [K.MILESTONE_DEFS, K.MILESTONES_STATE, K.MILESTONE_SINCE],
  userProfile: [K.USER_PROFILE],
};

export const clearConnectStorageSelective = (scopes) => {
  const set = new Set(scopes || []);
  if (set.has('everything')) {
    clearConnectStorage();
    return;
  }
  set.forEach((scope) => {
    (SCOPE_KEYS[scope] || []).forEach((key) => {
      try {
        storage.delete(key);
      } catch {}
    });
  });
};

// ---------- Export / import ----------
// Portable, human-inspectable JSON snapshot of selected scopes. The schema
// names each MMKV key so the on-disk file stays readable and the import path
// can ignore unknown fields without crashing. Keep field `name`s stable across
// versions; new fields can be appended but never renamed.
const EXPORT_SCOPE_SCHEMA = Object.freeze({
  llmKey: {
    title: 'LLM keys',
    description: 'Provider API keys and active provider.',
    countField: 'keys',
    fields: [
      { name: 'keys', mmkv: K.LLM_KEYS, type: 'json' },
      { name: 'active', mmkv: K.LLM_ACTIVE, type: 'string' },
      { name: 'geminiModel', mmkv: K.GEMINI_MODEL, type: 'string' },
    ],
  },
  groups: {
    title: 'Groups & memberships',
    description: 'Custom groups and which contacts belong to which.',
    countField: 'groups',
    fields: [
      { name: 'groups', mmkv: K.GROUPS, type: 'json' },
      { name: 'contactGroups', mmkv: K.CONTACT_GROUPS, type: 'json' },
      { name: 'manualContacts', mmkv: K.MANUAL_CONTACTS, type: 'json' },
      { name: 'lastCategorizedAt', mmkv: K.LAST_CATEGORIZED_AT, type: 'number' },
      { name: 'cachedProposal', mmkv: K.CACHED_PROPOSAL, type: 'json' },
    ],
  },
  callLogs: {
    title: 'Call log snapshot',
    description: 'Cached call history used by the relationship engine.',
    countField: 'callLogs',
    fields: [
      { name: 'callLogs', mmkv: K.CALL_LOGS, type: 'json' },
      { name: 'lastAnalyzedAt', mmkv: K.LAST_ANALYZED_AT, type: 'number' },
    ],
  },
  contacts: {
    title: 'Contacts cache',
    description: 'Local address book Connect reads from.',
    countField: 'contacts',
    fields: [
      { name: 'contacts', mmkv: K.CONTACTS, type: 'json' },
      { name: 'dontSuggest', mmkv: K.DONT_SUGGEST, type: 'json' },
    ],
  },
  notes: {
    title: 'Notes',
    description: 'Per-contact notes.',
    countField: 'notes',
    fields: [{ name: 'notes', mmkv: K.NOTES, type: 'json' }],
  },
  goals: {
    title: 'Goals',
    description: 'Soft connection goals.',
    countField: 'goals',
    fields: [{ name: 'goals', mmkv: K.GOALS, type: 'json' }],
  },
  userProfile: {
    title: 'Your context',
    description:
      'Schools, colleges, workplaces, places lived, and saving-logic notes used to improve LLM grouping.',
    countField: 'profile',
    // Counted by total answers (schools + colleges + … + 1 if notes), not by
    // object-key count — gives a meaningful "X entries" label.
    countFn: (v) => userProfileEntryCount(v),
    fields: [{ name: 'profile', mmkv: K.USER_PROFILE, type: 'json' }],
  },
});

const EXPORT_FORMAT = 'callbuddy-connect-export';
const EXPORT_VERSION = 1;

const readExportField = ({ mmkv, type }) => {
  if (type === 'number') {
    const v = storage.getNumber(mmkv);
    return v ? v : null;
  }
  if (type === 'boolean') {
    const v = storage.getBoolean(mmkv);
    return v === undefined ? null : v;
  }
  if (type === 'json') {
    const raw = storage.getString(mmkv);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  return storage.getString(mmkv) || null;
};

const writeImportField = ({ mmkv, type }, value) => {
  if (value === null || value === undefined) return;
  try {
    if (type === 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) storage.set(mmkv, n);
    } else if (type === 'boolean') {
      storage.set(mmkv, Boolean(value));
    } else if (type === 'json') {
      storage.set(mmkv, JSON.stringify(value));
    } else {
      storage.set(mmkv, String(value));
    }
  } catch {}
};

const countOf = (v) => {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return v ? 1 : 0;
};

// User-facing scope list for the export / import UI. Same order as the delete
// flow so the surfaces feel consistent.
export const EXPORT_SCOPES = Object.entries(EXPORT_SCOPE_SCHEMA).map(
  ([id, s]) => ({ id, title: s.title, description: s.description }),
);

// Count of "items" inside a scope as it sits in MMKV right now. Used to label
// the export checklist (e.g. "Groups · 14 entries").
export const getExportScopeCount = (scope) => {
  const schema = EXPORT_SCOPE_SCHEMA[scope];
  if (!schema) return 0;
  const field = schema.fields.find((f) => f.name === schema.countField);
  if (!field) return 0;
  const value = readExportField(field);
  return schema.countFn ? schema.countFn(value) : countOf(value);
};

// Count of items inside a scope as it sits inside a parsed import payload.
export const getImportScopeCount = (payload, scope) => {
  const schema = EXPORT_SCOPE_SCHEMA[scope];
  const body = payload?.scopes?.[scope];
  if (!schema || !body) return 0;
  const value = body[schema.countField];
  return schema.countFn ? schema.countFn(value) : countOf(value);
};

export const listImportableScopes = (payload) => {
  if (!payload || !payload.scopes) return [];
  return Object.keys(payload.scopes).filter((s) => {
    if (!EXPORT_SCOPE_SCHEMA[s]) return false;
    const body = payload.scopes[s];
    return body && Object.keys(body).length > 0;
  });
};

export const isValidImportPayload = (payload) =>
  Boolean(payload) && payload.format === EXPORT_FORMAT && payload.scopes;

export const buildConnectExport = (scopes) => {
  migrateLegacyLlmConfig();
  const selected = scopes && scopes.length
    ? scopes
    : Object.keys(EXPORT_SCOPE_SCHEMA);
  const out = {};
  selected.forEach((scope) => {
    const schema = EXPORT_SCOPE_SCHEMA[scope];
    if (!schema) return;
    const body = {};
    let any = false;
    schema.fields.forEach((f) => {
      const v = readExportField(f);
      if (v !== null && v !== '') {
        body[f.name] = v;
        any = true;
      }
    });
    if (any) out[scope] = body;
  });
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    scopes: out,
  };
};

// Writes selected scopes from an import payload back into MMKV. Each scope is
// replaced wholesale — importing `groups` overwrites the current groups list,
// it doesn't merge. Returns the list of scopes that actually got applied.
export const applyConnectImport = (payload, scopes) => {
  if (!isValidImportPayload(payload)) return { applied: [], skipped: [] };
  const requested = scopes && scopes.length
    ? scopes
    : Object.keys(payload.scopes);
  const applied = [];
  const skipped = [];
  requested.forEach((scope) => {
    const schema = EXPORT_SCOPE_SCHEMA[scope];
    const body = payload.scopes[scope];
    if (!schema || !body) {
      skipped.push(scope);
      return;
    }
    // Clear the scope's MMKV keys first so a value that's now missing from
    // the payload (e.g. user revoked their LLM key before exporting) doesn't
    // linger on the device.
    (SCOPE_KEYS[scope] || []).forEach((key) => {
      try { storage.delete(key); } catch {}
    });
    schema.fields.forEach((f) => {
      if (body[f.name] === undefined) return;
      writeImportField(f, body[f.name]);
    });
    applied.push(scope);
  });
  // If the user is restoring real data on a fresh install, seed the step table
  // so they land on Home instead of the welcome screen.
  if (applied.includes('contacts') || applied.includes('groups')) {
    writeJson(K.ONBOARDING_ACKS, {
      welcome: true,
      llmKey: true,
      userContext: true,
      wantToConnect: true,
      analysed: true,
    });
  }
  return { applied, skipped };
};
