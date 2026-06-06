import { normalizeLast10 } from '../utils/phone';
import { CATEGORY_ID } from '../storage';

// ---------------------------------------------------------------------------
// Relationship Intelligence Engine
// ---------------------------------------------------------------------------
// Pure functions only. Given a list of contacts and a list of call-log rows,
// produce a per-contact "relationship profile" with:
//   - communication summary (counts, last/first timestamps, span)
//   - derived signals (dormant strong, dormant weak, recently reconnected)
//   - a relationship score and a reconnect-priority score
//
// The engine never reads from storage directly; callers pass the data in. That
// keeps it trivial to unit test and keeps the UI free to choose what subset
// of the device data to analyze.
//
// All times are in milliseconds since epoch.

const DAY_MS = 24 * 60 * 60 * 1000;

// Tunable thresholds. We expose them so callers (and tests) can tweak the
// heuristics without forking the engine.
export const DEFAULTS = Object.freeze({
  recentWindowDays: 30,
  midWindowDays: 90,
  longWindowDays: 365,
  // A contact is treated as "strong historical" if they have >= this many
  // total interactions OR exceeded the peak-frequency floor at any point.
  strongTotalInteractions: 8,
  strongPeakPerMonth: 4,
  // Dormancy: no contact for at least N days.
  dormantAfterDays: 90,
  // Reconnect recommendations only surface a contact once it has been at least
  // this long since the last call (3 months) — or if you have never called
  // them at all. Keeps the suggestion lanes from nudging you about people you
  // already spoke to recently.
  reconnectMinDays: 90,
  // "Recently reconnected" window: last interaction within N days following a
  // long prior gap.
  recentReconnectWithinDays: 21,
  recentReconnectPriorGapDays: 90,
});

// How many of a contact's most recent calls we keep on the profile for the
// detail screen's "Recent calls" list. The full slim log still lives in MMKV;
// this is just the rendered tail so the profile payload stays small.
const RECENT_CALLS_CAP = 25;

const safeNumber = (value) => {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
};

