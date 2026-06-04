import { useCallback, useEffect, useState } from 'react';
import {
  analyzeFromCache,
  refreshAnalysis,
  refreshAnalysisOnFocus,
} from '../engine/analysisService';

/**
 * Hook that exposes the latest Connect Mode analysis plus a refresh function.
 * Initial render is served from cache (no IO) so screens are instantly
 * responsive; an optional pull-to-refresh re-imports from the device.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.refreshOnMount=false] - if true, re-import on mount.
 */
export const useConnectAnalysis = (opts = {}) => {
  const { refreshOnMount = false } = opts;
  const [analysis, setAnalysis] = useState(() => analyzeFromCache());
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async (refreshOpts) => {
    setRefreshing(true);
    setError(null);
    try {
      const next = await refreshAnalysis(refreshOpts);
      setAnalysis(next);
      return next;
    } catch (err) {
      console.warn('[useConnectAnalysis] refresh failed:', err?.message || err);
      setError(err?.message || 'Refresh failed');
      return null;
    } finally {
      setRefreshing(false);
    }
  }, []);

  const reanalyzeFromCache = useCallback(() => {
    setAnalysis(analyzeFromCache());
  }, []);

  // Silent variant for screen-focus events: pulls the call-log delta since
  // lastAnalyzedAt and re-analyzes, without flipping the `refreshing` flag
  // (so no pull-to-refresh spinner) and without spamming errors to state.
  const syncOnFocus = useCallback(async () => {
    try {
      const next = await refreshAnalysisOnFocus();
      if (next) { setAnalysis(next); }
      return next;
    } catch (err) {
      console.warn('[useConnectAnalysis] focus sync failed:', err?.message || err);
      return null;
    }
  }, []);

  useEffect(() => {
    if (refreshOnMount) refresh();
  }, [refreshOnMount, refresh]);

  return {
    analysis,
    refreshing,
    error,
    refresh,
    reanalyzeFromCache,
    syncOnFocus,
  };
};
