// ---------------------------------------------------------------------------
// Milestones Engine
// ---------------------------------------------------------------------------
// Pure functions that turn the user's reconnect history into milestone
// progress. Milestone *definitions* are data (see src/data/milestones.json,
// and later a webserver payload); this engine only knows how to measure
// progress against them. Two milestone types are supported today:
//
//   - "people": connect with X distinct people (lifetime count)
//   - "streak": reach out on Y consecutive days
//   - "weekly": reconnect with Z distinct people within a rolling 7-day window
//     (a momentum burst — earned once and kept, even after the week passes)
//
// The engine never reads from storage; callers pass the reconnect map in. That
// keeps it trivial to unit test and lets the UI choose the data window.

const DAY_MS = 24 * 60 * 60 * 1000;

// Local-day index (days since epoch in the device's timezone) for a timestamp.
// Using local midnight means a streak is "calendar days the user reached out",
// matching how a person intuitively counts a streak.
const localDayIndex = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / DAY_MS);
};

/**
 * Derives headline reconnect stats from the reconnects map.
 *
 * @param {Object} reconnects - { [normalizedPhone]: timestampMs }
 * @param {number} [now]
 * @returns {{ totalPeople:number, currentStreakDays:number,
 *            longestStreakDays:number, lastReconnectAt:number,
 *            reconnectsThisWeek:number }}
 */
export const computeReconnectStats = (reconnects = {}, now = Date.now()) => {
  const timestamps = Object.values(reconnects || {})
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0);

  const totalPeople = timestamps.length;
  if (totalPeople === 0) {
    return {
      totalPeople: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      lastReconnectAt: 0,
      reconnectsThisWeek: 0,
    };
  }

  const lastReconnectAt = Math.max(...timestamps);

  // Distinct people whose most recent reconnect falls in the last 7 days — the
  // "this week" momentum signal that the home scoreboard used to show.
  const weekAgo = now - 7 * DAY_MS;
  const reconnectsThisWeek = timestamps.filter((t) => t >= weekAgo).length;

  // Unique calendar days that had at least one reconnect, ascending.
  const days = [...new Set(timestamps.map(localDayIndex))].sort((a, b) => a - b);

  // Longest run of consecutive days anywhere in the history.
  let longestStreakDays = 1;
  let run = 1;
  for (let i = 1; i < days.length; i += 1) {
    if (days[i] === days[i - 1] + 1) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longestStreakDays) longestStreakDays = run;
  }

  // Current streak: the consecutive run ending on the most recent active day,
  // but only "alive" if that day is today or yesterday. A gap of two or more
  // days breaks the streak.
  const today = localDayIndex(now);
  const lastDay = days[days.length - 1];
  let currentStreakDays = 0;
  if (today - lastDay <= 1) {
    currentStreakDays = 1;
    for (let i = days.length - 1; i > 0; i -= 1) {
      if (days[i] === days[i - 1] + 1) currentStreakDays += 1;
      else break;
    }
  }

  return {
    totalPeople,
    currentStreakDays,
    longestStreakDays,
    lastReconnectAt,
    reconnectsThisWeek,
  };
};

/**
 * The measured value for a milestone type given the computed stats. Unknown
 * types measure as 0 so a future server-defined type degrades gracefully
 * instead of crashing the screen.
 */
export const valueForMilestone = (type, stats) => {
  switch (type) {
    case 'people':
      return stats.totalPeople || 0;
    case 'streak':
      // Reward the best streak the user has ever achieved so a milestone that
      // was earned doesn't "un-earn" itself once the current streak lapses.
      return Math.max(stats.currentStreakDays || 0, stats.longestStreakDays || 0);
    case 'weekly':
      // Momentum within the trailing 7 days. Earned milestones persist via
      // achievedAt, so a quiet week never strips a badge already won.
      return stats.reconnectsThisWeek || 0;
    default:
      return 0;
  }
};

/**
 * Normalises whatever shape `getMilestoneDefinitions` hands us (a bare array,
 * or a `{ milestones: [...] }` payload from the server) into a clean array of
 * valid definitions.
 */
export const normaliseDefinitions = (defs) => {
  const list = Array.isArray(defs) ? defs : defs?.milestones;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && m.id && m.type && Number(m.target) > 0)
    .map((m) => ({
      id: String(m.id),
      type: String(m.type),
      title: m.title || '',
      description: m.description || '',
      target: Number(m.target),
      icon: m.icon || 'star-outline',
    }));
};

/**
 * Evaluates every milestone definition against the stats, attaching progress,
 * achieved state, and (when known) the achievedAt timestamp.
 *
 * @param {Array|Object} definitions - milestone defs (array or { milestones })
 * @param {Object} stats - output of computeReconnectStats
 * @param {Object} [achievedState] - { [milestoneId]: achievedAtMs }
 */
export const evaluateMilestones = (definitions, stats, achievedState = {}) => {
  return normaliseDefinitions(definitions).map((def) => {
    const value = valueForMilestone(def.type, stats);
    const achievedAt = achievedState[def.id] || 0;
    const achieved = value >= def.target || Boolean(achievedAt);
    const progress = def.target > 0 ? Math.min(1, value / def.target) : 0;
    return { ...def, value, achieved, achievedAt, progress };
  });
};

/**
 * Returns the ids of milestones that are now achieved but have no recorded
 * achievedAt yet — the caller persists these so "newly earned" can be detected
 * and the timestamp survives the streak later lapsing.
 */
export const newlyAchievedIds = (evaluated) =>
  (evaluated || [])
    .filter((m) => m.value >= m.target && !m.achievedAt)
    .map((m) => m.id);