const getLogTs = (log) => {
  const direct = safeNumber(log?.timestamp);
  if (direct) return direct;
  if (log?.dateTime) {
    const parsed = new Date(log.dateTime).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const getLogType = (log) => {
  // react-native-call-log returns one of: INCOMING, OUTGOING, MISSED,
  // REJECTED, BLOCKED, VOICEMAIL. We collapse to a small set.
  const raw = (log?.type || log?.callType || '').toString().toUpperCase();
  if (raw.includes('OUT')) return 'outgoing';
  if (raw.includes('MISS')) return 'missed';
  if (raw.includes('REJ')) return 'rejected';
  if (raw.includes('IN')) return 'incoming';
  return 'other';
};

const getLogDuration = (log) => Math.max(0, safeNumber(log?.duration));

/**
 * Groups raw call-log rows by normalized last-10-digit phone number.
 * @param {Array<Object>} callLogs
 * @returns {Map<string, Array<Object>>}
 */
export const groupCallLogsByPhone = (callLogs) => {
  const out = new Map();
  (callLogs || []).forEach((log) => {
    const key = normalizeLast10(log?.phoneNumber || log?.number || log?.phone);
    if (!key) return;
    const arr = out.get(key) || [];
    arr.push(log);
    out.set(key, arr);
  });
  return out;
};

/**
 * Computes a single contact's interaction summary from their call-log rows.
 * @param {Array<Object>} logs - rows for one phone number
 * @param {number} now - reference timestamp (ms)
 * @param {Object} cfg - engine config
 */
export const summarizeInteractions = (logs, now, cfg) => {
  let total = 0;
  let outgoing = 0;
  let incoming = 0;
  let missed = 0;
  let totalDurationSec = 0;
  let last = 0;
  let first = 0;
  let last30 = 0;
  let last90 = 0;
  let last365 = 0;

  const recentBoundary = now - cfg.recentWindowDays * DAY_MS;
  const midBoundary = now - cfg.midWindowDays * DAY_MS;
  const longBoundary = now - cfg.longWindowDays * DAY_MS;

  // Tracks number of interactions per 30-day bucket relative to `now` so we
  // can find the peak historical frequency without retaining every entry.
  const monthBuckets = new Map();

  // Sort newest-first so we can compute aggregate stats and the trailing
  // "unreturned" missed-call streak in a single pass.
  const sorted = (logs || [])
    .map((log) => ({ log, ts: getLogTs(log), type: getLogType(log) }))
    .filter((x) => x.ts)
    .sort((a, b) => b.ts - a.ts);

  // pendingMissed = consecutive missed calls at the most recent end of the
  // history, stopping the moment we hit an answered (incoming) or initiated
  // (outgoing) call. If the user has already talked since the last missed
  // call, this is 0 and the contact drops out of the "missed to return" lane.
  let pendingMissed = 0;
  let streakBroken = false;

  sorted.forEach(({ log, ts, type }) => {
    total += 1;
    totalDurationSec += getLogDuration(log);
    if (type === 'outgoing') outgoing += 1;
    else if (type === 'incoming') incoming += 1;
    else if (type === 'missed') missed += 1;
    if (ts > last) last = ts;
    if (!first || ts < first) first = ts;
    if (ts >= recentBoundary) last30 += 1;
    if (ts >= midBoundary) last90 += 1;
    if (ts >= longBoundary) last365 += 1;
    const bucket = Math.floor((now - ts) / (30 * DAY_MS));
    monthBuckets.set(bucket, (monthBuckets.get(bucket) || 0) + 1);

    if (!streakBroken) {
      if (type === 'missed') {
        pendingMissed += 1;
      } else {
        streakBroken = true;
      }
    }
  });

  let peakPerMonth = 0;
  monthBuckets.forEach((v) => {
    if (v > peakPerMonth) peakPerMonth = v;
  });

  const daysSinceLast = last ? Math.floor((now - last) / DAY_MS) : null;
  const spanDays = first && last ? Math.max(1, Math.floor((last - first) / DAY_MS)) : 0;

  // Slim, newest-first tail of individual calls so the UI can render a per
  // contact call history (date/time, type, duration). `sorted` is already
  // ordered newest-first, so we just project and cap it.
  const recentCalls = sorted
    .slice(0, RECENT_CALLS_CAP)
    .map(({ log, ts, type }) => ({
      ts,
      type,
      durationSec: getLogDuration(log),
    }));

  return {
    total,
    outgoing,
    incoming,
    missed,
    pendingMissed,
    totalDurationSec,
    last,
    first,
    last30,
    last90,
    last365,
    daysSinceLast,
    spanDays,
    peakPerMonth,
    recentCalls,
  };
};

/**
 * Whether a contact is eligible to appear in a reconnect recommendation.
 * Recommendations only nudge you about people you have either:
 *   - never called (no interactions at all), or
 *   - not called in at least `cfg.reconnectMinDays` (default 3 months).
 * Anyone you spoke to more recently than that is deliberately held back so the
 * suggestion lanes stay focused on relationships that have actually gone quiet.
 */
export const isReconnectEligible = (summary, cfg = DEFAULTS) => {
  if (!summary || summary.total === 0) return true;
  if (summary.daysSinceLast === null) return true;
  return summary.daysSinceLast >= cfg.reconnectMinDays;
};

/**
 * Derives semantic labels from an interaction summary. Each contact can carry
 * multiple labels (e.g. "strong" and "dormant" together = "lost connection").
 */
export const deriveStatus = (summary, cfg) => {
  const labels = [];
  const isStrongHistorical =
    summary.total >= cfg.strongTotalInteractions ||
    summary.peakPerMonth >= cfg.strongPeakPerMonth;
  const isDormant =
    summary.daysSinceLast === null || summary.daysSinceLast >= cfg.dormantAfterDays;
  const isActive =
    summary.daysSinceLast !== null && summary.daysSinceLast < cfg.recentWindowDays;

  if (summary.total === 0) {
    labels.push('never_connected');
  }
  if (isStrongHistorical) labels.push('strong_historical');
  if (isStrongHistorical && isDormant && summary.total > 0) {
    labels.push('lost_connection');
  }
  if (isActive && summary.last30 >= 3) labels.push('consistent');
  if (
    summary.last &&
    summary.daysSinceLast !== null &&
    summary.daysSinceLast <= cfg.recentReconnectWithinDays &&
    summary.spanDays >= cfg.recentReconnectPriorGapDays
  ) {
    // The contact's "active span" exceeded the gap threshold AND the very
    // last call happened in the recent reconnect window. We treat that as a
    // soft recently-reconnected hint; the storage-backed `reconnects` map
    // gives a sharper signal when the user explicitly acts.
    labels.push('recently_reconnected');
  }

  return labels;
};

/**
 * Reconnect priority — higher means "we should surface this contact sooner".
 * Weights are deliberately interpretable so we can tune them without ML.
 *
 *   priority =
 *       40 * isLostConnection                  (strong + dormant)
 *     + 15 * isStrongHistorical                (matters at all)
 *     + 0.4 * daysSinceLast (capped at 365)    (more dormant = more priority)
 *     + 0.8 * peakPerMonth (capped at 30)      (depth of past relationship)
 *     + 5 * missedCallsRecent                  (returning a missed call)
 *     - 20 * isActive                          (don't pester active contacts)
 *     - 30 * isRecentlyReconnected             (we just spoke; back off)
 *
 * Never connected contacts get a separate, lower-priority lane.
 */
export const computePriority = (summary, labels, recentlyReconnectedAt, cfg, now) => {
  if (labels.includes('never_connected')) return 0;
  const isStrong = labels.includes('strong_historical');
  const isLost = labels.includes('lost_connection');
  const isActive = labels.includes('consistent');
  const isRecent =
    labels.includes('recently_reconnected') ||
    (recentlyReconnectedAt &&
      now - recentlyReconnectedAt <= cfg.recentReconnectWithinDays * DAY_MS);

  const dormancy = Math.min(summary.daysSinceLast || 0, 365);
  const depth = Math.min(summary.peakPerMonth || 0, 30);

  let score = 0;
  if (isLost) score += 40;
  if (isStrong) score += 15;
  score += 0.4 * dormancy;
  score += 0.8 * depth;
  // Recent missed calls are a soft "return this" nudge.
  score += 5 * Math.min(summary.missed || 0, 3);
  if (isActive) score -= 20;
  if (isRecent) score -= 30;

  return Math.max(0, score);
};

/**
 * Produces a full per-contact profile that the UI can render directly.
 *
 * `remindersSuppressed` is the unified "do not surface this contact in any
 * reminder lane" flag. It fires when any of the three opt-outs apply:
 *   - the contact is in the user's don't-suggest list
 *   - any of the contact's groups is marked doNotRemind
 *   - any of the contact's groups is in the helpers category (helpers never
 *     belong in reach-out reminders by design)
 */
const buildProfile = ({
  contact,
  logs,
  now,
  cfg,
  reconnectedAtMap,
  groupsByPhone,
  dontSuggest,
}) => {
  const summary = summarizeInteractions(logs, now, cfg);
  const labels = deriveStatus(summary, cfg);
  const recentlyReconnectedAt = reconnectedAtMap[contact.normalized] || 0;
  const priority = computePriority(summary, labels, recentlyReconnectedAt, cfg, now);
  const groups = groupsByPhone[contact.normalized] || [];
  const remindersSuppressed =
    Boolean(dontSuggest[contact.normalized]) ||
    groups.some((g) => g?.doNotRemind || g?.categoryId === CATEGORY_ID.HELPERS);

  return {
    contact,
    summary,
    labels,
    priority,
    recentlyReconnectedAt,
    groups,
    remindersSuppressed,
  };
};

/**
 * Main entry point. Returns a structured dashboard payload ready for the
 * Connect home screen.
 *
 * @param {Object}   args
 * @param {Array}    args.contacts   - flattened phone-book contacts (with `normalized`)
 * @param {Array}    args.callLogs   - raw rows from react-native-call-log
 * @param {Object}   [args.reconnects]    - { [normalizedPhone]: timestampMs }
 * @param {Object}   [args.contactGroups] - { [normalizedPhone]: [groupId, ...] }
 * @param {Array}    [args.groups]        - [{id, name, color}]
 * @param {number}   [args.now]
 * @param {Object}   [args.config]
 */
export const analyzeRelationships = ({
  contacts,
  callLogs,
  reconnects = {},
  contactGroups = {},
  groups = [],
  dontSuggest = {},
  now = Date.now(),
  config = {},
}) => {
  const cfg = { ...DEFAULTS, ...config };
  const grouped = groupCallLogsByPhone(callLogs);

  // Resolve group objects keyed by phone for fast lookup.
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupsByPhone = {};
  Object.keys(contactGroups).forEach((phone) => {
    groupsByPhone[phone] = (contactGroups[phone] || [])
      .map((id) => groupById.get(id))
      .filter(Boolean);
  });

  const profiles = (contacts || []).map((c) =>
    buildProfile({
      contact: c,
      logs: grouped.get(c.normalized) || [],
      now,
      cfg,
      reconnectedAtMap: reconnects,
      groupsByPhone,
      dontSuggest,
    }),
  );

  // Single suppression gate for all reach-out reminder lanes. Covers:
  //   - the contact-level "don't suggest" tag
  //   - any group marked "do not remind"
  //   - the helpers category (driver, maid, vendor, …) — the user doesn't
  //     want a reminder to call their maid
  // History-style lanes (recentlyReconnected, consistent) deliberately ignore
  // this flag — they're informational, not nudges.
  const isSuppressed = (p) => Boolean(p?.remindersSuppressed);

  // Reconnect Today: top of the priority queue, excluding never-connected and
  // recently-reconnected/active. The `isReconnectEligible` gate enforces the
  // "only suggest people you last spoke to over 3 months ago" rule, so anyone
  // contacted more recently never lands here regardless of their score.
  const reconnectToday = profiles
    .filter(
      (p) =>
        p.summary.total > 0 &&
        isReconnectEligible(p.summary, cfg) &&
        !p.labels.includes('recently_reconnected') &&
        !p.labels.includes('consistent') &&
        p.priority > 0 &&
        !isSuppressed(p),
    )
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 25);

  const lostConnections = profiles
    .filter((p) => p.labels.includes('lost_connection') && !isSuppressed(p))
    .sort((a, b) => b.priority - a.priority);

  const neverConnected = profiles
    .filter((p) => p.labels.includes('never_connected') && !isSuppressed(p))
    .sort((a, b) => a.contact.name.localeCompare(b.contact.name));

  const recentlyReconnected = profiles
    .filter(
      (p) =>
        p.recentlyReconnectedAt &&
        now - p.recentlyReconnectedAt <= cfg.recentReconnectWithinDays * DAY_MS,
    )
    .sort((a, b) => b.recentlyReconnectedAt - a.recentlyReconnectedAt);

  const consistent = profiles
    .filter((p) => p.labels.includes('consistent'))
    .sort((a, b) => b.summary.last30 - a.summary.last30);

  const missedCallsToReturn = profiles
    .filter(
      (p) =>
        p.summary.pendingMissed > 0 &&
        p.summary.daysSinceLast !== null &&
        !isSuppressed(p),
    )
    .sort((a, b) => {
      // Most recent missed first.
      if ((b.summary.last || 0) !== (a.summary.last || 0)) {
        return (b.summary.last || 0) - (a.summary.last || 0);
      }
      return b.summary.pendingMissed - a.summary.pendingMissed;
    })
    .slice(0, 20);

  return {
    generatedAt: now,
    config: cfg,
    counts: {
      total: profiles.length,
      neverConnected: neverConnected.length,
      lostConnections: lostConnections.length,
      consistent: consistent.length,
      recentlyReconnected: recentlyReconnected.length,
    },
    reconnectToday,
    lostConnections,
    neverConnected,
    recentlyReconnected,
    consistent,
    missedCallsToReturn,
    profiles,
  };
};

/**
 * Looks up a single profile from a precomputed analysis by phone number.
 */
export const findProfile = (analysis, phone) => {
  if (!analysis || !phone) return null;
  const key = normalizeLast10(phone);
  return (analysis.profiles || []).find((p) => p.contact.normalized === key) || null;
};
