import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  Platform,
  ToastAndroid,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import AppHeader from '../components/AppHeader';
import { makeImmediateCall } from '../utils/makeImmediateCall';
import ReconnectCard from '../components/ReconnectCard';
import SectionHeader from '../components/SectionHeader';
import EmptyState from '../components/EmptyState';
import MilestonesCard from '../components/MilestonesCard';
import ConnectSetupGate from '../components/ConnectSetupGate';
import { useConnectAnalysis } from '../hooks/useConnectAnalysis';
import { useMilestones } from '../hooks/useMilestones';
import { getLastAnalyzedAt, recordReconnect, CATEGORIES } from '../storage';
import { formatTimestamp } from '../utils/dateUtils';
import { shareApp } from '../utils/appShare';
import AboutModal from '../components/AboutModal';

/**
 * The Connect Mode home dashboard. Built to feel like a "morning reflection"
 * surface, not a CRM dashboard: a small set of warmly-labelled lanes, soft
 * empty states, no charts or KPIs.
 *
 * The lanes correspond directly to the buckets the engine produces:
 *   - Reconnect Today
 *   - Lost Connections
 *   - Recently Reconnected
 *   - Missed Calls to Return
 */
const HomeScreen = ({ navigation }) => {
  const { analysis, refreshing, refresh, syncOnFocus } = useConnectAnalysis();
  // Recompute milestone progress whenever the analysis regenerates, since
  // reconnects are recorded as a side effect of a refresh/focus sync.
  const { milestones } = useMilestones(analysis?.generatedAt);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  // Whenever the home tab regains focus, pull the call-log delta since the
  // last sync (no contacts re-import, no spinner). This is what gives the
  // "real-time feel" — when the user returns from the system dialer or
  // another tab, fresh outgoing calls land in the engine within a beat.
  useFocusEffect(
    useCallback(() => {
      syncOnFocus();
    }, [syncOnFocus]),
  );

  const handleRefresh = useCallback(async () => {
    const result = await refresh();
    if (Platform.OS !== 'android') { return; }
    if (!result) {
      ToastAndroid.show('Couldn\'t sync', ToastAndroid.LONG);
      return;
    }
    if (result.refreshError) {
      ToastAndroid.show(result.refreshError, ToastAndroid.LONG);
      return;
    }
    ToastAndroid.show('Synced', ToastAndroid.SHORT);
  }, [refresh]);

  // When the user has no call logs (iOS / Android with logs denied / no logs
  // imported yet) the engine has nothing to score against, so the Reconnect
  // Today / Lost lanes will be empty. In that mode we surface one random
  // person from each contact group instead, so the dashboard still feels
  // populated and the user has somewhere to start.
  const hasCallLogSignal = useMemo(
    () =>
      (analysis?.profiles || []).some((p) => p.summary?.total > 0),
    [analysis],
  );

  const randomPerGroup = useMemo(() => {
    if (!analysis?.profiles?.length || hasCallLogSignal) return [];
    const byGroup = new Map();
    analysis.profiles.forEach((p) => {
      // "Say hi to someone today" is a reminder lane in spirit, so the same
      // suppression rules apply: skip don't-suggest contacts and groups marked
      // doNotRemind / helpers.
      if (p.remindersSuppressed) return;
      (p.groups || []).forEach((g) => {
        if (g?.doNotRemind || g?.categoryId === 'helpers') return;
        const arr = byGroup.get(g.id) || [];
        arr.push(p);
        byGroup.set(g.id, arr);
      });
    });
    const out = [];
    byGroup.forEach((members, groupId) => {
      const pick = members[Math.floor(Math.random() * members.length)];
      if (!pick) return;
      const group = pick.groups?.find((g) => g.id === groupId);
      out.push({ profile: pick, group });
    });
    // Order by category (friends, then family/relatives, then office/colleagues,
    // ...) so this lane matches the "Important groups" ordering.
    const categoryOrder = new Map(CATEGORIES.map((c, i) => [c.id, i]));
    const rank = ({ group }) =>
      categoryOrder.has(group?.categoryId)
        ? categoryOrder.get(group.categoryId)
        : CATEGORIES.length;
    out.sort((a, b) => rank(a) - rank(b));
    return out.slice(0, 10);
  }, [analysis, hasCallLogSignal]);

  const onCardPress = useCallback(
    (profile) => {
      navigation.navigate('ConnectContactDetail', {
        phone: profile.contact.normalized,
      });
    },
    [navigation],
  );

  const onCall = useCallback((profile) => {
    const phone = profile?.contact?.phone;
    if (!phone) return;
    recordReconnect(phone);
    makeImmediateCall(phone).catch(() => {});
  }, []);

  return (
    <View style={styles.container}>
      <AppHeader
        title="Connect"
        subtitle="Who should you reach out to today?"
        rightElement={
          <View style={styles.headerRightWrap}>
            <TouchableOpacity
              onPress={() => setOverflowOpen(true)}
              style={styles.overflowBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Icon name="dots-vertical" size={22} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        }
      />
      <ConnectSetupGate>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
          />
        }
        contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
      >
        {(() => {
          const ts = getLastAnalyzedAt();
          return ts ? (
            <Text style={styles.lastSynced}>
              Last synced {formatTimestamp(ts)}
            </Text>
          ) : null;
        })()}

        {/* Top-of-funnel quick stats — soft, never KPI-style. */}
        <View style={styles.statsRow}>
          <Stat label="People" value={analysis?.counts?.total ?? 0} />
          <Stat
            label="Dormant"
            value={analysis?.counts?.lostConnections ?? 0}
            highlight
          />
          <Stat
            label="Reconnected"
            caption="(7d)"
            value={analysis?.counts?.recentlyReconnected ?? 0}
          />
        </View>

        {milestones.length > 0 ? (
          <>
            <SectionHeader
              title="Milestones"
              caption="Small wins as you keep your circle warm"
            />
            <MilestonesCard milestones={milestones} />
          </>
        ) : null}

        {!hasCallLogSignal && randomPerGroup.length > 0 ? (
          <>
            <SectionHeader
              title="Say hi to someone today"
              caption="No call history yet — here's a random person from each of your groups."
            />
            {randomPerGroup.map(({ profile: p, group }) => (
              <ReconnectCard
                key={`rand_${group?.id}_${p.contact.normalized}`}
                profile={p}
                onPress={() => onCardPress(p)}
                onCall={() => onCall(p)}
              />
            ))}
          </>
        ) : null}

        {/* iOS has no call history to derive reconnect suggestions from, so an
            empty lane is just noise — hide the whole section unless we have
            cards. Android keeps the soft empty state since its call log can
            legitimately produce zero results. */}
        {Platform.OS !== 'android' && (analysis?.reconnectToday || []).length === 0 ? null : (
          <>
            <SectionHeader
              title="Reconnect today"
              caption="Quietly nudging the relationships worth keeping warm"
              actionLabel={
                (analysis?.reconnectToday || []).length > 5 ? 'See all' : null
              }
              onActionPress={() => navigation.navigate('ConnectReconnect')}
            />
            {(analysis?.reconnectToday || []).length === 0 ? (
              <EmptyState
                icon="weather-sunny"
                title={hasCallLogSignal ? 'All caught up' : 'Waiting for call history'}
                body={
                  hasCallLogSignal
                    ? 'Nothing pressing right now — enjoy the quiet.'
                    : Platform.OS === 'android'
                    ? 'Once we have your call log we can spot dormant friendships.'
                    : 'iOS doesn\'t expose call history — use the random picks above instead.'
                }
              />
            ) : (
              (analysis?.reconnectToday || []).slice(0, 5).map((p) => (
                <ReconnectCard
                  key={p.contact.normalized}
                  profile={p}
                  onPress={() => onCardPress(p)}
                  onCall={() => onCall(p)}
                />
              ))
            )}
          </>
        )}

        {/* Missed connections: people who called and we never called back. Same
            iOS/Android visibility rule as lost connections — iOS has no call
            history to derive these from, so hide the lane entirely when empty;
            Android keeps the soft empty state. */}
        {Platform.OS !== 'android' && (analysis?.missedCallsToReturn || []).length === 0 ? null : (
          <>
            <SectionHeader
              title="Missed connections"
              caption="They called — you have not called back yet"
              actionLabel={
                (analysis?.missedCallsToReturn || []).length > 5 ? 'See all' : null
              }
              onActionPress={() => navigation.navigate('ConnectMissed')}
            />
            {(analysis?.missedCallsToReturn || []).length === 0 ? (
              <EmptyState
                icon="phone-missed-outline"
                title="No missed connections"
                body="You have returned everyone's calls."
                compact
              />
            ) : (
              (analysis?.missedCallsToReturn || []).slice(0, 4).map((p) => (
                <ReconnectCard
                  key={p.contact.normalized}
                  profile={p}
                  compact
                  onPress={() => onCardPress(p)}
                  onCall={() => onCall(p)}
                />
              ))
            )}
          </>
        )}

        {(analysis?.recentlyReconnected || []).length > 0 ? (
          <>
            <SectionHeader
              title="Recently reconnected"
              caption="The momentum you have already built"
            />
            {(analysis?.recentlyReconnected || []).slice(0, 5).map((p) => (
              <ReconnectCard
                key={`r_${p.contact.normalized}`}
                profile={p}
                compact
                onPress={() => onCardPress(p)}
              />
            ))}
          </>
        ) : null}

        {(analysis?.missedCallsToReturn || []).length > 0 ? (
          <>
            <SectionHeader
              title="Missed calls to return"
              caption={Platform.OS !== 'android' ? 'Android only' : undefined}
            />
            {(analysis?.missedCallsToReturn || []).slice(0, 5).map((p) => (
              <ReconnectCard
                key={`m_${p.contact.normalized}`}
                profile={p}
                compact
                onPress={() => onCardPress(p)}
                onCall={() => onCall(p)}
              />
            ))}
          </>
        ) : null}

      </ScrollView>
      </ConnectSetupGate>

      <Modal
        visible={overflowOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setOverflowOpen(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={styles.overflowBackdrop}
          onPress={() => setOverflowOpen(false)}
        >
          <View style={styles.overflowCard}>
            <TouchableOpacity
              style={styles.overflowRow}
              onPress={() => {
                // Close the overflow menu first, then open the native share
                // sheet once the Modal has finished dismissing. Invoking
                // Share.share() while the Modal is still on screen makes the
                // share sheet present over (or get cancelled by) the dismissing
                // modal — which is why this silently did nothing here while the
                // identical button on the Settings screen (no modal) worked.
                setOverflowOpen(false);
                setTimeout(shareApp, 300);
              }}
            >
              <Icon name="share-variant-outline" size={18} color={theme.colors.primary} />
              <Text style={styles.overflowText}>Share Connect</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.overflowRow}
              onPress={() => {
                // Close the overflow menu, then open the About modal once the
                // menu Modal has finished dismissing (same presentation
                // ordering as Share, above).
                setOverflowOpen(false);
                setTimeout(() => setAboutOpen(true), 300);
              }}
            >
              <Icon name="information-outline" size={18} color={theme.colors.primary} />
              <Text style={styles.overflowText}>About</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <AboutModal visible={aboutOpen} onClose={() => setAboutOpen(false)} />
    </View>
  );
};

const Stat = ({ label, value, caption, highlight }) => (
  <View style={[styles.statCard, highlight && styles.statCardHighlight]}>
    <Text style={[styles.statValue, highlight && styles.statValueHighlight]}>{value}</Text>
    <Text style={styles.statLabel}>
      {label}
      {caption ? <Text style={styles.statCaption}> {caption}</Text> : null}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  lastSynced: {
    color: theme.colors.primary,
    fontSize: theme.font.tiny,
    fontWeight: '600',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingTop: theme.spacing.sm,
  },
  statsRow: {
    flexDirection: 'row',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  statCard: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginRight: theme.spacing.sm,
  },
  statCardHighlight: {
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: theme.colors.accent,
  },
  statValue: {
    fontSize: theme.font.h1,
    fontWeight: '700',
    color: theme.colors.text,
  },
  statValueHighlight: {
    color: theme.colors.accent,
  },
  statLabel: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  statCaption: { color: theme.colors.textSubtle },
  headerRightWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  overflowBtn: {
    paddingHorizontal: 4,
    marginRight: theme.spacing.xs,
  },
  loginBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
  },
  loginBtnText: {
    marginLeft: 4,
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: theme.font.small,
  },
  overflowBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  overflowCard: {
    position: 'absolute',
    top: 80,
    right: theme.spacing.lg,
    minWidth: 240,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing.xs,
  },
  overflowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  overflowText: {
    marginLeft: theme.spacing.md,
    fontSize: theme.font.body,
    color: theme.colors.text,
  },
});

export default HomeScreen;
