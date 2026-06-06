import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import {
  reasonForProfile,
  formatLastSpoke,
  initialsFor,
} from './ReconnectCard';

const firstNameOf = (name) => (name || '').trim().split(/\s+/)[0] || 'them';

/**
 * The magnetic centrepiece of the home screen: one person pulled forward as
 * "the call to make right now", rendered as a bold, high-contrast hero with a
 * full-width call button — followed by a horizontal "up next" queue of the
 * other people worth reaching out to.
 *
 * This intentionally trades the calm, list-of-rows feel for a single focal
 * action. The reasoning copy and last-spoke formatting are shared with
 * ReconnectCard so the hero and the lanes below speak the same language.
 */
const SpotlightHero = ({ hero, queue = [], onPress, onCall }) => {
  if (!hero) return null;
  const reason = reasonForProfile(hero);
  const lastSpoke = formatLastSpoke(hero.summary);
  const firstName = firstNameOf(hero.contact?.name);
  const topGroup = hero.groups && hero.groups.length ? hero.groups[0] : null;

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={styles.hero}
        activeOpacity={0.92}
        onPress={() => onPress?.(hero)}
      >
        {/* Decorative accent blobs so the card reads as energetic, not flat. */}
        <View style={styles.blobOne} pointerEvents="none" />
        <View style={styles.blobTwo} pointerEvents="none" />

        <View style={styles.kickerRow}>
          <Icon name="lightning-bolt" size={14} color={theme.colors.background} />
          <Text style={styles.kicker}>YOUR MOVE TODAY</Text>
        </View>

        <View style={styles.heroRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initialsFor(hero.contact?.name)}</Text>
          </View>
          <View style={styles.heroBody}>
            <Text style={styles.name} numberOfLines={1}>
              {hero.contact?.name}
            </Text>
            <View style={styles.metaRow}>
              {topGroup ? (
                <View style={styles.groupPill}>
                  <Text style={styles.groupPillText} numberOfLines={1}>
                    {topGroup.name}
                  </Text>
                </View>
              ) : null}
              <Text style={styles.lastSpoke}>Last spoke {lastSpoke}</Text>
            </View>
          </View>
        </View>

        <Text style={styles.reason} numberOfLines={2}>
          {reason}
        </Text>

        <TouchableOpacity
          style={styles.callBtn}
          activeOpacity={0.85}
          onPress={() => onCall?.(hero)}
        >
          <Icon name="phone" size={20} color={theme.colors.surface} />
          <Text style={styles.callBtnText}>Call {firstName}</Text>
        </TouchableOpacity>
      </TouchableOpacity>

      {queue.length > 0 ? (
        <View style={styles.queueWrap}>
          <Text style={styles.queueLabel}>Up next</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.queueRow}
          >
            {queue.map((p) => (
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
                <Text style={styles.queueLast} numberOfLines={1}>
                  {formatLastSpoke(p.summary)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
  },
  hero: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    overflow: 'hidden',
    shadowColor: theme.colors.primaryDark,
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
    backgroundColor: 'rgba(224,120,86,0.18)',
  },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  kicker: {
    color: theme.colors.background,
    fontSize: theme.font.tiny,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginLeft: 6,
    opacity: 0.9,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
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
    fontSize: theme.font.h1,
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
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.pill,
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.lg,
    shadowColor: theme.colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  callBtnText: {
    color: theme.colors.surface,
    fontSize: theme.font.h3,
    fontWeight: '800',
    marginLeft: theme.spacing.sm,
  },
  queueWrap: {
    marginTop: theme.spacing.lg,
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

export default SpotlightHero;
