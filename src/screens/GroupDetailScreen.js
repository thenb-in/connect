import React, { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, FlatList } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import theme from '../theme';
import AppHeader from '../components/AppHeader';
import ContactSearchBar from '../components/ContactSearchBar';
import ReconnectCard from '../components/ReconnectCard';
import EmptyState from '../components/EmptyState';
import ConnectSetupGate from '../components/ConnectSetupGate';
import { useConnectAnalysis } from '../hooks/useConnectAnalysis';
import { getDisplayGroups, recordReconnect, UNKNOWN_GROUP_ID } from '../storage';
import { makeImmediateCall } from '../utils/makeImmediateCall';

/**
 * Shows every contact tagged with a single group, ordered by reconnect
 * priority so the most dormant relationships in the group surface first.
 */
const GroupDetailScreen = ({ navigation, route }) => {
  const groupId = route?.params?.groupId;
  const { analysis, reanalyzeFromCache } = useConnectAnalysis();
  const [results, setResults] = useState([]);

  // Re-read group membership from storage whenever this screen regains focus.
  // Tagging a contact into a group happens on the contact detail screen, which
  // writes to MMKV; without this the already-mounted group screen keeps its
  // stale analysis and the contact count stays at 0 after coming back.
  useFocusEffect(
    useCallback(() => {
      reanalyzeFromCache();
    }, [reanalyzeFromCache]),
  );

  const group = useMemo(
    () => getDisplayGroups().find((g) => g.id === groupId) || null,
    [groupId],
  );

  const profiles = useMemo(() => {
    const all = analysis?.profiles || [];
    // Synthetic Unknown group: contacts not in ANY real group. The engine
    // populates p.groups by joining contactGroups + getGroups(), which
    // doesn't include the synthetic group, so "no groups" here means the
    // contact is uncategorised.
    if (groupId === UNKNOWN_GROUP_ID) {
      return all
        .filter((p) => !p.groups || p.groups.length === 0)
        .sort((a, b) => b.priority - a.priority);
    }
    return all
      .filter((p) => (p.groups || []).some((g) => g.id === groupId))
      .sort((a, b) => b.priority - a.priority);
  }, [analysis, groupId]);

  const onCall = useCallback((profile) => {
    const phone = profile?.contact?.phone;
    if (!phone) return;
    recordReconnect(phone);
    makeImmediateCall(phone).catch(() => {});
  }, []);

  return (
    <View style={styles.container}>
      <AppHeader
        title={group?.name || 'Group'}
        subtitle={
          profiles.length
            ? `${profiles.length} contact${profiles.length === 1 ? '' : 's'} • sorted by who to reach out to first`
            : 'Empty group'
        }
        onBack={() => navigation.goBack()}
      />
      <ConnectSetupGate>
      <ContactSearchBar data={profiles} onResults={setResults} />
      <FlatList
        data={results}
        keyExtractor={(p) => p.contact.normalized || p.contact.key}
        renderItem={({ item }) => (
          <ReconnectCard
            profile={item}
            onPress={() =>
              navigation.navigate('ConnectContactDetail', {
                phone: item.contact.normalized,
              })
            }
            onCall={() => onCall(item)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            icon="account-plus-outline"
            title="No contacts in this group yet"
            body="Open a contact and tap a group chip to add them."
          />
        }
        contentContainerStyle={{
          paddingTop: theme.spacing.md,
          paddingBottom: theme.spacing.xxl,
        }}
      />
      </ConnectSetupGate>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
});

export default GroupDetailScreen;
