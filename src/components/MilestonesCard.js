import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import { shareMilestone } from '../utils/appShare';

/**
 * Picks the single milestone to celebrate in the hero badge:
 *   1. The most recently *earned* milestone (your latest win to brag about), or
 *   2. if nothing is earned yet, the open milestone closest to completion (the
 *      one to chase) so there's always a hit of momentum on screen.
 */
const pickHeadline = (milestones) => {
  const list = milestones || [];
  if (!list.length) return null;
  const earned = list.filter((m) => m.achieved);
  if (earned.length) {
    return [...earned].sort(
      (a, b) => (b.achievedAt || 0) - (a.achievedAt || 0) || b.target - a.target,
    )[0];
  }
  return [...list].sort(
    (a, b) => b.progress - a.progress || a.target - b.target,
  )[0];
};

/**
 * The next not-yet-earned milestone of each type (closest to completion),
 * excluding whatever is already shown in the hero, so the secondary rows always
 * point at fresh goals.
 */
const pickSecondary = (milestones, headlineId) => {
  const byType = new Map();
  (milestones || []).forEach((m) => {
    if (m.id === headlineId) return;
    const arr = byType.get(m.type) || [];
    arr.push(m);
    byType.set(m.type, arr);
  });
  const rows = [];
  byType.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.target - b.target);
    const nextOpen = sorted.find((m) => !m.achieved);
    rows.push(nextOpen || sorted[sorted.length - 1]);
  });
  return rows.filter(Boolean).slice(0, 2);
};

const HeroBadge = ({ milestone }) => {
  const { title, description, icon, value, target, achieved, progress } = milestone;
  const pct = Math.round((progress || 0) * 100);
  return (
    <View style={[styles.hero, achieved ? styles.heroEarned : styles.heroChasing]}>
      <View style={styles.heroGlow} pointerEvents="none" />
      <View style={styles.badge}>
        <Icon
          name={achieved ? 'trophy' : icon}
          size={30}
          color={theme.colors.surface}
        />
      </View>
      <Text style={styles.heroKicker}>
        {achieved ? '🎉 MILESTONE UNLOCKED' : `🔥 ${pct}% THERE — KEEP GOING`}
      </Text>
      <Text style={styles.heroTitle} numberOfLines={2}>
        {title}
      </Text>
      <Text style={styles.heroDesc} numberOfLines={2}>
        {description}
      </Text>

      <View style={styles.heroTrack}>
        <View style={[styles.heroFill, { width: `${Math.max(pct, 6)}%` }]} />
      </View>
      <Text style={styles.heroCount}>
        {achieved ? 'Earned' : `${Math.min(value, target)} / ${target}`}
      </Text>

      <TouchableOpacity
        style={styles.shareBtn}
        activeOpacity={0.85}
        onPress={() => shareMilestone(milestone)}
      >
        <Icon name="share-variant" size={16} color={theme.colors.surface} />
        <Text style={styles.shareBtnText}>
          {achieved ? 'Share achievement' : 'Share progress'}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const SecondaryRow = ({ milestone }) => {
  const { title, description, icon, value, target, achieved, progress } = milestone;
  return (
    <View style={styles.row}>
      <View style={[styles.iconWrap, achieved && styles.iconWrapAchieved]}>
        <Icon
          name={achieved ? 'check' : icon}
          size={18}
          color={achieved ? theme.colors.surface : theme.colors.primary}
        />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={[styles.rowCount, achieved && styles.rowCountAchieved]}>
            {achieved ? 'Earned' : `${Math.min(value, target)} / ${target}`}
          </Text>
        </View>
        {description ? (
          <Text style={styles.rowDesc} numberOfLines={1}>
            {description}
          </Text>
        ) : null}
        <View style={styles.track}>
          <View
            style={[
              styles.fill,
              { width: `${Math.round((progress || 0) * 100)}%` },
              achieved && styles.fillAchieved,
            ]}
          />
        </View>
      </View>
    </View>
  );
};

const MilestonesCard = ({ milestones }) => {
  const headline = useMemo(() => pickHeadline(milestones), [milestones]);
  const secondary = useMemo(
    () => pickSecondary(milestones, headline?.id),
    [milestones, headline],
  );
  const earnedCount = useMemo(
    () => (milestones || []).filter((m) => m.achieved).length,
    [milestones],
  );
  if (!headline) return null;

  return (
    <View style={styles.card}>
      <HeroBadge milestone={headline} />
      {earnedCount > 0 ? (
        <Text style={styles.earned}>
          {earnedCount} milestone{earnedCount === 1 ? '' : 's'} earned so far 🏅
        </Text>
      ) : null}
      {secondary.map((m) => (
        <SecondaryRow key={m.id} milestone={m} />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
  },
  hero: {
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    alignItems: 'center',
    overflow: 'hidden',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 6,
  },
  heroEarned: {
    backgroundColor: theme.colors.success,
    shadowColor: theme.colors.success,
  },
  heroChasing: {
    backgroundColor: theme.colors.accent,
    shadowColor: theme.colors.accent,
  },
  heroGlow: {
    position: 'absolute',
    top: -70,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  heroKicker: {
    color: theme.colors.surface,
    fontSize: theme.font.tiny,
    fontWeight: '800',
    letterSpacing: 1,
    opacity: 0.95,
  },
  heroTitle: {
    color: theme.colors.surface,
    fontSize: theme.font.h2,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 4,
  },
  heroDesc: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: theme.font.small,
    textAlign: 'center',
    marginTop: 2,
  },
  heroTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
    alignSelf: 'stretch',
    marginTop: theme.spacing.md,
  },
  heroFill: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.surface,
  },
  heroCount: {
    color: theme.colors.surface,
    fontSize: theme.font.tiny,
    fontWeight: '700',
    marginTop: 6,
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderRadius: theme.radius.pill,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  shareBtnText: {
    color: theme.colors.surface,
    fontSize: theme.font.small,
    fontWeight: '700',
    marginLeft: 6,
  },
  earned: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    fontWeight: '700',
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: theme.spacing.md,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.chipBg,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.md,
  },
  iconWrapAchieved: {
    backgroundColor: theme.colors.success,
  },
  rowBody: { flex: 1 },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowTitle: {
    fontSize: theme.font.small,
    fontWeight: '700',
    color: theme.colors.text,
    flex: 1,
    paddingRight: theme.spacing.sm,
  },
  rowCount: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
    fontWeight: '700',
  },
  rowCountAchieved: {
    color: theme.colors.success,
  },
  rowDesc: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    marginTop: 1,
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.chipBg,
    marginTop: theme.spacing.xs,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.accent,
  },
  fillAchieved: {
    backgroundColor: theme.colors.success,
  },
});

export default MilestonesCard;
