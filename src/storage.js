import { storage } from './mmkv';
import { normalizeLast10 } from './utils/phone';
import { readJson, writeJson } from './utils/syncStoreMmkv';
import bundledMilestones from './data/milestones.json';

// All Connect Mode local state lives behind the `connect.*` namespace so it
// never collides with CRM Mode keys. Connect Mode is local-first: nothing
// here is required to be synced with the backend.
const K = {
  ONBOARDED: 'connect.onboarded',
  SETUP_COMPLETED: 'connect.setupCompleted',
  CONTACTS: 'connect.contacts',
  CALL_LOGS: 'connect.callLogs',
  LAST_ANALYZED_AT: 'connect.lastAnalyzedAt',
  GROUPS: 'connect.groups',
  CONTACT_GROUPS: 'connect.contactGroups',
  // Milestone definitions (achievements like "connect with 25 people" or a
  // "7-day streak"). These ship bundled in src/data/milestones.json and can
  // later be overwritten by a webserver payload via setMilestoneDefinitions.
  // MILESTONES_STATE tracks which ones the user has earned, keyed by id ->
  // achievedAt timestamp, so an earned badge survives a streak later lapsing.
  MILESTONE_DEFS: 'connect.milestoneDefs',
  MILESTONES_STATE: 'connect.milestonesState',
  // Phones (normalised, last-10) whose group memberships the user has
  // edited by hand. The categoriser skips these on re-runs so manual
  // corrections never get overwritten by the LLM.
  MANUAL_CONTACTS: 'connect.manualContacts',
  RECONNECTS: 'connect.reconnects',
  NOTES: 'connect.notes',
  GOALS: 'connect.goals',
  PREFERRED_MODE: 'connect.preferredMode',
  // When true the user opts into the power-user flow: LLM key, "tell us about
  // you", contact clustering, and the relationship-analysis step. Off by
  // default so first-run onboarding stays a quick import + hand-pick.
  ADVANCED_MODE: 'connect.advancedMode',
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

// ---------- Onboarding ----------

export const isOnboarded = () => Boolean(storage.getBoolean(K.ONBOARDED));

export const setOnboarded = (value) => storage.set(K.ONBOARDED, Boolean(value));

// True only after the user actually completes the analyze step. The
// `onboarded` flag flips true on "I will set this up later" too, so the
// gate uses this stricter signal to decide whether to show setup-pending.
export const isSetupCompleted = () => Boolean(storage.getBoolean(K.SETUP_COMPLETED));

export const setSetupCompleted = (value) =>
  storage.set(K.SETUP_COMPLETED, Boolean(value));

export const getPermsState = () =>
  readJson(K.PERMS, { contacts: 'unknown', callLog: 'unknown' });

export const setPermsState = (next) => writeJson(K.PERMS, next);

// ---------- Contacts ----------
// Stored as a flat array of { id, name, phone, normalized, label }
// where `normalized` is the last-10 digit key used everywhere as the join key.

export const getContacts = () => readJson(K.CONTACTS, []);

export const setContacts = (contacts) => writeJson(K.CONTACTS, contacts || []);

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
export const addCallLog = ({ phoneNumber, type, timestamp, duration } = {}) => {
  const entry = {
    phoneNumber: (phoneNumber || '').toString().trim(),
    timestamp: Number(timestamp) || Date.now(),
    dateTime: null,
    type: type || null,
    duration: Math.max(0, parseInt(duration, 10) || 0),
    manual: true,
  };
  if (!entry.phoneNumber) {
    return null;
  }
  const logs = getCallLogs();
  logs.unshift(entry);
  setCallLogs(logs);
  return entry;
};

export const getLastAnalyzedAt = () => storage.getNumber(K.LAST_ANALYZED_AT) || 0;

export const setLastAnalyzedAt = (ms) =>
  storage.set(K.LAST_ANALYZED_AT, Number(ms) || Date.now());

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
// When a user taps "Call" / "Mark as reconnected" we record a timestamp so we
// can surface a small "Recently Reconnected" section that reinforces the
// behaviour without feeling gamified.

export const getReconnects = () => readJson(K.RECONNECTS, {});

export const recordReconnect = (phone, ts = Date.now()) => {
  const key = normalizeLast10(phone);
  if (!key) { return false; }
  const map = getReconnects();
  // Only overwrite if the incoming timestamp is newer, so auto-detected
  // call-log entries from refresh never clobber a more recent in-app tap.
  if (map[key] && ts <= map[key]) { return false; }
  map[key] = ts;
  writeJson(K.RECONNECTS, map);
  return true;
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
  callLogs: [K.CALL_LOGS, K.LAST_ANALYZED_AT],
  contacts: [K.CONTACTS, K.DONT_SUGGEST],
  notes: [K.NOTES],
  reconnects: [K.RECONNECTS],
  goals: [K.GOALS],
  milestones: [K.MILESTONE_DEFS, K.MILESTONES_STATE],
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
  reconnects: {
    title: 'Reconnect history',
    description: 'When you last reached out to each person.',
    countField: 'reconnects',
    fields: [{ name: 'reconnects', mmkv: K.RECONNECTS, type: 'json' }],
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
  // If the user is restoring real data on a fresh install, flip the
  // onboarding flags so they land on Home instead of the welcome screen.
  if (applied.includes('contacts') || applied.includes('groups')) {
    storage.set(K.ONBOARDED, true);
    storage.set(K.SETUP_COMPLETED, true);
  }
  return { applied, skipped };
};
