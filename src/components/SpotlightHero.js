import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import {
  reasonForProfile,
  formatLastSpoke,
  initialsFor,
} from './ReconnectCard';
import { WANT_TO_CONNECT_GROUP_ID } from '../storage';

const firstNameOf = (name) => (name || '').trim().split(/\s+/)[0] || 'them';

/**
 * A bold, high-contrast "spotlight" card that pulls one person forward as the
 * call to make right now. Parametrised so the home carousel can render both the
 * "Reach out today" card (teal) and the "Missed connections" card (terracotta)
 * from the same component — they only differ in colour, kicker, and footer.
 *
 * `width` is supplied by the carousel so each card is a fixed page width and
 * the next one peeks ~10% to hint that it's swipeable.
 */
const SpotlightCard = ({
  profile,
  width,
  variant = 'primary',
  kicker,
  kickerIcon = 'lightning-bolt',
  subline,
  footerLabel,
  onFooterPress,
  emptyTitle,
  emptyBody,
  onPress,
  onCall,
}) => {
  const bg = variant === 'accent' ? theme.colors.accent : theme.colors.primary;
  const shadow = variant === 'accent' ? theme.colors.accent : theme.colors.primaryDark;

  const Kicker = (
    <View style={styles.kickerRow}>
      <Icon name={kickerIcon} size={14} color={theme.colors.background} />
      <Text style={styles.kicker}>{kicker}</Text>
    </View>
  );

  // Empty state (e.g. no missed connections, but the card is force-shown).
  if (!profile) {
    return (
      <View
        style={[styles.card, { width, backgroundColor: bg, shadowColor: shadow }]}
      >
        <View style={styles.blobOne} pointerEvents="none" />
        {Kicker}
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>{emptyTitle}</Text>
          {emptyBody ? <Text style={styles.emptyBody}>{emptyBody}</Text> : null}
        </View>
      </View>
    );
  }

  const reason = reasonForProfile(profile);
  const lastSpoke = formatLastSpoke(profile.summary);
  const hasLastSpoke = lastSpoke !== 'Never';
  const firstName = firstNameOf(profile.contact?.name);
  // Skip the standard "Want to connect" group — it's a redundant label here.
  const topGroup =
    (profile.groups || []).find((g) => g.id !== WANT_TO_CONNECT_GROUP_ID) || null;

  return (
    <TouchableOpacity
      style={[styles.card, { width, backgroundColor: bg, shadowColor: shadow }]}
      activeOpacity={0.92}
      onPress={() => onPress?.(profile)}
    >
      {/* Decorative accent blobs so the card reads as energetic, not flat. */}
      <View style={styles.blobOne} pointerEvents="none" />
      <View style={styles.blobTwo} pointerEvents="none" />

      {Kicker}
      {subline ? <Text style={styles.subline}>{subline}</Text> : null}

      <View style={styles.heroRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initialsFor(profile.contact?.name)}</Text>
        </View>
        <View style={styles.heroBody}>
          <Text style={styles.name} numberOfLines={2}>
            {profile.contact?.name}
          </Text>
          <View style={styles.metaRow}>
            {topGroup ? (
              <View style={styles.groupPill}>
                <Text style={styles.groupPillText} numberOfLines={1}>
                  {topGroup.name}
                </Text>
              </View>
            ) : null}
            {hasLastSpoke ? (
              <Text style={styles.lastSpoke}>Last spoke {lastSpoke}</Text>
            ) : null}
          </View>
        </View>
      </View>

      <Text style={styles.reason} numberOfLines={2}>
        {reason}
      </Text>

      <TouchableOpacity
        style={styles.callBtn}
        activeOpacity={0.85}
        onPress={() => onCall?.(profile)}
      >
        <Icon name="phone" size={20} color={theme.colors.surface} />
        <Text style={styles.callBtnText}>Call {firstName}</Text>
      </TouchableOpacity>

      {footerLabel ? (
        <TouchableOpacity
          style={styles.footer}
          activeOpacity={0.7}
          onPress={onFooterPress}
        >
          <Text style={styles.footerText}>{footerLabel}</Text>
          <Icon name="chevron-right" size={16} color={theme.colors.surface} />
        </TouchableOpacity>
      ) : null}
    </TouchableOpacity>
  );
};

