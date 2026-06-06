import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useFocusEffect } from '@react-navigation/native';
import theme from '../theme';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import ConnectSetupGate from '../components/ConnectSetupGate';
import {
  addGroup,
  CATEGORIES,
  CATEGORY_ID,
  deleteGroup,
  getDisplayGroups,
  getGroups,
  getLastCategorizedAt,
  getUnknownGroupCount,
  getContactGroupMap,
  hasLlmKey,
  renameGroup,
  setGroupCategory,
  setGroupDoNotRemind,
  UNKNOWN_GROUP_ID,
} from '../storage';
import LlmKeyModal from '../components/LlmKeyModal';
import CategoriseProposalModal from '../components/CategoriseProposalModal';
import { useRecategorise } from '../hooks/useRecategorise';

const COLOR_CHOICES = [
  '#2F6F8F', '#E07856', '#C98A2E', '#3C9D6A',
  '#5E35B1', '#B0463C', '#1F4F6B', '#8C6F32',
];

const GroupsScreen = ({ navigation, route }) => {
  // Bump on every mutation so we re-read from MMKV without needing a store.
  const [bump, setBump] = useState(0);
  // Set on arrival from the propose-modal "Customise on Groups" path. While
  // truthy, we show a banner inviting the user to adjust groups and tap
  // Re-categorize. Clears the moment they tap it.
  const [customiseMode, setCustomiseMode] = useState(false);
  // Includes the synthetic Unknown group at the end — it auto-collects every
  // contact not assigned to any user-defined group.
  const groups = useMemo(() => getDisplayGroups(), [bump]);
  // The re-categorise card is shown only before the user has ever run
  // categorisation. After the first run, the equivalent action moves to
  // Settings → AI categorisation so this screen stays focused on the groups
  // themselves.
  const hasCategorised = useMemo(() => getLastCategorizedAt() > 0, [bump]);
  const memberCounts = useMemo(() => {
    const counts = {};
    Object.values(getContactGroupMap()).forEach((ids) => {
      (ids || []).forEach((id) => {
        counts[id] = (counts[id] || 0) + 1;
      });
    });
    // Synthetic Unknown count uses the same "valid groupIds only" rule as
    // storage so stale memberships from deleted groups don't shrink it.
    counts[UNKNOWN_GROUP_ID] = getUnknownGroupCount();
    return counts;
  }, [bump]);

  // Member counts (and the group list itself) are derived from MMKV and only
  // recomputed when `bump` changes. Tagging a contact into a group happens on
  // the contact detail screen, which writes to MMKV without touching `bump`
  // here — so re-read on focus, otherwise the counts stay stale (e.g. 0) after
  // returning to this tab.
  useFocusEffect(
    useCallback(() => {
      setBump((b) => b + 1);
    }, []),
  );

  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLOR_CHOICES[0]);
  const [categoryId, setCategoryId] = useState(CATEGORY_ID.FRIENDS);
  // Rename modal state. Android lacks Alert.prompt, so a tiny custom modal
  // gives us cross-platform parity instead of silently no-op'ing on Android.
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  // Re-read the groups list every time a categorisation run finishes so any
  // newly-persisted groups appear without a manual refresh. Settings doesn't
  // need this because it doesn't render the group list.
  const bumpAfterRun = useCallback(() => setBump((b) => b + 1), []);
  const {
    categorising,
    categoriseProgress,
    startCategorise,
    pendingProposal,
    applyEditedProposal,
    dismissProposal,
    llmPromptOpen,
    setLlmPromptOpen,
    llmPromptError,
    setLlmPromptError,
  } = useRecategorise({ onComplete: bumpAfterRun });

  // Arriving here via the propose modal's "Customise on Groups" button.
  // Surface a banner with a visible Re-categorize button until the user
  // either taps it or navigates away.
  useEffect(() => {
    if (route?.params?.customiseAfterPropose) {
      setCustomiseMode(true);
      // Clear the param so back-nav + revisits don't keep re-triggering.
      navigation.setParams?.({ customiseAfterPropose: undefined });
    }
  }, [route?.params?.customiseAfterPropose, navigation]);

  const onCreate = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    addGroup(trimmed, color, categoryId);
    setName('');
    setColor(COLOR_CHOICES[0]);
    setCategoryId(CATEGORY_ID.FRIENDS);
    setNewOpen(false);
    setBump((b) => b + 1);
  }, [name, color, categoryId]);

  const onRename = useCallback((group) => {
    setRenameTarget(group);
    setRenameValue(group.name);
  }, []);

  const onRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim();
    if (renameTarget && trimmed) {
      renameGroup(renameTarget.id, trimmed);
      setBump((b) => b + 1);
    }
    setRenameTarget(null);
    setRenameValue('');
  }, [renameTarget, renameValue]);

  const onMoveCategory = useCallback((group) => {
    Alert.alert(
      'Move to category',
      `Move "${group.name}" to which category?`,
      [
        ...CATEGORIES.map((cat) => ({
          text: cat.name + (cat.id === group.categoryId ? ' (current)' : ''),
          onPress: () => {
            if (cat.id === group.categoryId) return;
            setGroupCategory(group.id, cat.id);
            setBump((b) => b + 1);
          },
        })),
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, []);

  const onDelete = useCallback((group) => {
    Alert.alert(
      'Delete group',
      `Delete "${group.name}"? Members are not deleted, only the group label is removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteGroup(group.id);
            setBump((b) => b + 1);
          },
        },
      ],
    );
  }, []);

  const onToggleDoNotRemind = useCallback((group) => {
    setGroupDoNotRemind(group.id, !group.doNotRemind);
    setBump((b) => b + 1);
  }, []);

  const onRecategorise = useCallback(() => {
    if (!hasLlmKey()) {
      setLlmPromptOpen(true);
      return;
    }
    // If the user has already curated groups (manually or via a prior
    // partial run), give them the same choice as Settings: let the LLM
    // propose new groups, or strictly slot contacts into the existing
    // list. Both branches now go through the proposal modal so the user
    // gets the same debug showcase either way.
    if (getGroups().length > 0) {
      Alert.alert(
        'Re-categorise contacts',
        'You already have groups. Should the LLM be allowed to propose new ones, or only re-tag contacts into your existing groups?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Only existing groups',
            onPress: () => startCategorise({ allowNewGroups: false }),
          },
          {
            text: 'Allow new groups',
            onPress: () => startCategorise({ allowNewGroups: true }),
          },
        ],
      );
      return;
    }
    startCategorise({ allowNewGroups: true });
  }, [startCategorise, setLlmPromptOpen]);

  // Banner Re-categorize: the user has already curated their groups on
  // this page and is ready to slot contacts into them. Runs in constrained
  // mode (allowNewGroups: false). Routed through the same propose+review
  // pipeline as everything else so the debug tabs are available — if the
  // user just wants to apply, they hit "Looks good" once.
  const onBannerRecategorise = useCallback(() => {
    setCustomiseMode(false);
    startCategorise({ allowNewGroups: false });
  }, [startCategorise]);

  const onApplyProposal = useCallback(
    (editedGroups, { isEdited, allowNewGroups } = {}) => {
      applyEditedProposal(editedGroups, { mode: 'apply' });
      // When the user changed the group skeleton during an unconstrained
      // run, immediately re-run in constrained mode so the LLM re-slots
      // contacts into the freshly-saved (edited) group list.
      if (isEdited && allowNewGroups) {
        startCategorise({ allowNewGroups: false });
      }
    },
    [applyEditedProposal, startCategorise],
  );

  const onCustomiseProposal = useCallback((editedGroups) => {
    applyEditedProposal(editedGroups, { mode: 'customise' });
    setCustomiseMode(true);
  }, [applyEditedProposal]);

  // SectionList sections are the hardcoded categories, with the groups in
  // each as the section data. Empty categories stay visible so the user
  // sees the full taxonomy.
  const sections = useMemo(
    () =>
      CATEGORIES.map((cat) => ({
        category: cat,
        title: cat.name,
        data: groups.filter((g) => g.categoryId === cat.id),
      })),
    [groups],
  );

  return (
    <View style={styles.container}>
      <AppHeader
        title="Groups"
        subtitle="How you organise the people that matter"
        onBack={() => navigation.goBack()}
        rightElement={
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.headerIconBtn}
              onPress={() => navigation.navigate('ConnectBulkCategorise')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Icon name="magnify" size={20} color={theme.colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.headerNewBtn}
              onPress={() => setNewOpen(true)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Icon name="plus" size={16} color={theme.colors.primary} />
              <Text style={styles.headerNewBtnText}>New</Text>
            </TouchableOpacity>
          </View>
        }
      />

      <ConnectSetupGate>
        {customiseMode ? (
          <View style={[styles.recategoriseRow, styles.customiseBanner]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.recategoriseTitle}>Make changes to groups</Text>
              <Text style={styles.recategoriseBody}>
                {categoriseProgress
                  ? `Batch ${categoriseProgress.batchIndex}/${categoriseProgress.batchCount}` +
                    (categoriseProgress.tokens
                      ? ` · ${categoriseProgress.tokens.toLocaleString()} tokens`
                      : '')
                  : 'Rename, delete, or add groups below. When you’re happy, re-categorise to slot contacts into your final list.'}
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.recategoriseBtn, categorising && styles.btnDisabled]}
              onPress={onBannerRecategorise}
              disabled={categorising}
            >
              {categorising ? (
                <ActivityIndicator color={theme.colors.surface} size="small" />
              ) : (
                <>
                  <Icon name="refresh" size={16} color={theme.colors.surface} />
                  <Text style={styles.recategoriseBtnText}>Re-categorize</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : null}
        {!customiseMode && !hasCategorised ? (
          <View style={styles.recategoriseRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.recategoriseTitle}>
                {hasLlmKey() ? 'AI categorisation' : 'Auto-categorise'}
              </Text>
              <Text style={styles.recategoriseBody}>
                {categoriseProgress
                  ? `Batch ${categoriseProgress.batchIndex}/${categoriseProgress.batchCount}` +
                    (categoriseProgress.tokens
                      ? ` · ${categoriseProgress.tokens.toLocaleString()} tokens`
                      : '')
                  : hasLlmKey()
                  ? 'Run the LLM once to seed your contact groups. You can re-run it later from Settings.'
                  : 'Add an LLM key for accurate grouping.'}
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.recategoriseBtn, categorising && styles.btnDisabled]}
              onPress={onRecategorise}
              disabled={categorising}
            >
              {categorising ? (
                <ActivityIndicator color={theme.colors.surface} size="small" />
              ) : (
                <>
                  <Icon name="creation" size={16} color={theme.colors.surface} />
                  <Text style={styles.recategoriseBtnText}>Categorise</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : null}

        <SectionList
          sections={sections}
          keyExtractor={(g) => g.id}
          contentContainerStyle={{
            paddingTop: theme.spacing.md,
            paddingBottom: theme.spacing.xxl,
          }}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionDot, { backgroundColor: section.category.color }]} />
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionCount}>
                {section.data.length} group{section.data.length === 1 ? '' : 's'}
              </Text>
            </View>
          )}
          renderItem={({ item }) => {
            // Helpers category is always silenced — the toggle becomes a
            // non-interactive indicator so the user can see why the group
            // doesn't trigger reminders.
            const helpersForced = item.categoryId === 'helpers';
            const muted = helpersForced || item.doNotRemind;
            return (
              <TouchableOpacity
                style={styles.row}
                onPress={() =>
                  navigation.navigate('ConnectGroupDetail', { groupId: item.id })
                }
                onLongPress={item.synthetic ? undefined : () => onRename(item)}
                activeOpacity={0.85}
              >
                <View style={[styles.dot, { backgroundColor: item.color }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.count}>
                    {memberCounts[item.id] || 0} contact
                    {(memberCounts[item.id] || 0) === 1 ? '' : 's'}
                    {item.synthetic ? ' • auto' : ''}
                    {muted ? ' • muted' : ''}
                  </Text>
                </View>
                {item.synthetic ? null : (
                  <>
                    <TouchableOpacity
                      onPress={helpersForced ? undefined : () => onToggleDoNotRemind(item)}
                      disabled={helpersForced}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={styles.iconBtn}
                    >
                      <Icon
                        name={muted ? 'bell-off' : 'bell-outline'}
                        size={20}
                        color={
                          muted ? theme.colors.accent : theme.colors.textSubtle
                        }
                      />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => onMoveCategory(item)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={styles.iconBtn}
                    >
                      <Icon name="folder-move-outline" size={20} color={theme.colors.textSubtle} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => onDelete(item)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={styles.iconBtn}
                    >
                      <Icon name="trash-can-outline" size={20} color={theme.colors.textSubtle} />
                    </TouchableOpacity>
                  </>
                )}
              </TouchableOpacity>
            );
          }}
          renderSectionFooter={({ section }) =>
            section.data.length === 0 ? (
              <Text style={styles.emptySection}>
                No groups in this category yet.
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="folder-account-outline"
              title="No groups yet"
              body="Create groups like Family, Mentors, Investors so you can keep them close."
              actionLabel="Create a group"
              onActionPress={() => setNewOpen(true)}
            />
          }
        />
      </ConnectSetupGate>

      <Modal
        visible={newOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setNewOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New group</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Investors, IITB, Family"
              placeholderTextColor={theme.colors.textSubtle}
              autoFocus
            />

            <Text style={styles.modalSubLabel}>Category</Text>
            <View style={styles.colorRow}>
              {CATEGORIES.map((cat) => (
                <TouchableOpacity
                  key={cat.id}
                  onPress={() => setCategoryId(cat.id)}
                  style={[
                    styles.categoryChip,
                    cat.id === categoryId && {
                      backgroundColor: cat.color,
                      borderColor: cat.color,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.categoryChipText,
                      cat.id === categoryId && { color: theme.colors.surface },
                    ]}
                  >
                    {cat.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.modalSubLabel}>Colour</Text>
            <View style={styles.colorRow}>
              {COLOR_CHOICES.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[
                    styles.colorChip,
                    { backgroundColor: c },
                    c === color && styles.colorChipSelected,
                  ]}
                  onPress={() => setColor(c)}
                />
              ))}
            </View>
            <View style={styles.modalBtnRow}>
              <TouchableOpacity
                onPress={() => setNewOpen(false)}
                style={[styles.modalBtn, styles.modalBtnSecondary]}
              >
                <Text style={styles.modalBtnSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onCreate}
                style={[styles.modalBtn, styles.modalBtnPrimary]}
              >
                <Text style={styles.modalBtnPrimaryText}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!renameTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameTarget(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename group</Text>
            <TextInput
              style={styles.input}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="Group name"
              placeholderTextColor={theme.colors.textSubtle}
              autoFocus
            />
            <View style={styles.modalBtnRow}>
              <TouchableOpacity
                onPress={() => setRenameTarget(null)}
                style={[styles.modalBtn, styles.modalBtnSecondary]}
              >
                <Text style={styles.modalBtnSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onRenameSubmit}
                style={[styles.modalBtn, styles.modalBtnPrimary]}
              >
                <Text style={styles.modalBtnPrimaryText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <LlmKeyModal
        visible={llmPromptOpen}
        onClose={() => {
          setLlmPromptOpen(false);
          setLlmPromptError(null);
          setBump((b) => b + 1);
        }}
        title={
          llmPromptError ? 'LLM key was rejected' : 'Add an LLM key to categorise'
        }
        body="The first-pass grouping uses an LLM for quality."
        errorMessage={llmPromptError}
        onSaved={() => {
          setLlmPromptError(null);
          setBump((b) => b + 1);
          startCategorise({ allowNewGroups: true });
        }}
        onUseLocal={() => {
          setLlmPromptError(null);
          startCategorise({ allowNewGroups: true, useLocal: true });
        }}
        useLocalLabel="Use local heuristics anyway"
      />

      <CategoriseProposalModal
        visible={!!pendingProposal}
        proposal={pendingProposal}
        onApply={onApplyProposal}
        onCustomise={onCustomiseProposal}
        onCancel={dismissProposal}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  recategoriseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  customiseBanner: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.sm,
  },
  headerNewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
  },
  headerNewBtnText: {
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: theme.font.small,
    marginLeft: 4,
  },
  recategoriseTitle: {
    fontSize: theme.font.body,
    fontWeight: '700',
    color: theme.colors.text,
  },
  recategoriseBody: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    marginTop: 2,
    lineHeight: 16,
  },
  recategoriseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    marginLeft: theme.spacing.md,
  },
  recategoriseBtnText: {
    color: theme.colors.surface,
    fontWeight: '700',
    fontSize: theme.font.small,
    marginLeft: 4,
  },
  btnDisabled: { opacity: 0.6 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.lg,
    marginBottom: theme.spacing.xs,
  },
  sectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: theme.spacing.sm,
  },
  sectionTitle: {
    flex: 1,
    fontSize: theme.font.small,
    fontWeight: '700',
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  sectionCount: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
  },
  emptySection: {
    marginHorizontal: theme.spacing.lg,
    marginTop: 2,
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
    fontStyle: 'italic',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: theme.spacing.md,
  },
  name: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
  },
  count: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  iconBtn: { marginLeft: theme.spacing.md },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  },
  modalCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
  },
  modalTitle: {
    fontSize: theme.font.h3,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.md,
  },
  modalSubLabel: {
    fontSize: theme.font.tiny,
    fontWeight: '700',
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    fontSize: theme.font.body,
    color: theme.colors.text,
  },
  colorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  categoryChip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginRight: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  categoryChipText: {
    fontSize: theme.font.small,
    color: theme.colors.text,
    fontWeight: '600',
  },
  colorChip: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginRight: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorChipSelected: {
    borderColor: theme.colors.text,
  },
  modalBtnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: theme.spacing.md,
  },
  modalBtn: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    marginLeft: theme.spacing.sm,
  },
  modalBtnPrimary: { backgroundColor: theme.colors.primary },
  modalBtnSecondary: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  modalBtnPrimaryText: { color: theme.colors.surface, fontWeight: '700' },
  modalBtnSecondaryText: { color: theme.colors.textMuted, fontWeight: '600' },
});

export default GroupsScreen;
