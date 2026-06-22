import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, Vibration } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import AppHeader from '../components/AppHeader';
import ContactSearchBar from '../components/ContactSearchBar';
import ContactPickerModal from '../components/ContactPickerModal';
import ReconnectCard from '../components/ReconnectCard';
import EmptyState from '../components/EmptyState';
import ConnectSetupGate from '../components/ConnectSetupGate';
import { useConnectAnalysis } from '../hooks/useConnectAnalysis';
import {
  getContacts,
  getContactGroupMap,
  getDisplayGroups,
  addContactsToGroup,
  removeContactsFromGroup,
  UNKNOWN_GROUP_ID,
} from '../storage';
import { initiateTrackedCall } from '../utils/makeImmediateCall';

const keyForProfile = (p) => p.contact.normalized || p.contact.key;

/**
 * Shows every contact tagged with a single group, ordered by reconnect
 * priority so the most dormant relationships in the group surface first.
 */
const GroupDetailScreen = ({ navigation, route }) => {
  const groupId = route?.params?.groupId;
  const insets = useSafeAreaInsets();
  const { analysis, reanalyzeFromCache } = useConnectAnalysis();
  const [results, setResults] = useState([]);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  // The "Add contacts" picker: lets you drop any contact into this group
  // straight from here, whether or not the group already has members.
  const [pickerOpen, setPickerOpen] = useState(false);

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

  // The synthetic "Unknown" group holds contacts in no real group, so there's
  // nothing to remove them from — selection is only meaningful for real groups.
  const canSelect = groupId && groupId !== UNKNOWN_GROUP_ID;

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
    // Records a provisional reconnect, then the call monitor reconciles it with
    // what actually happened (real duration, or removed if it never connected).
    initiateTrackedCall(phone).catch(() => {});
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const toggle = useCallback((key) => {
    if (!key) return;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // "Select all" works on the currently filtered (visible) list, so a search
  // can narrow the set before grabbing the whole result.
  const visibleKeys = useMemo(() => results.map(keyForProfile), [results]);
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));

  const onToggleSelectAll = useCallback(() => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allVisibleSelected) visibleKeys.forEach((k) => next.delete(k));
      else visibleKeys.forEach((k) => next.add(k));
      return next;
    });
  }, [visibleKeys, allVisibleSelected]);

  const onRemoveSelected = useCallback(() => {
    const phones = profiles
      .filter((p) => selected.has(keyForProfile(p)))
      .map((p) => p.contact.normalized || p.contact.phone)
      .filter(Boolean);
    if (!phones.length) return;
    const n = phones.length;
    Alert.alert(
      `Remove ${n} contact${n === 1 ? '' : 's'}?`,
      `This removes ${n === 1 ? 'them' : 'them'} from "${group?.name || 'this group'}". Their other groups and history stay untouched.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            removeContactsFromGroup(phones, groupId);
            exitSelectMode();
            reanalyzeFromCache();
          },
        },
      ],
    );
  }, [profiles, selected, group, groupId, exitSelectMode, reanalyzeFromCache]);

  // Candidates for the picker = everyone not already in this group, so the
  // shared ContactPickerModal only ever offers people you can actually add.
  const addCandidates = useMemo(() => {
    if (!pickerOpen) return [];
    const map = getContactGroupMap();
    return getContacts().filter((c) => {
      const key = c.normalized;
      return !key || !(map[key] || []).includes(groupId);
    });
  }, [pickerOpen, groupId]);

  const onConfirmAdd = useCallback(
    (phones) => {
      setPickerOpen(false);
      if (!phones || !phones.length) return;
      const added = addContactsToGroup(phones, groupId);
      Vibration.vibrate(40);
      reanalyzeFromCache();
      Alert.alert(
        'Added',
        `${added} ${added === 1 ? 'contact' : 'contacts'} added to "${group?.name || 'this group'}".`,
      );
    },
    [groupId, group, reanalyzeFromCache],
  );

  const renderItem = useCallback(
    ({ item }) => {
      if (!selectMode) {
        return (
          <ReconnectCard
            profile={item}
            onPress={() =>
              navigation.navigate('ConnectContactDetail', {
                phone: item.contact.normalized,
              })
            }
            onCall={() => onCall(item)}
          />
        );
      }
      const key = keyForProfile(item);
      const checked = selected.has(key);
      return (
        <View style={styles.selectRow}>
          <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
            {checked ? (
              <Icon name="check" size={14} color={theme.colors.surface} />
            ) : null}
          </View>
          <View style={{ flex: 1 }}>
            <ReconnectCard profile={item} onPress={() => toggle(key)} />
          </View>
        </View>
      );
    },
    [selectMode, selected, navigation, onCall, toggle],
  );

  const subtitle = selectMode
    ? `${selected.size} selected`
    : profiles.length
    ? `${profiles.length} contact${profiles.length === 1 ? '' : 's'} • sorted by who to reach out to first`
    : 'Empty group';

  return (
    <View style={styles.container}>
      <AppHeader
        title={group?.name || 'Group'}
        subtitle={subtitle}
        onBack={selectMode ? undefined : () => navigation.goBack()}
        rightLabel={
          selectMode
            ? 'Done'
            : canSelect && profiles.length
            ? 'Select'
            : undefined
        }
        onRightPress={selectMode ? exitSelectMode : () => setSelectMode(true)}
      />
      <ConnectSetupGate>
      <ContactSearchBar data={profiles} onResults={setResults} />
      {selectMode && results.length ? (
        <View style={styles.selectBar}>
          <TouchableOpacity onPress={onToggleSelectAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.selectBarBtn}>
              {allVisibleSelected ? 'Unselect all' : 'Select all'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <FlatList
        data={results}
        keyExtractor={keyForProfile}
        renderItem={renderItem}
        ListEmptyComponent={
          <EmptyState
            icon="account-plus-outline"
            title="No contacts in this group yet"
            body={
              canSelect
                ? 'Tap "Add contacts" below to drop people into this group.'
                : 'Open a contact and tap a group chip to add them.'
            }
          />
        }
        contentContainerStyle={{
          paddingTop: theme.spacing.md,
          paddingBottom: selectMode ? 120 : canSelect ? 120 : theme.spacing.xxl,
        }}
      />
      </ConnectSetupGate>

      {selectMode ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + theme.spacing.lg }]}>
          <TouchableOpacity
            style={[styles.removeBtn, selected.size === 0 && styles.btnDisabled]}
            disabled={selected.size === 0}
            onPress={onRemoveSelected}
            activeOpacity={0.85}
          >
            <Icon name="account-remove-outline" size={18} color={theme.colors.surface} />
            <Text style={styles.removeBtnText}>
              {selected.size > 0
                ? `Remove from group (${selected.size})`
                : 'Remove from group'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!selectMode && canSelect ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + theme.spacing.lg }]}>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => setPickerOpen(true)}
            activeOpacity={0.85}
          >
            <Icon name="account-plus" size={18} color={theme.colors.surface} />
            <Text style={styles.addBtnText}>Add contacts</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <ContactPickerModal
        visible={pickerOpen}
        title={`Add to ${group?.name || 'group'}`}
        subtitle="Search and pick the people to drop into this group."
        contacts={addCandidates}
        confirmLabel="Add to group"
        onConfirm={onConfirmAdd}
        onSkip={() => setPickerOpen(false)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  selectBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xs,
  },
  selectBarBtn: {
    color: theme.colors.primary,
    fontWeight: '700',
    fontSize: theme.font.small,
  },
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    marginLeft: theme.spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
  },
  checkboxChecked: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    backgroundColor: theme.colors.background,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  removeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  removeBtnText: {
    color: theme.colors.surface,
    fontWeight: '700',
    fontSize: theme.font.body,
    marginLeft: theme.spacing.sm,
  },
  btnDisabled: { opacity: 0.5 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
  },
  addBtnText: {
    color: theme.colors.surface,
    fontWeight: '700',
    fontSize: theme.font.body,
    marginLeft: theme.spacing.sm,
  },
});

export default GroupDetailScreen;
