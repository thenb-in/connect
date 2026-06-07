import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import { initialsFor } from './ReconnectCard';
import {
  UNKNOWN_GROUP_ID,
  getCardDismissalMap,
  incrementCardDismissal,
  CARD_DISMISS_LIMIT,
} from '../storage';

// ---------- Selection ----------
// The slot machine is a different surface from the lanes, but it shares the
// same "one fresh person per circle" spirit as the home carousel — and the same
// per-person dismissal counter (storage.js CARD_DISMISSALS): re-spinning nudges
// the shown people down so they don't keep reappearing, and anyone past the
// dismiss limit drops out entirely.

const MAX_SLOTS = 5;

const firstNameOf = (name) => (name || '').trim().split(/\s+/)[0] || 'Someone';

// Fisher-Yates (new array; never mutates input).
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Group eligible profiles by group, mirroring the home "Say hi" suppression
// rules: skip reminder-suppressed people, helper/do-not-remind groups, and the
// synthetic Unknown catch-all. Also drop anyone dismissed past the limit.
const buildEligibleByGroup = (profiles, dismissals) => {
  const byGroup = new Map();
  (profiles || []).forEach((p) => {
    if (p.remindersSuppressed) return;
    const norm = p.contact?.normalized;
    if (!norm) return;
    if ((dismissals[norm] || 0) > CARD_DISMISS_LIMIT) return;
    (p.groups || []).forEach((g) => {
      if (
        !g ||
        g.doNotRemind ||
        g.categoryId === 'helpers' ||
        g.id === UNKNOWN_GROUP_ID
      ) {
        return;
      }
      const entry = byGroup.get(g.id) || { group: g, members: [] };
      entry.members.push(p);
      byGroup.set(g.id, entry);
    });
  });
  return byGroup;
};

// Pick a member from a group, preferring un-dismissed people and skipping any
// contact already chosen this roll.
const pickMember = (members, dismissals, exclude) => {
  const avail = members.filter((m) => !exclude.has(m.contact?.normalized));
  if (!avail.length) return null;
  const fresh = avail.filter((m) => (dismissals[m.contact?.normalized] || 0) === 0);
  const tier = fresh.length ? fresh : avail;
  return tier[Math.floor(Math.random() * tier.length)];
};

// Roll up to `max` picks, each from a DISTINCT random group, excluding the
// given contacts and groups. Returns `[{ profile, group }]`.
const rollPicks = (
  profiles,
  { max = MAX_SLOTS, excludeContacts = [], excludeGroups = [] } = {},
) => {
  const dismissals = getCardDismissalMap();
  const byGroup = buildEligibleByGroup(profiles, dismissals);
  const excludeC = new Set(excludeContacts);
  const excludeG = new Set(excludeGroups);
  const picks = [];
  for (const gid of shuffle([...byGroup.keys()])) {
    if (picks.length >= max) break;
    if (excludeG.has(gid)) continue;
    const { group, members } = byGroup.get(gid);
    const pick = pickMember(members, dismissals, excludeC);
    if (!pick) continue;
    excludeC.add(pick.contact?.normalized);
    picks.push({ profile: pick, group });
  }
  return picks;
};

// ---------- Reel animation timing ----------
// The whole roll lasts ~2.4s: reels cycle names fast, then lock in one by one,
// the last landing ~2.2s in for a satisfying "settling" payoff.
const REEL_TICK_MS = 60; // how fast the cycling names flip
const SPIN_MS = 2200; // when the LAST reel locks in
const ROW_SETTLE_STEP = 260; // each earlier reel locks this much sooner
const SETTLE_TAIL = 220; // small pad after the last reel settles

// Row i (of n) locks at this elapsed time; the last row lands at SPIN_MS and
// earlier rows stagger before it.
const rowSettleAt = (i, n) => Math.max(360, SPIN_MS - (n - 1 - i) * ROW_SETTLE_STEP);

/**
 * A "slot machine" that sits above the home card carousel. It opens showing the
 * total contact count; pressing Spin rolls up to five people — one from each of
 * five randomly-chosen circles — with a ~2.4s reel animation. Re-spinning marks
 * the shown people as dismissed (so they sink in the pool), and calling someone
 * replaces just their slot with a fresh face from a different circle.
 */
