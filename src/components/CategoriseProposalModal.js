import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import { CATEGORIES } from '../storage';

const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

const FALLBACK_CATEGORY = { id: 'unknown', name: 'Unknown', color: theme.colors.textSubtle };
const categoryFor = (id) => CATEGORY_BY_ID[id] || FALLBACK_CATEGORY;

const groupSignature = (g) =>
  `${(g.categoryId || 'unknown').toLowerCase()}::${(g.name || '').trim().toLowerCase()}`;

const TABS = [
  { id: 'local', label: 'Local' },
  { id: 'sent', label: 'Sent to LLM' },
  { id: 'received', label: 'LLM reply' },
  { id: 'proposed', label: 'Proposed' },
];

const formatPct = (numer, denom) =>
  denom > 0 ? `${Math.round((numer / denom) * 100)}%` : '0%';

const formatBytes = (n) => {
  if (!n) return '0';
  if (n < 1024) return `${n} chars`;
  return `${(n / 1024).toFixed(1)}KB`;
};

/**
 * Modal shown immediately after the LLM returns a categorisation proposal,
 * BEFORE the proposal is committed to MMKV. Lets the user:
 *
 *   - Review the group skeleton (names + categories + member counts).
 *   - Remove any proposed group they don't want.
 *   - Add their own custom groups inline.
 *
 * Then they pick one of:
 *
 *   - "Looks good" — apply the (possibly edited) proposal in place. Stays on
 *     the current screen.
 *   - "Customise on Groups page" — apply the proposal, then bounce to the
 *     Groups page with a banner so the user can do deeper edits and trigger
 *     a fresh re-categorise that respects their final group list.
 *   - "Cancel" — discard the proposal; nothing is written.
 *
 * The actual storage write happens in the parent (`applyEditedProposal` on
 * `useRecategorise`). This component is purely the editor + confirmation
 * step.
 */