/**
 * The horizontal "up next" queue of other people worth reaching out to. Lives
 * below the carousel (full width) so its horizontal scroll never fights the
 * carousel's paging gesture.
 */
const UpNextRow = ({ items = [], onPress, onCall }) => {
  if (!items.length) return null;
  return (
    <View style={styles.queueWrap}>
      <Text style={styles.queueLabel}>Up next</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.queueRow}
      >
        {items.map((p) => {
          const last = formatLastSpoke(p.summary);
          return (
            <TouchableOpacity
              key={p.contact.normalized}
              style={styles.queueItem}
              activeOpacity={0.8}
              onPress={() => onPress?.(p)}
            >
              <View style={styles.queueAvatar}>
                <Text style={styles.queueAvatarText}>
                  {initialsFor(p.contact?.name)}
                </Text>
                <TouchableOpacity
                  style={styles.queueCall}
                  activeOpacity={0.85}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  onPress={() => onCall?.(p)}
                >
                  <Icon name="phone" size={12} color={theme.colors.surface} />
                </TouchableOpacity>
              </View>
              <Text style={styles.queueName} numberOfLines={1}>
                {firstNameOf(p.contact?.name)}
              </Text>
              {last !== 'Never' ? (
                <Text style={styles.queueLast} numberOfLines={1}>
                  {last}
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    overflow: 'hidden',
    minHeight: 196,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 6,
  },
  blobOne: {
    position: 'absolute',
    top: -50,
    right: -40,
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  blobTwo: {
    position: 'absolute',
    bottom: -60,
    left: -30,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  kicker: {
    color: theme.colors.background,
    fontSize: theme.font.tiny,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginLeft: 6,
    opacity: 0.9,
  },
  subline: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: theme.font.tiny,
    marginTop: 4,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: theme.spacing.md,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.md,
  },
  avatarText: {
    color: theme.colors.primaryDark,
    fontWeight: '800',
    fontSize: theme.font.h2,
  },
  heroBody: { flex: 1 },
  name: {
    color: theme.colors.surface,
    fontSize: theme.font.h2,
    fontWeight: '800',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    flexWrap: 'wrap',
  },
  groupPill: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    borderRadius: theme.radius.pill,
    marginRight: theme.spacing.sm,
    maxWidth: 140,
  },
  groupPillText: {
    color: theme.colors.surface,
    fontSize: theme.font.tiny,
    fontWeight: '700',
  },
  lastSpoke: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: theme.font.tiny,
    fontWeight: '600',
  },
  reason: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: theme.font.body,
    lineHeight: 21,
    marginTop: theme.spacing.md,
  },
  callBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
    borderRadius: theme.radius.pill,
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  callBtnText: {
    color: theme.colors.surface,
    fontSize: theme.font.h3,
    fontWeight: '800',
    marginLeft: theme.spacing.sm,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: theme.spacing.md,
  },
  footerText: {
    color: theme.colors.surface,
    fontSize: theme.font.small,
    fontWeight: '700',
    opacity: 0.95,
  },
  emptyWrap: {
    paddingVertical: theme.spacing.xl,
    alignItems: 'center',
  },
  emptyTitle: {
    color: theme.colors.surface,
    fontSize: theme.font.h3,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyBody: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: theme.font.small,
    textAlign: 'center',
    marginTop: 4,
  },
  queueWrap: {
    marginTop: theme.spacing.lg,
    marginHorizontal: theme.spacing.lg,
  },
  queueLabel: {
    fontSize: theme.font.tiny,
    fontWeight: '800',
    letterSpacing: 1,
    color: theme.colors.textSubtle,
    textTransform: 'uppercase',
    marginBottom: theme.spacing.sm,
  },
  queueRow: {
    paddingRight: theme.spacing.lg,
  },
  queueItem: {
    width: 64,
    alignItems: 'center',
    marginRight: theme.spacing.md,
  },
  queueAvatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: theme.colors.chipBg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  queueAvatarText: {
    color: theme.colors.primaryDark,
    fontWeight: '800',
    fontSize: theme.font.h3,
  },
  queueCall: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: theme.colors.background,
  },
  queueName: {
    fontSize: theme.font.small,
    fontWeight: '700',
    color: theme.colors.text,
    marginTop: 6,
    maxWidth: 64,
  },
  queueLast: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
  },
});

export { SpotlightCard, UpNextRow };