const SlotMachine = ({ profiles, totalContacts = 0, onCall, onOpenContact }) => {
  const [phase, setPhase] = useState('idle'); // 'idle' | 'spinning' | 'result'
  const [picks, setPicks] = useState([]);
  const [settled, setSettled] = useState([]); // per-row "locked in" flags
  const [tick, setTick] = useState(0);
  const intervalRef = useRef(null);
  const timeoutsRef = useRef([]);
  // One pop scale per slot, fired when that reel locks in; a pulse for the idle
  // Spin button so it quietly invites a tap.
  const scales = useRef(
    Array.from({ length: MAX_SLOTS }, () => new Animated.Value(1)),
  ).current;
  const pulse = useRef(new Animated.Value(0)).current;

  // First-name pool that the reels cycle through while spinning.
  const namePool = useMemo(() => {
    const names = (profiles || [])
      .map((p) => firstNameOf(p.contact?.name))
      .filter(Boolean);
    return names.length ? names : ['Priya', 'Amit', 'Ravi', 'Neha', 'Sam'];
  }, [profiles]);

  const stopTimers = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  useEffect(() => stopTimers, [stopTimers]);

  // Idle button pulse — runs only while the big-number landing is showing.
  useEffect(() => {
    if (phase !== 'idle') return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 750, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, pulse]);

  const popRow = useCallback(
    (i) => {
      const s = scales[i];
      if (!s) return;
      s.setValue(0.82);
      Animated.spring(s, {
        toValue: 1,
        useNativeDriver: true,
        friction: 5,
        tension: 160,
      }).start();
    },
    [scales],
  );

  const startSpin = useCallback(
    (nextPicks) => {
      stopTimers();
      setPicks(nextPicks);
      if (!nextPicks.length) {
        setSettled([]);
        setPhase('result'); // nothing eligible — show the empty message
        return;
      }
      setSettled(nextPicks.map(() => false));
      setPhase('spinning');
      setTick(0);
      intervalRef.current = setInterval(
        () => setTick((t) => t + 1),
        REEL_TICK_MS,
      );
      // Lock each reel in turn, popping it as it lands.
      nextPicks.forEach((_, i) => {
        timeoutsRef.current.push(
          setTimeout(() => {
            setSettled((prev) => {
              const copy = [...prev];
              copy[i] = true;
              return copy;
            });
            popRow(i);
          }, rowSettleAt(i, nextPicks.length)),
        );
      });
      timeoutsRef.current.push(
        setTimeout(() => {
          stopTimers();
          setPhase('result');
        }, SPIN_MS + SETTLE_TAIL),
      );
    },
    [stopTimers, popRow],
  );

  const handleSpin = useCallback(() => {
    startSpin(rollPicks(profiles, { max: MAX_SLOTS }));
  }, [profiles, startSpin]);

  const handleReroll = useCallback(() => {
    // Re-spinning is a soft "not these" — bump each shown person's dismissal
    // count so the pool floats them down (and eventually out).
    picks.forEach((pk) => incrementCardDismissal(pk.profile.contact?.normalized));
    startSpin(
      rollPicks(profiles, {
        max: MAX_SLOTS,
        excludeContacts: picks.map((pk) => pk.profile.contact?.normalized),
      }),
    );
  }, [picks, profiles, startSpin]);

  const handleCall = useCallback(
    (index) => {
      const pk = picks[index];
      if (!pk) return;
      onCall?.(pk.profile);
      // Swap just this slot for someone from a circle not currently on screen.
      const [replacement] = rollPicks(profiles, {
        max: 1,
        excludeContacts: picks.map((p) => p.profile.contact?.normalized),
        excludeGroups: picks.map((p) => p.group?.id),
      });
      setPicks((cur) => {
        const copy = [...cur];
        if (replacement) copy[index] = replacement;
        else copy.splice(index, 1); // pool exhausted — just drop the slot
        return copy;
      });
      if (replacement) popRow(index);
    },
    [picks, profiles, onCall, popRow],
  );

  // ---------- Render ----------

  const Blobs = (
    <>
      <View style={styles.blobOne} pointerEvents="none" />
      <View style={styles.blobTwo} pointerEvents="none" />
    </>
  );

  const Header = (
    <View style={styles.headerRow}>
      <Icon name="slot-machine" size={16} color={theme.colors.surface} />
      <Text style={styles.kicker}>WHO TO CALL</Text>
    </View>
  );

  if (phase === 'idle') {
    const pulseScale = pulse.interpolate({
      inputRange: [0, 1],
      outputRange: [1, 1.05],
    });
    return (
      <View style={styles.wrap}>
        {Blobs}
        {Header}
        <Text style={styles.bigNumber}>{totalContacts}</Text>
        <Text style={styles.bigCaption}>people in your circles</Text>
        <Animated.View style={{ transform: [{ scale: pulseScale }] }}>
          <TouchableOpacity
            style={styles.spinBtn}
            activeOpacity={0.85}
            onPress={handleSpin}
          >
            <Icon name="dice-multiple" size={22} color={theme.colors.surface} />
            <Text style={styles.spinBtnText}>Spin to connect</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    );
  }

  const spinning = phase === 'spinning';

  return (
    <View style={styles.wrap}>
      {Blobs}
      {Header}

      {picks.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>No one to spin yet</Text>
          <Text style={styles.emptyBody}>
            Sort some contacts into groups and they’ll show up here.
          </Text>
        </View>
      ) : (
        <View style={styles.reels}>
          {picks.map((pk, i) => {
            const isSettled = phase === 'result' || settled[i];
            const name = isSettled
              ? pk.profile.contact?.name || firstNameOf()
              : namePool[(tick + i * 2) % namePool.length];
            return (
              <Animated.View
                key={`${i}-${pk.profile.contact?.normalized}`}
                style={[
                  styles.row,
                  isSettled && styles.rowSettled,
                  { transform: [{ scale: scales[i] || 1 }] },
                ]}
              >
                <View
                  style={[
                    styles.avatar,
                    isSettled && {
                      backgroundColor: pk.group?.color || theme.colors.accent,
                    },
                  ]}
                >
                  <Text style={styles.avatarText}>
                    {isSettled ? initialsFor(pk.profile.contact?.name) : '?'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.rowBody}
                  activeOpacity={isSettled ? 0.6 : 1}
                  disabled={!isSettled}
                  onPress={() => onOpenContact?.(pk.profile)}
                >
                  <Text
                    style={[styles.rowName, !isSettled && styles.rowNameSpin]}
                    numberOfLines={1}
                  >
                    {name}
                  </Text>
                  {isSettled && pk.group?.name ? (
                    <View style={styles.groupPill}>
                      <Text style={styles.groupPillText} numberOfLines={1}>
                        {pk.group.name}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.rowSpinHint}>spinning…</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.callBtn, !isSettled && styles.callBtnIdle]}
                  activeOpacity={0.85}
                  disabled={!isSettled}
                  onPress={() => handleCall(i)}
                >
                  <Icon name="phone" size={18} color={theme.colors.surface} />
                </TouchableOpacity>
              </Animated.View>
            );
          })}
        </View>
      )}

      <TouchableOpacity
        style={[styles.rerollBtn, spinning && styles.rerollBtnDisabled]}
        activeOpacity={0.85}
        disabled={spinning}
        onPress={handleReroll}
      >
        <Icon name="dice-multiple" size={18} color={theme.colors.surface} />
        <Text style={styles.rerollBtnText}>
          {spinning ? 'Spinning…' : picks.length ? 'Spin again' : 'Spin'}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.lg,
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.md,
    padding: theme.spacing.lg,
    overflow: 'hidden',
    shadowColor: theme.colors.primaryDark,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 16,
    elevation: 6,
  },
  blobOne: {
    position: 'absolute',
    top: -56,
    right: -44,
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  blobTwo: {
    position: 'absolute',
    bottom: -64,
    left: -34,
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  kicker: {
    color: theme.colors.surface,
    fontSize: theme.font.tiny,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginLeft: 6,
    opacity: 0.92,
  },
  bigNumber: {
    fontSize: 64,
    fontWeight: '900',
    color: theme.colors.surface,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
  },
  bigCaption: {
    fontSize: theme.font.small,
    color: 'rgba(255,255,255,0.82)',
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  },
  spinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.pill,
    paddingVertical: theme.spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  spinBtnText: {
    color: theme.colors.surface,
    fontSize: theme.font.h3,
    fontWeight: '800',
    marginLeft: theme.spacing.sm,
  },
  reels: {
    marginTop: theme.spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  rowSettled: {
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.22)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.md,
  },
  avatarText: {
    color: theme.colors.surface,
    fontWeight: '800',
    fontSize: theme.font.body,
  },
  rowBody: {
    flex: 1,
  },
  rowName: {
    fontSize: theme.font.h3,
    fontWeight: '800',
    color: theme.colors.surface,
  },
  rowNameSpin: {
    color: 'rgba(255,255,255,0.7)',
    fontStyle: 'italic',
    fontWeight: '600',
  },
  groupPill: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    marginTop: 3,
    maxWidth: '100%',
  },
  groupPillText: {
    color: theme.colors.surface,
    fontSize: theme.font.tiny,
    fontWeight: '700',
  },
  rowSpinHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: theme.font.tiny,
    marginTop: 4,
  },
  callBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: theme.colors.success,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: theme.spacing.sm,
  },
  callBtnIdle: {
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  rerollBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.sm,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.55)',
  },
  rerollBtnDisabled: {
    opacity: 0.6,
  },
  rerollBtnText: {
    color: theme.colors.surface,
    fontSize: theme.font.body,
    fontWeight: '800',
    marginLeft: theme.spacing.sm,
  },
  emptyWrap: {
    paddingVertical: theme.spacing.lg,
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: theme.font.h3,
    fontWeight: '800',
    color: theme.colors.surface,
  },
  emptyBody: {
    fontSize: theme.font.small,
    color: 'rgba(255,255,255,0.82)',
    textAlign: 'center',
    marginTop: 4,
  },
});

export default SlotMachine;
