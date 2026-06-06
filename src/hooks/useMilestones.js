import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getReconnects,
  getMilestoneDefinitions,
  getMilestonesState,
  markMilestoneAchieved,
} from '../storage';
import {
  computeReconnectStats,
  evaluateMilestones,
  newlyAchievedIds,
} from '../engine/milestonesEngine';

/**
 * Computes milestone progress from the user's reconnect history and persists
 * any newly-earned milestone so its earn date survives a streak later lapsing.
 *
 * Pass a changing `dep` (e.g. the analysis generatedAt) to recompute after a
 * refresh, since reconnects are recorded as a side effect of analysis.
 *
 * @returns {{ milestones: Array, stats: Object, refresh: Function }}
 */
export const useMilestones = (dep) => {
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const { milestones, stats } = useMemo(() => {
    const s = computeReconnectStats(getReconnects());
    const evaluated = evaluateMilestones(
      getMilestoneDefinitions(),
      s,
      getMilestonesState(),
    );
    return { milestones: evaluated, stats: s };
    // `dep` and `tick` are intentional recompute triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep, tick]);

  // Stamp freshly-earned milestones. Runs after render so we never write during
  // the memo; re-reads happen via the next dep/tick change.
  useEffect(() => {
    const fresh = newlyAchievedIds(milestones);
    fresh.forEach((id) => markMilestoneAchieved(id));
  }, [milestones]);

  return { milestones, stats, refresh };
};