const CategoriseProposalModal = ({
  visible,
  proposal,
  onApply,
  onCustomise,
  onCancel,
  showCustomise = true,
}) => {
  // Set on the pending proposal by useRecategorise — drives the constrained
  // UI: no "add custom group" button, different "Proposed" subtitle. The
  // debug tabs (Local / Sent / LLM reply) render identically so the user
  // gets the same showcase regardless of mode.
  const allowNewGroups = proposal?.allowNewGroups !== false;
  // Local editable copy of the proposed groups. Reset every time the modal
  // opens so cancelled edits don't bleed into the next proposal.
  const [groups, setGroups] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addCategoryId, setAddCategoryId] = useState('friends');
  // Inspection tabs. Default to Local so the user lands on the pipeline
  // explanation before the proposed-groups editor.
  const [tabId, setTabId] = useState('local');
  const [expandedGroupId, setExpandedGroupId] = useState(null);
  const [showAllCards, setShowAllCards] = useState({});

  useEffect(() => {
    if (visible && proposal) {
      setGroups((proposal.groups || []).map((g) => ({ ...g })));
      setAddOpen(false);
      setAddName('');
      setAddCategoryId('friends');
      setTabId('local');
      setExpandedGroupId(null);
      setShowAllCards({});
    }
  }, [visible, proposal]);

  const trace = proposal?.trace;

  const originalSignatures = useMemo(
    () => new Set((proposal?.groups || []).map(groupSignature)),
    [proposal],
  );
  const editedSignatures = useMemo(
    () => new Set(groups.map(groupSignature)),
    [groups],
  );
  const isEdited = useMemo(() => {
    if (originalSignatures.size !== editedSignatures.size) return true;
    for (const sig of originalSignatures) if (!editedSignatures.has(sig)) return true;
    return false;
  }, [originalSignatures, editedSignatures]);

  const handleRemove = useCallback((index) => {
    setGroups((cur) => cur.filter((_, i) => i !== index));
  }, []);

  const handleAdd = useCallback(() => {
    const trimmed = addName.trim();
    if (!trimmed) return;
    const sig = `${addCategoryId.toLowerCase()}::${trimmed.toLowerCase()}`;
    setGroups((cur) => {
      if (cur.some((g) => groupSignature(g) === sig)) return cur;
      return [...cur, { name: trimmed, categoryId: addCategoryId, members: [] }];
    });
    setAddName('');
    setAddOpen(false);
  }, [addName, addCategoryId]);

  const totalMembers = useMemo(
    () => groups.reduce((acc, g) => acc + (g.members?.length || 0), 0),
    [groups],
  );

  if (!proposal) return null;

  const subtitleForTab = () => {
    if (tabId === 'local') {
      if (!trace) return 'No trace captured for this proposal.';
      const { totalContacts, locallyAssigned, llmBatchSize, manualLocked } = trace.local;
      const manualSuffix = manualLocked
        ? ` · ${manualLocked} manual ${manualLocked === 1 ? 'contact' : 'contacts'} skipped`
        : '';
      return `${locallyAssigned} of ${totalContacts} contacts (${formatPct(locallyAssigned, totalContacts)}) assigned locally · ${llmBatchSize} sent to LLM${manualSuffix}.`;
    }
    if (tabId === 'sent') {
      if (!trace || trace.llm.skipped) return 'No LLM call was made for this run.';
      return `${trace.llm.batchCount} ${trace.llm.batchCount === 1 ? 'batch' : 'batches'} sent to the model.`;
    }
    if (tabId === 'received') {
      if (!trace || trace.llm.skipped) return 'No LLM response — the model was skipped.';
      return `${trace.llm.totalTokens.toLocaleString()} tokens used · raw response below.`;
    }
    if (isEdited) {
      return `${groups.length} groups · ~${totalMembers} contacts tagged.`;
    }
    return allowNewGroups
      ? `${groups.length} groups · ~${totalMembers} contacts. Remove any you don't want or add your own.`
      : `Re-slotting ~${totalMembers} contacts into your ${groups.length} existing groups. Remove any assignment you don't want.`;
  };

  const renderLocalTab = () => {
    if (!trace) {
      return (
        <Text style={styles.emptyText}>
          No trace available (likely a cached proposal from before this view
          existed).
        </Text>
      );
    }
    const { groups: localGroups, legacyClusters } = trace.local;
    return (
      <>
        {localGroups.length === 0 ? (
          <Text style={styles.helperText}>
            Local heuristics didn't claim any contacts on their own this run.
            Everything went to the LLM.
          </Text>
        ) : (
          <>
            <Text style={styles.sectionTitle}>
              Local groups ({localGroups.length})
            </Text>
            {localGroups.map((g, idx) => {
              const cat = categoryFor(g.categoryId);
              const key = `local-${idx}`;
              const expanded = expandedGroupId === key;
              const count = g.memberNames?.length || 0;
              return (
                <TouchableOpacity
                  key={key}
                  style={styles.row}
                  onPress={() => setExpandedGroupId(expanded ? null : key)}
                  activeOpacity={0.7}
                >
                  <View style={[styles.dot, { backgroundColor: cat.color }]} />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>{g.name}</Text>
                    <Text style={styles.rowMeta}>
                      {cat.name} · {count} {count === 1 ? 'contact' : 'contacts'}
                    </Text>
                    {expanded ? (
                      <Text style={styles.memberList}>
                        {g.memberNames.join(', ')}
                      </Text>
                    ) : null}
                  </View>
                  <Icon
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color={theme.colors.textSubtle}
                  />
                </TouchableOpacity>
              );
            })}
          </>
        )}
        {legacyClusters?.length ? (
          <>
            <Text style={[styles.sectionTitle, { marginTop: theme.spacing.md }]}>
              Legacy heuristic hits (seeded to LLM)
            </Text>
            <Text style={styles.helperText}>
              Label-regex / surname matches. Used as hints in the LLM prompt,
              not committed directly.
            </Text>
            {legacyClusters.map((c, idx) => (
              <View key={`legacy-${idx}`} style={styles.compactRow}>
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: categoryFor(c.categoryId).color },
                  ]}
                />
                <Text style={styles.rowName}>{c.name}</Text>
                <Text style={styles.compactMeta}>{c.count}</Text>
              </View>
            ))}
          </>
        ) : null}
      </>
    );
  };

  const renderSentTab = () => {
    if (!trace) {
      return <Text style={styles.emptyText}>No trace available.</Text>;
    }
    if (trace.llm.skipped) {
      return (
        <Text style={styles.helperText}>
          The LLM was skipped this run
          {trace.llm.skipReason ? ` (${trace.llm.skipReason})` : ''}. The
          proposed groups came entirely from local heuristics.
        </Text>
      );
    }
    return (
      <>
        {trace.llm.batches.map((b) => {
          const showAll = !!showAllCards[b.index];
          const visibleCards = showAll ? b.contactCards : b.contactCards.slice(0, 15);
          const hidden = b.contactCards.length - visibleCards.length;
          return (
            <View key={`batch-${b.index}`} style={styles.batchBlock}>
              <Text style={styles.batchHeader}>
                Batch {b.index + 1} · {b.contactCount} contacts
              </Text>

              {b.seedClusters?.length ? (
                <>
                  <Text style={styles.subsectionTitle}>
                    Seed clusters in prompt ({b.seedClusters.length})
                  </Text>
                  {b.seedClusters.map((s, idx) => (
                    <View key={`seed-${b.index}-${idx}`} style={styles.compactRow}>
                      <View
                        style={[
                          styles.dot,
                          { backgroundColor: categoryFor(s.categoryId).color },
                        ]}
                      />
                      <Text style={styles.rowName} numberOfLines={1}>
                        {s.name}
                      </Text>
                      <Text style={styles.compactMeta}>
                        {s.members?.length || 0}
                      </Text>
                    </View>
                  ))}
                </>
              ) : null}

              <Text style={styles.subsectionTitle}>
                Contact cards ({b.contactCards.length})
              </Text>
              {visibleCards.map((c, idx) => (
                <View key={`card-${b.index}-${idx}`} style={styles.cardRow}>
                  <Text style={styles.cardName}>{c.name}</Text>
                  {c.hint ? (
                    <Text style={styles.cardHint} numberOfLines={2}>
                      {c.hint}
                    </Text>
                  ) : null}
                </View>
              ))}
              {hidden > 0 ? (
                <TouchableOpacity
                  onPress={() =>
                    setShowAllCards((cur) => ({ ...cur, [b.index]: true }))
                  }
                  style={styles.showMoreBtn}
                >
                  <Text style={styles.showMoreText}>Show {hidden} more</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}
      </>
    );
  };

  const renderReceivedTab = () => {
    if (!trace) {
      return <Text style={styles.emptyText}>No trace available.</Text>;
    }
    if (trace.llm.skipped) {
      return (
        <Text style={styles.helperText}>
          The LLM was skipped this run — there's nothing to show here.
        </Text>
      );
    }
    return (
      <>
        {trace.llm.batches.map((b) => {
          if (b.parseFailed) {
            return (
              <View key={`recv-${b.index}`} style={styles.batchBlock}>
                <Text style={styles.batchHeader}>
                  Batch {b.index + 1} · parse failed
                </Text>
                <Text style={styles.helperText}>
                  The model returned a response we couldn't parse as JSON. Raw
                  output ({formatBytes(b.rawResponseSize)}):
                </Text>
                <Text style={styles.rawBlock}>{b.rawResponse}</Text>
              </View>
            );
          }
          const parsed = b.parsedGroups || [];
          return (
            <View key={`recv-${b.index}`} style={styles.batchBlock}>
              <Text style={styles.batchHeader}>
                Batch {b.index + 1} · {parsed.length}{' '}
                {parsed.length === 1 ? 'group' : 'groups'} returned ·{' '}
                {formatBytes(b.rawResponseSize)}
              </Text>
              <Text style={styles.helperText}>
                Raw model output, before our suffix-stripping / dedup /
                hallucination-rejection / 10% threshold passes.
              </Text>
              {parsed.map((g, idx) => {
                const cat = categoryFor(g.categoryId);
                const key = `recv-${b.index}-${idx}`;
                const expanded = expandedGroupId === key;
                const count = g.memberNames?.length || 0;
                return (
                  <TouchableOpacity
                    key={key}
                    style={styles.row}
                    onPress={() => setExpandedGroupId(expanded ? null : key)}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.dot, { backgroundColor: cat.color }]} />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {g.name || '(unnamed)'}
                      </Text>
                      <Text style={styles.rowMeta}>
                        {cat.name} · {count} {count === 1 ? 'contact' : 'contacts'}
                      </Text>
                      {Array.isArray(g.cueTokens) && g.cueTokens.length ? (
                        <Text style={styles.cueLine}>
                          cues: {g.cueTokens.join(', ')}
                        </Text>
                      ) : null}
                      {expanded ? (
                        <Text style={styles.memberList}>
                          {g.memberNames.join(', ')}
                        </Text>
                      ) : null}
                    </View>
                    <Icon
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={18}
                      color={theme.colors.textSubtle}
                    />
                  </TouchableOpacity>
                );
              })}
            </View>
          );
        })}
      </>
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Categorisation review</Text>
          <Text style={styles.subtitle}>{subtitleForTab()}</Text>

          <View style={styles.tabBar}>
            {TABS.map((t) => (
              <TouchableOpacity
                key={t.id}
                onPress={() => setTabId(t.id)}
                style={[styles.tabBtn, t.id === tabId && styles.tabBtnActive]}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.tabText,
                    t.id === tabId && styles.tabTextActive,
                  ]}
                  numberOfLines={1}
                >
                  {t.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <ScrollView
            style={styles.list}
            contentContainerStyle={{ paddingBottom: theme.spacing.sm }}
            keyboardShouldPersistTaps="handled"
          >
            {tabId === 'local' ? renderLocalTab() : null}
            {tabId === 'sent' ? renderSentTab() : null}
            {tabId === 'received' ? renderReceivedTab() : null}
            {tabId !== 'proposed' ? null : (
            <>
            {groups.length === 0 ? (
              <Text style={styles.emptyText}>
                No groups left. Add at least one below, or cancel.
              </Text>
            ) : null}
            {(() => {
              // Render groups sectioned by category. Each group keeps its
              // original index in `groups` so the remove button still
              // targets the right entry after sectioning.
              const indexed = groups.map((g, idx) => ({ g, idx }));
              const sections = CATEGORIES.map((cat) => ({
                cat,
                items: indexed.filter(({ g }) => (g.categoryId || 'unknown') === cat.id),
              }))
                .concat([
                  {
                    cat: FALLBACK_CATEGORY,
                    items: indexed.filter(
                      ({ g }) => !CATEGORY_BY_ID[g.categoryId || 'unknown'],
                    ),
                  },
                ])
                .filter((s) => s.items.length);

              return sections.map(({ cat, items }) => {
                const totalInCat = items.reduce(
                  (acc, { g }) => acc + (g.members?.length || 0),
                  0,
                );
                // Skip the section header when there's only one group in
                // this category — the group name (e.g. "Family", "Helpers")
                // already conveys the category, and the row's coloured dot
                // gives the same visual cue. Headers add value only when
                // they're grouping multiple distinct entries (e.g. several
                // Office – X groups).
                const showHeader = items.length > 1;
                return (
                  <View key={cat.id}>
                    {showHeader ? (
                      <View style={styles.sectionHeader}>
                        <View style={[styles.sectionDot, { backgroundColor: cat.color }]} />
                        <Text style={styles.sectionTitle}>{cat.name}</Text>
                        <Text style={styles.sectionMeta}>
                          {items.length} groups · {totalInCat}{' '}
                          {totalInCat === 1 ? 'contact' : 'contacts'}
                        </Text>
                      </View>
                    ) : null}
                    {items.map(({ g, idx }) => {
                      const count = g.members?.length || 0;
                      return (
                        <View key={`${groupSignature(g)}-${idx}`} style={styles.row}>
                          <View style={[styles.dot, { backgroundColor: cat.color }]} />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.rowName} numberOfLines={1}>
                              {g.name}
                            </Text>
                            <Text style={styles.rowMeta}>
                              {count} {count === 1 ? 'contact' : 'contacts'}
                            </Text>
                          </View>
                          <TouchableOpacity
                            style={styles.removeBtn}
                            onPress={() => handleRemove(idx)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Icon name="close" size={18} color={theme.colors.textMuted} />
                          </TouchableOpacity>
                        </View>
                      );
                    })}
                  </View>
                );
              });
            })()}

            {!allowNewGroups ? null : addOpen ? (
              <View style={styles.addForm}>
                <TextInput
                  style={styles.input}
                  value={addName}
                  onChangeText={setAddName}
                  placeholder="e.g. Book club, IITB, Investors"
                  placeholderTextColor={theme.colors.textSubtle}
                  autoFocus
                />
                <View style={styles.categoryRow}>
                  {CATEGORIES.map((cat) => (
                    <TouchableOpacity
                      key={cat.id}
                      onPress={() => setAddCategoryId(cat.id)}
                      style={[
                        styles.categoryChip,
                        cat.id === addCategoryId && {
                          backgroundColor: cat.color,
                          borderColor: cat.color,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.categoryChipText,
                          cat.id === addCategoryId && { color: theme.colors.surface },
                        ]}
                      >
                        {cat.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.addBtnRow}>
                  <TouchableOpacity
                    style={[styles.smallBtn, styles.smallBtnSecondary]}
                    onPress={() => {
                      setAddOpen(false);
                      setAddName('');
                    }}
                  >
                    <Text style={styles.smallBtnSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.smallBtn,
                      styles.smallBtnPrimary,
                      !addName.trim() && styles.btnDisabled,
                    ]}
                    onPress={handleAdd}
                    disabled={!addName.trim()}
                  >
                    <Text style={styles.smallBtnPrimaryText}>Add</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.addRow}
                onPress={() => setAddOpen(true)}
              >
                <Icon name="plus-circle-outline" size={18} color={theme.colors.primary} />
                <Text style={styles.addRowText}>Add a custom group</Text>
              </TouchableOpacity>
            )}
            </>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.footerBtn, styles.btnGhost]}
              onPress={onCancel}
            >
              <Text style={styles.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            {showCustomise ? (
              <TouchableOpacity
                style={[styles.footerBtn, styles.btnSecondary]}
                onPress={() => onCustomise?.(groups)}
              >
                <Text style={styles.btnSecondaryText}>Customise on Groups</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[
                styles.footerBtn,
                styles.btnPrimary,
                groups.length === 0 && styles.btnDisabled,
              ]}
              onPress={() => onApply?.(groups, { isEdited, allowNewGroups })}
              disabled={groups.length === 0}
            >
              <Text style={styles.btnPrimaryText}>
                {isEdited ? 'Apply edits' : 'Looks good'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 460,
    maxHeight: '88%',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  title: {
    fontSize: theme.font.h2,
    fontWeight: '700',
    color: theme.colors.text,
  },
  subtitle: {
    marginTop: 4,
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    lineHeight: 18,
  },
  list: {
    marginTop: theme.spacing.md,
    maxHeight: 420,
  },
  tabBar: {
    flexDirection: 'row',
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.pill,
    padding: 3,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBtnActive: {
    backgroundColor: theme.colors.primary,
  },
  tabText: {
    fontSize: theme.font.tiny,
    fontWeight: '600',
    color: theme.colors.textMuted,
  },
  tabTextActive: {
    color: theme.colors.surface,
  },
  subsectionTitle: {
    fontSize: theme.font.tiny,
    fontWeight: '700',
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: theme.spacing.sm,
    marginBottom: 4,
  },
  helperText: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
    fontStyle: 'italic',
    lineHeight: 16,
    marginBottom: theme.spacing.xs,
  },
  rowBody: {
    flex: 1,
  },
  memberList: {
    marginTop: 4,
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    lineHeight: 16,
  },
  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: theme.spacing.xs,
  },
  compactMeta: {
    marginLeft: theme.spacing.sm,
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
    fontWeight: '600',
  },
  batchBlock: {
    marginBottom: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  batchHeader: {
    fontSize: theme.font.small,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 2,
  },
  cardRow: {
    paddingVertical: 4,
    paddingHorizontal: theme.spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  cardName: {
    fontSize: theme.font.small,
    color: theme.colors.text,
    fontWeight: '500',
  },
  cardHint: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    marginTop: 2,
    lineHeight: 14,
  },
  showMoreBtn: {
    paddingVertical: theme.spacing.xs,
    alignItems: 'center',
  },
  showMoreText: {
    fontSize: theme.font.tiny,
    color: theme.colors.primary,
    fontWeight: '600',
  },
  rawBlock: {
    fontSize: theme.font.tiny,
    color: theme.colors.text,
    fontFamily: 'Courier',
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    marginTop: theme.spacing.xs,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: theme.spacing.sm,
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
    fontSize: theme.font.tiny,
    fontWeight: '700',
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  sectionMeta: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    marginBottom: theme.spacing.xs,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: theme.spacing.sm,
  },
  rowName: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
  },
  rowMeta: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  cueLine: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
    fontStyle: 'italic',
    marginTop: 2,
  },
  removeBtn: {
    padding: 4,
  },
  emptyText: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    fontStyle: 'italic',
    paddingVertical: theme.spacing.md,
    textAlign: 'center',
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderStyle: 'dashed',
    borderRadius: theme.radius.sm,
    marginTop: theme.spacing.xs,
  },
  addRowText: {
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: theme.font.small,
    marginLeft: 6,
  },
  addForm: {
    marginTop: theme.spacing.xs,
    padding: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
  },
  input: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
    fontSize: theme.font.body,
    color: theme.colors.text,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: theme.spacing.sm,
  },
  categoryChip: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginRight: 6,
    marginBottom: 6,
  },
  categoryChipText: {
    fontSize: theme.font.tiny,
    fontWeight: '600',
    color: theme.colors.textMuted,
  },
  addBtnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: theme.spacing.sm,
  },
  smallBtn: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    marginLeft: theme.spacing.sm,
  },
  smallBtnPrimary: { backgroundColor: theme.colors.primary },
  smallBtnPrimaryText: {
    color: theme.colors.surface,
    fontWeight: '700',
    fontSize: theme.font.small,
  },
  smallBtnSecondary: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  smallBtnSecondaryText: {
    color: theme.colors.textMuted,
    fontWeight: '600',
    fontSize: theme.font.small,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: theme.spacing.lg,
    flexWrap: 'wrap',
  },
  footerBtn: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    marginLeft: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  btnPrimary: { backgroundColor: theme.colors.primary },
  btnPrimaryText: {
    color: theme.colors.surface,
    fontWeight: '700',
    fontSize: theme.font.small,
  },
  btnSecondary: {
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  btnSecondaryText: {
    color: theme.colors.text,
    fontWeight: '600',
    fontSize: theme.font.small,
  },
  btnGhost: { backgroundColor: 'transparent' },
  btnGhostText: {
    color: theme.colors.textMuted,
    fontWeight: '600',
    fontSize: theme.font.small,
  },
  btnDisabled: { opacity: 0.5 },
});

export default CategoriseProposalModal;
