import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import { WANT_TO_CONNECT_GROUP_ID } from '../storage';
import { calendarDaysSince, formatClockTime } from '../utils/dateUtils';

/**
 * Builds a single, gentle reason string describing why this contact is being
 * surfaced. Intentionally written as a sentence, not a metric — Connect Mode
 * is supposed to feel reflective, not analytical.
 */
const reasonForProfile = (profile) => {
  if (!profile) return '';
  const { summary, labels } = profile;
  if (labels.includes('lost_connection')) {
    if (summary.daysSinceLast) {
      const months = Math.round(summary.daysSinceLast / 30);
      return `You used to talk often — last spoke ${months >= 12 ? 'over a year' : `${months} months`} ago`;
    }
    return 'You used to talk often — it has been a while';
  }
  if (labels.includes('strong_historical') && summary.daysSinceLast >= 60) {
    return `Strong past communication, quiet for ${summary.daysSinceLast} days`;
  }
  if (summary.pendingMissed > 0) {
    // pendingMissed > 0 means the most recent interaction is a missed call, so
    // `summary.last` is exactly when that call came in. Use the calendar-day
    // count (not the elapsed-ms `daysSinceLast`) so a call last night reads
    // "yesterday", not "today".
    const days = calendarDaysSince(summary.last);
    const when = relativeDays(days);
    // For a same-day or previous-day miss the clock time is meaningful, so pin
    // it ("yesterday at 10:27 PM"); older misses just read the relative day.
    const at =
      days !== null && days <= 1 && formatClockTime(summary.last)
        ? `${when} at ${formatClockTime(summary.last)}`
        : when;
    if (summary.pendingMissed === 1) {
      return at
        ? `Missed call ${at}`
        : 'You have a missed call to return';
    }
    return at
      ? `${summary.pendingMissed} missed calls, latest ${at}`
      : `You have ${summary.pendingMissed} missed calls to return`;
  }
  if (summary.daysSinceLast === null) {
    return 'No recorded interaction yet';
  }
  if (summary.daysSinceLast >= 30) {
    return `No contact in ${summary.daysSinceLast} days`;
  }
  return '';  // kept blank to remove crowding when the reason is just "recently contacted"
};

// Compact "how long ago" label from a day count, e.g. "Today", "3d ago".
// Returns '' when the day count is unusable so callers can fall back gracefully.
const relativeDays = (d) => {
  if (d === null || d === undefined || Number.isNaN(d)) return '';
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.round(d / 7)}w ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
};

const formatLastSpoke = (summary) => {
  // "Spoke" means an actual connected call — a missed/rejected call doesn't
  // count, so read the connected-only recency, not the any-interaction `last`.
  if (!summary.lastConnected) return 'Never';
  const label = relativeDays(calendarDaysSince(summary.lastConnected));
  // Capitalise the leading word to match the original card styling.
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Never';
};

const initialsFor = (name) => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const ReconnectCard = ({ profile, onPress, onCall, compact = false }) => {
  if (!profile) return null;
  const { contact, summary } = profile;
  // The standard "Want to connect" group is a redundant label on a card, so
  // never render it as a chip.
  const groups = (profile.groups || []).filter(
    (g) => g.id !== WANT_TO_CONNECT_GROUP_ID,
  );
  const reason = reasonForProfile(profile);
  const lastSpoke = formatLastSpoke(summary);
  const hasLastSpoke = lastSpoke !== 'Never';

  return (
    <TouchableOpacity
      style={[styles.card, compact && styles.cardCompact]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initialsFor(contact.name)}</Text>
      </View>

      <View style={styles.body}>
        <View style={styles.topRow}>
          <Text style={styles.name} numberOfLines={1}>
            {contact.name}
          </Text>
          {hasLastSpoke ? (
            <Text style={styles.lastSpoke}>{lastSpoke}</Text>
          ) : null}
        </View>
        <Text style={styles.reason} numberOfLines={2}>
          {reason}
        </Text>
        {groups && groups.length ? (
          <View style={styles.chipsRow}>
            {groups.slice(0, 3).map((g) => (
              <View
                key={g.id}
                style={[styles.chip, { borderColor: g.color || theme.colors.primary }]}
              >
                <Text
                  style={[styles.chipText, { color: g.color || theme.colors.primary }]}
                >
                  {g.name}
                </Text>
              </View>
            ))}
            {groups.length > 3 ? (
              <Text style={styles.moreChip}>+{groups.length - 3}</Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {onCall ? (
        <TouchableOpacity
          onPress={onCall}
          style={styles.callBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Icon name="phone" size={20} color={theme.colors.surface} />
        </TouchableOpacity>
      ) : null}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardCompact: {
    paddingVertical: theme.spacing.sm,
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
    color: theme.colors.primaryDark,
    fontWeight: '700',
    fontSize: theme.font.h3,
  },
  body: {
    flex: 1,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  name: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
    flex: 1,
    paddingRight: theme.spacing.sm,
  },
  lastSpoke: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
  },
  reason: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  chipsRow: {
    flexDirection: 'row',
    marginTop: theme.spacing.sm,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  chip: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    marginRight: theme.spacing.xs,
    marginBottom: 2,
  },
  chipText: {
    fontSize: theme.font.tiny,
    fontWeight: '600',
  },
  moreChip: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
  },
  callBtn: {
    backgroundColor: theme.colors.primary,
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: theme.spacing.sm,
  },
});

export default ReconnectCard;
export { reasonForProfile, formatLastSpoke, initialsFor };
