import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  RefreshControl,
  TextInput,
} from 'react-native';
import { makeImmediateCall } from '../utils/makeImmediateCall';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import AppHeader from '../components/AppHeader';
import ReconnectCard from '../components/ReconnectCard';
import EmptyState from '../components/EmptyState';
import ConnectSetupGate from '../components/ConnectSetupGate';
import { useConnectAnalysis } from '../hooks/useConnectAnalysis';
import { recordReconnect } from '../storage';

/**
 * One screen that renders any of the engine's lanes. The variant is selected
 * via `route.params.lane` so we don't ship three near-identical files.
 *
 * Lanes:
 *   reconnect -> analysis.reconnectToday  (extended, no slice cap)
 *   lost      -> analysis.lostConnections
 *   never     -> analysis.neverConnected
 *   missed    -> analysis.missedCallsToReturn
 *   consistent -> analysis.consistent
 */
const LANES = {
  reconnect: {
    title: 'Reconnect',
    subtitle: 'People worth reaching out to today',
    key: 'reconnectToday',
    emptyIcon: 'weather-sunny',
    emptyTitle: 'All caught up',
    emptyBody: 'Nothing pressing right now. Come back tomorrow.',
  },
  lost: {
    title: 'Lost connections',
    subtitle: 'Strong past communication, quiet for a while',
    key: 'lostConnections',
    emptyIcon: 'account-clock-outline',
    emptyTitle: 'No lost connections',
    emptyBody: 'Your historically strong relationships are still warm.',
  },
  never: {
    title: 'Never connected',
    subtitle: 'Saved contacts you have not yet spoken with',
    key: 'neverConnected',
    emptyIcon: 'account-multiple-outline',
    emptyTitle: 'You have spoken with everyone you saved',
    emptyBody: 'There are no untouched contacts in your phone book.',
  },
  missed: {
    title: 'Missed calls',
    subtitle: 'Quietly waiting to be returned',
    key: 'missedCallsToReturn',
    emptyIcon: 'phone-missed-outline',
    emptyTitle: 'No missed calls',
    emptyBody: 'Nothing waiting on you right now.',
  },
  consistent: {
    title: 'Consistent',
    subtitle: 'The relationships you keep warm',
    key: 'consistent',
    emptyIcon: 'heart-outline',
    emptyTitle: 'No consistent relationships yet',
    emptyBody: 'Reach out to a few people regularly and they will appear here.',
  },
};

const ReconnectListScreen = ({ navigation, route }) => {
  const laneKey = route?.params?.lane || 'reconnect';
  const lane = LANES[laneKey] || LANES.reconnect;
  const { analysis, refreshing, refresh } = useConnectAnalysis();
  const [query, setQuery] = useState('');

  const data = useMemo(() => {
    const list = analysis?.[lane.key] || [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) =>
      (p.contact.name || '').toLowerCase().includes(q),
    );
  }, [analysis, lane.key, query]);

  const onCardPress = useCallback(
    (profile) =>
      navigation.navigate('ConnectContactDetail', {
        phone: profile.contact.normalized,
      }),
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
        title={lane.title}
        subtitle={lane.subtitle}
        onBack={() => navigation.goBack()}
      />
      <ConnectSetupGate>
      <View style={styles.searchWrap}>
        <Icon name="magnify" size={18} color={theme.colors.textSubtle} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name"
          placeholderTextColor={theme.colors.textSubtle}
          value={query}
          onChangeText={setQuery}
        />
      </View>
      <FlatList
        data={data}
        keyExtractor={(p) => p.contact.normalized || p.contact.key}
        renderItem={({ item }) => (
          <ReconnectCard
            profile={item}
            onPress={() => onCardPress(item)}
            onCall={() => onCall(item)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            icon={lane.emptyIcon}
            title={lane.emptyTitle}
            body={lane.emptyBody}
          />
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => refresh()}
            tintColor={theme.colors.primary}
          />
        }
        contentContainerStyle={{ paddingTop: theme.spacing.md, paddingBottom: theme.spacing.xxl }}
      />
      </ConnectSetupGate>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.pill,
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing.sm,
    paddingLeft: theme.spacing.sm,
    fontSize: theme.font.body,
    color: theme.colors.text,
  },
});

export default ReconnectListScreen;
