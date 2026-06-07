import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
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
const REEL_TICK_MS = 70; // how fast the cycling names flip
const ROW_SETTLE_BASE = 420; // when the first reel locks in
const ROW_SETTLE_STEP = 200; // each subsequent reel locks this much later
const SETTLE_TAIL = 240; // small pad after the last reel settles

const rowSettleAt = (i) => ROW_SETTLE_BASE + i * ROW_SETTLE_STEP;
const spinDuration = (n) => rowSettleAt(Math.max(0, n - 1)) + SETTLE_TAIL;

/**
 * A "slot machine" that sits above the home card carousel. It opens showing the
 * total contact count; pressing Spin rolls up to five people — one from each of
 * five randomly-chosen circles — with a brief reel animation. Re-spinning marks
 * the shown people as dismissed (so they sink in the pool), and calling someone
 * replaces just their slot with a fresh face from a different circle.
 */
const SlotMachine = ({ profiles, totalContacts = 0, onCall, onOpenContact }) => {
  const [phase, setPhase] = useState('idle'); // 'idle' | 'spinning' | 'result'
  const [picks, setPicks] = useState([]);
  const [tick, setTick] = useState(0);
  const startRef = useRef(0);
  const intervalRef = useRef(null);
  const timeoutRef = useRef(null);

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
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => stopTimers, [stopTimers]);

  const startSpin = useCallback(
    (nextPicks) => {
      stopTimers();
      setPicks(nextPicks);
      if (!nextPicks.length) {
        setPhase('result'); // nothing eligible — show the empty message
        return;
      }
      setPhase('spinning');
      setTick(0);
      startRef.current = Date.now();
      intervalRef.current = setInterval(
        () => setTick((t) => t + 1),
        REEL_TICK_MS,
      );
      timeoutRef.current = setTimeout(() => {
        stopTimers();
        setPhase('result');
      }, spinDuration(nextPicks.length));
    },
    [stopTimers],
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
    },
    [picks, profiles, onCall],
  );

  // ---------- Render ----------

  if (phase === 'idle') {
    return (
      <View style={styles.wrap}>
        <View style={styles.headerRow}>
          <Icon name="slot-machine" size={16} color={theme.colors.accent} />
          <Text style={styles.kicker}>WHO TO CALL</Text>
        </View>
        <Text style={styles.bigNumber}>{totalContacts}</Text>
        <Text style={styles.bigCaption}>people in your circles</Text>
        <TouchableOpacity
          style={styles.spinBtn}
          activeOpacity={0.85}
          onPress={handleSpin}
        >
          <Icon name="dice-multiple" size={20} color={theme.colors.surface} />
          <Text style={styles.spinBtnText}>Spin</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const spinning = phase === 'spinning';
  const elapsed = Date.now() - startRef.current;

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Icon name="slot-machine" size={16} color={theme.colors.accent} />
        <Text style={styles.kicker}>WHO TO CALL</Text>
      </View>

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
            const settled = !spinning || elapsed >= rowSettleAt(i);
            const name = settled
              ? pk.profile.contact?.name || firstNameOf()
              : namePool[(tick + i * 2) % namePool.length];
            return (
              <View
                key={`${i}-${pk.profile.contact?.normalized}`}
                style={styles.row}
              >
                <View
                  style={[
                    styles.avatar,
                    settled && {
                      backgroundColor: pk.group?.color || theme.colors.primary,
                    },
                  ]}
                >
                  <Text style={styles.avatarText}>
                    {settled ? initialsFor(pk.profile.contact?.name) : '?'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.rowBody}
                  activeOpacity={settled ? 0.6 : 1}
                  disabled={!settled}
                  onPress={() => onOpenContact?.(pk.profile)}
                >
                  <Text
                    style={[styles.rowName, !settled && styles.rowNameSpin]}
                    numberOfLines={1}
                  >
                    {name}
                  </Text>
                  <Text style={styles.rowGroup} numberOfLines={1}>
                    {settled ? pk.group?.name || ' ' : ' '}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.callBtn, !settled && styles.callBtnIdle]}
                  activeOpacity={0.85}
                  disabled={!settled}
                  onPress={() => handleCall(i)}
                >
                  <Icon name="phone" size={18} color={theme.colors.surface} />
                </TouchableOpacity>
              </View>
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
        <Icon name="dice-multiple" size={18} color={theme.colors.primary} />
        <Text style={styles.rerollBtnText}>
          {picks.length ? 'Spin again' : 'Spin'}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.md,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    shadowColor: theme.colors.cardShadow,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  kicker: {
    color: theme.colors.textSubtle,
    fontSize: theme.font.tiny,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginLeft: 6,
  },
  bigNumber: {
    fontSize: 56,
    fontWeight: '800',
    color: theme.colors.primary,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
  },
  bigCaption: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
  },
  spinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.pill,
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.xs,
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
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.chipBg,
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
    fontWeight: '700',
    color: theme.colors.text,
  },
  rowNameSpin: {
    color: theme.colors.textSubtle,
    fontStyle: 'italic',
  },
  rowGroup: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    marginTop: 1,
  },
  callBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.success,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: theme.spacing.sm,
  },
  callBtnIdle: {
    backgroundColor: theme.colors.chipBg,
  },
  rerollBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.md,
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
  },
  rerollBtnDisabled: {
    opacity: 0.5,
  },
  rerollBtnText: {
    color: theme.colors.primary,
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
    color: theme.colors.text,
  },
  emptyBody: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginTop: 4,
  },
});

export default SlotMachine;
