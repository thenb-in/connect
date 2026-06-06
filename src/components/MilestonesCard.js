import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';

/**
 * Renders milestone progress as a small set of gentle progress rows. To keep
 * the home screen calm we show the most recently earned milestone plus the
 * next in-progress milestone of each type, rather than the whole ladder.
 */
const MilestoneRow = ({ milestone }) => {
  const { title, description, icon, value, target, achieved, progress } = milestone;
  return (
    <View style={styles.row}>
      <View
        style={[
          styles.iconWrap,
          achieved && styles.iconWrapAchieved,
        ]}
      >
        <Icon
          name={achieved ? 'check' : icon}
          size={18}
          color={achieved ? theme.colors.surface : theme.colors.primary}
        />
      </View>
      <View style={styles.body}>
        <View style={styles.topRow}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={[styles.count, achieved && styles.countAchieved]}>
            {achieved ? 'Earned' : `${Math.min(value, target)} / ${target}`}
          </Text>
        </View>
        <Text style={styles.description} numberOfLines={1}>
          {description}
        </Text>
        <View style={styles.track}>
          <View
            style={[
              styles.fill,
              { width: `${Math.round(progress * 100)}%` },
              achieved && styles.fillAchieved,
            ]}
          />
        </View>
      </View>
    </View>
  );
};

/**
 * Picks the rows worth showing: the next not-yet-earned milestone of each type
 * (closest to completion), and if everything in a type is earned, the highest
 * earned one so the user still sees their achievement.
 */
const pickRows = (milestones) => {
  const byType = new Map();
  (milestones || []).forEach((m) => {
    const arr = byType.get(m.type) || [];
    arr.push(m);
    byType.set(m.type, arr);
  });
  const rows = [];
  byType.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.target - b.target);
    const nextOpen = sorted.find((m) => !m.achieved);
    if (nextOpen) {
      rows.push(nextOpen);
    } else if (sorted.length) {
      rows.push(sorted[sorted.length - 1]);
    }
  });
  return rows;
};

const MilestonesCard = ({ milestones }) => {
  const rows = useMemo(() => pickRows(milestones), [milestones]);
  const earnedCount = useMemo(
    () => (milestones || []).filter((m) => m.achieved).length,
    [milestones],
  );
  if (!rows.length) return null;

  return (
    <View style={styles.card}>
      {earnedCount > 0 ? (
        <Text style={styles.earned}>
          {earnedCount} milestone{earnedCount === 1 ? '' : 's'} earned so far
        </Text>
      ) : (
        <Text style={styles.earned}>Your first milestones are within reach</Text>
      )}
      {rows.map((m) => (
        <MilestoneRow key={m.id} milestone={m} />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  earned: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    fontWeight: '600',
    marginBottom: theme.spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: theme.spacing.sm,
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
  body: { flex: 1 },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: theme.font.small,
    fontWeight: '600',
    color: theme.colors.text,
    flex: 1,
    paddingRight: theme.spacing.sm,
  },
  count: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
    fontWeight: '600',
  },
  countAchieved: {
    color: theme.colors.success,
  },
  description: {
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
    backgroundColor: theme.colors.primary,
  },
  fillAchieved: {
    backgroundColor: theme.colors.success,
  },
});

export default MilestonesCard;
