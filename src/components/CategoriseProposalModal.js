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

// True for the anonymous name-token seeds named "Cluster: <token>". Label /
// partition groups (Friends, Helpers, Office – X) never carry this prefix.
const isBareCluster = (name) => /^Cluster: /.test(name || '');

// Display order shared by the Local and "Sent to LLM" screens: named label /
// group seeds stay on top (in their incoming order), then the bare
// "Cluster: <token>" seeds, biggest first. `count` reads the member count off
// whichever shape the caller has (.members array vs a precomputed .count).
const labelsUpClustersDown = (count) => (x, y) => {
  const bx = isBareCluster(x.name);
  const by = isBareCluster(y.name);
  if (bx !== by) return bx ? 1 : -1;
  if (!bx) return 0;
  return count(y) - count(x);
};

const TABS = [
  { id: 'local', label: 'Local' },
  { id: 'sent', label: 'Sent to LLM' },
  { id: 'received', label: 'LLM reply' },
  { id: 'transform', label: 'Transform' },
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
 *   - Tap a proposed group to expand its member contact names.
 *   - Merge one proposed group into another (combines members, drops source).
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
  // Index of the proposed group the user is merging FROM. While non-null the
  // Proposed tab switches into "pick a target" mode: every other group row
  // becomes a merge target and editing (remove / add) is paused.
  const [mergeSourceIdx, setMergeSourceIdx] = useState(null);
  // Undo stack of prior `groups` snapshots. Every edit (merge / remove / add)
  // pushes the pre-change array here so a mistaken merge can be reverted.
  const [history, setHistory] = useState([]);
  // Local-tab contact search: type a name to see which local group(s) /
  // cluster(s) that contact was assigned to.
  const [localSearch, setLocalSearch] = useState('');

  useEffect(() => {
    if (visible && proposal) {
      setGroups((proposal.groups || []).map((g) => ({ ...g })));
      setAddOpen(false);
      setAddName('');
      setAddCategoryId('friends');
      setTabId('local');
      setExpandedGroupId(null);
      setShowAllCards({});
      setLocalSearch('');
      setMergeSourceIdx(null);
      setHistory([]);
    }
  }, [visible, proposal]);

  const trace = proposal?.trace;
  // Phone → name lookup so a proposed group's phone-keyed members can be
  // shown as contact names when the user taps to expand it.
  const nameByPhone = useMemo(() => proposal?.nameByPhone || {}, [proposal]);
  const memberNamesOf = useCallback(
    (g) =>
      (g?.members || [])
        .map((p) => nameByPhone[p] || p)
        .sort((a, b) => String(a).localeCompare(String(b))),
    [nameByPhone],
  );

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

  // Snapshot the current groups onto the undo stack before a mutation. Reads
  // `groups` from the closure (not a functional updater) so the same array we
  // record is the one we transform — keeps undo and the edit in lockstep, and
  // avoids double-pushing under React's dev-mode double-invoked updaters.
  const pushHistory = useCallback(() => {
    setHistory((h) => [...h, groups]);
  }, [groups]);

  const handleRemove = useCallback((index) => {
    setExpandedGroupId(null);
    pushHistory();
    setGroups(groups.filter((_, i) => i !== index));
  }, [groups, pushHistory]);

  // Merge the source group's members into the target group (dedup by phone),
  // keep the target's name + category, and drop the source group. Map first,
  // then filter, so `targetIdx` still points at the right entry while we
  // build the merged member list.
  const handleMerge = useCallback((sourceIdx, targetIdx) => {
    setExpandedGroupId(null);
    setMergeSourceIdx(null);
    if (sourceIdx === targetIdx) return;
    const src = groups[sourceIdx];
    const tgt = groups[targetIdx];
    if (!src || !tgt) return;
    const mergedMembers = [
      ...new Set([...(tgt.members || []), ...(src.members || [])]),
    ];
    pushHistory();
    setGroups(
      groups
        .map((g, i) => (i === targetIdx ? { ...g, members: mergedMembers } : g))
        .filter((_, i) => i !== sourceIdx),
    );
  }, [groups, pushHistory]);

  const handleAdd = useCallback(() => {
    const trimmed = addName.trim();
    if (!trimmed) return;
    const sig = `${addCategoryId.toLowerCase()}::${trimmed.toLowerCase()}`;
    if (!groups.some((g) => groupSignature(g) === sig)) {
      pushHistory();
      setGroups([...groups, { name: trimmed, categoryId: addCategoryId, members: [] }]);
    }
    setAddName('');
    setAddOpen(false);
  }, [addName, addCategoryId, groups, pushHistory]);

  // Revert the most recent edit (merge / remove / add).
  const handleUndo = useCallback(() => {
    if (!history.length) return;
    setExpandedGroupId(null);
    setMergeSourceIdx(null);
    setGroups(history[history.length - 1]);
    setHistory(history.slice(0, -1));
  }, [history]);

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
    if (tabId === 'transform') {
      const steps = trace?.transforms || [];
      if (!steps.length) {
        return 'How each group became a proposed group.';
      }
      const dropped = steps.filter((s) => s.toName == null).length;
      const droppedSuffix = dropped
        ? ` · ${dropped} dropped`
        : '';
      return `${steps.length} ${steps.length === 1 ? 'group' : 'groups'} reshaped into ${groups.length} proposed${droppedSuffix}.`;
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

    // Search across every locally-assigned group AND legacy cluster, keyed by
    // contact name, so one matching contact shows all the clusters it landed
    // in (a name can match a label cluster and a name-token cluster at once).
    const query = localSearch.trim().toLowerCase();
    const searchResults = (() => {
      if (!query) return null;
      const byContact = new Map();
      const collect = (clusterName, memberNames) => {
        (memberNames || []).forEach((nm) => {
          if (!nm.toLowerCase().includes(query)) return;
          if (!byContact.has(nm)) byContact.set(nm, new Set());
          byContact.get(nm).add(clusterName);
        });
      };
      localGroups.forEach((g) => collect(g.name, g.memberNames));
      (legacyClusters || []).forEach((c) => collect(c.name, c.memberNames));
      return [...byContact.entries()]
        .map(([name, clusters]) => ({ name, clusters: [...clusters] }))
        .sort((a, b) => a.name.localeCompare(b.name));
    })();

    return (
      <>
        <View style={styles.searchRow}>
          <Icon name="magnify" size={18} color={theme.colors.textSubtle} />
          <TextInput
            style={styles.searchInput}
            value={localSearch}
            onChangeText={setLocalSearch}
            placeholder="Search a contact to see its cluster"
            placeholderTextColor={theme.colors.textSubtle}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {localSearch ? (
            <TouchableOpacity onPress={() => setLocalSearch('')} hitSlop={8}>
              <Icon name="close" size={18} color={theme.colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>

        {searchResults ? (
          searchResults.length === 0 ? (
            <Text style={styles.emptyText}>
              No locally-clustered contact matches “{localSearch.trim()}”. It may
              have gone straight to the LLM batch (check the “Sent to LLM” tab).
            </Text>
          ) : (
            <>
              <Text style={styles.helperText}>
                {searchResults.length}{' '}
                {searchResults.length === 1 ? 'contact' : 'contacts'} matched.
              </Text>
              {searchResults.map((r, idx) => (
                <View key={`search-${idx}`} style={styles.row}>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
                    <Text style={styles.memberList}>
                      {r.clusters.join('  •  ')}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          )
        ) : (
          renderLocalLists(localGroups, legacyClusters)
        )}
      </>
    );
  };

  const renderLocalLists = (localGroups, legacyClusters) => {
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
            {[...legacyClusters]
              .sort(labelsUpClustersDown((c) => c.count || 0))
              .map((c, idx) => {
              const key = `legacy-${idx}`;
              const expanded = expandedGroupId === key;
              const names = c.memberNames || [];
              return (
                <TouchableOpacity
                  key={key}
                  style={styles.compactRow}
                  onPress={() => setExpandedGroupId(expanded ? null : key)}
                  activeOpacity={0.7}
                >
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: categoryFor(c.categoryId).color },
                    ]}
                  />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>{c.name}</Text>
                    {expanded && names.length ? (
                      <Text style={styles.memberList}>{names.join(', ')}</Text>
                    ) : null}
                  </View>
                  {c.source ? (
                    <Text style={styles.clusterSource}>{c.source}</Text>
                  ) : null}
                  <Text style={styles.compactMeta}>{c.count}</Text>
                  <Icon
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={theme.colors.textSubtle}
                  />
                </TouchableOpacity>
              );
            })}
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
    const context = trace.llm.context;
    return (
      <>
        {context ? (
          <View style={styles.contextBlock}>
            <Text style={styles.subsectionTitle}>Context sent with every prompt</Text>
            {context.provider ? (
              <View style={styles.contextRow}>
                <Text style={styles.contextLabel}>Provider</Text>
                <Text style={styles.contextValue}>{context.provider}</Text>
              </View>
            ) : null}
            {context.profile?.length ? (
              context.profile.map((row, idx) => (
                <View key={`ctx-${idx}`} style={styles.contextRow}>
                  <Text style={styles.contextLabel}>{row.label}</Text>
                  <Text style={styles.contextValue}>{row.value}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.helperText}>
                No personal context provided — add details in "Tell us about you"
                so the model can name groups like "IIT-B friends".
              </Text>
            )}
          </View>
        ) : null}
        {trace.llm.batches.map((b) => {
          const showAll = !!showAllCards[b.index];
          // In the hybrid path no flat contact cards are sent — the model
          // works only from the seed clusters above — so `contactCards` is
          // null. Constrained mode still sends them.
          const cards = b.contactCards || [];
          const visibleCards = showAll ? cards : cards.slice(0, 15);
          const hidden = cards.length - visibleCards.length;
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
                  {[...b.seedClusters]
                    .sort(labelsUpClustersDown((s) => s.members?.length || 0))
                    .map((s, idx) => (
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

              {cards.length ? (
                <Text style={styles.subsectionTitle}>
                  Contact cards ({cards.length})
                </Text>
              ) : null}
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
                  {b.parseFailReason ||
                    "The model returned a response we couldn't parse as JSON."}
                </Text>
                <Text style={styles.helperText}>
                  Raw output ({formatBytes(b.rawResponseSize)}):
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
                hallucination-rejection passes.
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

  // "Transform" tab: walks every group the model returned (and every group
  // local heuristics claimed) through the post-LLM constraint pass — collapse
  // to Family/Helpers, Office rename/downgrade, dedup-merge, empty-drop — so
  // the user can see exactly how the "LLM reply" turned into "Proposed".
  const renderTransformTab = () => {
    if (!trace) {
      return <Text style={styles.emptyText}>No trace available.</Text>;
    }
    const steps = trace.transforms || [];
    if (!steps.length) {
      return (
        <Text style={styles.helperText}>
          {trace.mode === 'constrained'
            ? "Nothing was reshaped — contacts were slotted straight into your existing groups, so each group's name and category are unchanged."
            : 'No transformations were recorded for this run.'}
        </Text>
      );
    }
    // Model output first, then locally-claimed groups — the user reads this
    // as "here's what the LLM said and what we did with it", with the local
    // pre-assignments as a secondary section.
    const sections = [
      { origin: 'llm', title: 'From the model', items: steps.filter((s) => s.origin === 'llm') },
      { origin: 'local', title: 'From local rules / your address book', items: steps.filter((s) => s.origin !== 'llm') },
    ].filter((s) => s.items.length);

    return (
      <>
        <Text style={styles.helperText}>
          Member counts are after names the model invented were dropped. Groups
          with the same final name and category are merged into one proposed
          group.
        </Text>
        {sections.map((section) => (
          <View key={section.origin}>
            <Text style={styles.sectionTitle}>
              {section.title} ({section.items.length})
            </Text>
            {section.items.map((s, idx) => {
              const fromCat = categoryFor(s.fromCategoryId);
              const dropped = s.toName == null;
              const toCat = categoryFor(s.toCategoryId);
              const renamed =
                !dropped &&
                (s.toName !== s.fromName || s.toCategoryId !== s.fromCategoryId);
              return (
                <View
                  key={`xf-${section.origin}-${idx}`}
                  style={styles.transformBlock}
                >
                  <View style={styles.transformLine}>
                    <View style={[styles.dot, { backgroundColor: fromCat.color }]} />
                    <Text style={[styles.rowName, { flex: 1 }]} numberOfLines={1}>
                      {s.fromName || '(unnamed)'}
                    </Text>
                    <Text style={styles.compactMeta}>
                      {fromCat.name} · {s.fromCount}
                    </Text>
                  </View>
                  <View style={styles.transformActionRow}>
                    <Icon
                      name={dropped ? 'close-circle-outline' : 'arrow-down'}
                      size={14}
                      color={dropped ? theme.colors.danger : theme.colors.textSubtle}
                    />
                    <Text
                      style={[
                        styles.transformAction,
                        dropped && { color: theme.colors.danger },
                      ]}
                    >
                      {s.action}
                    </Text>
                  </View>
                  {dropped ? null : (
                    <View style={styles.transformLine}>
                      <View style={[styles.dot, { backgroundColor: toCat.color }]} />
                      <Text
                        style={[
                          styles.rowName,
                          { flex: 1 },
                          !renamed && { color: theme.colors.textMuted },
                        ]}
                        numberOfLines={1}
                      >
                        {s.toName}
                      </Text>
                      <Text style={styles.compactMeta}>{toCat.name}</Text>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        ))}
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
            {tabId === 'transform' ? renderTransformTab() : null}
            {tabId !== 'proposed' ? null : (
            <>
            {groups.length === 0 ? (
              <Text style={styles.emptyText}>
                No groups left. Add at least one below, or cancel.
              </Text>
            ) : null}
            {history.length ? (
              <TouchableOpacity
                style={styles.undoRow}
                onPress={handleUndo}
                activeOpacity={0.7}
              >
                <Icon name="undo-variant" size={16} color={theme.colors.primary} />
                <Text style={styles.undoText}>
                  Undo last change ({history.length})
                </Text>
              </TouchableOpacity>
            ) : null}
            {mergeSourceIdx !== null ? (
              <View style={styles.mergeBanner}>
                <Icon name="call-merge" size={16} color={theme.colors.primary} />
                <Text style={styles.mergeBannerText} numberOfLines={1}>
                  Merge “{groups[mergeSourceIdx]?.name}” into… pick a group
                </Text>
                <TouchableOpacity onPress={() => setMergeSourceIdx(null)} hitSlop={8}>
                  <Text style={styles.mergeCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {(() => {
              // Render groups sectioned by category. Each group keeps its
              // original index in `groups` so the remove button still
              // targets the right entry after sectioning.
              const indexed = groups.map((g, idx) => ({ g, idx }));
              // Merge needs ≥2 NON-base groups: base groups (declared
              // workplaces from the questionnaire) are protected — they can be
              // neither a merge source nor a target.
              const nonBaseCount = groups.filter((g) => !g.isBase).length;
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
                // Always show the colored category header so every category is
                // clearly delimited. Single-group categories (Family, Helpers)
                // otherwise rendered as a lone row with no header, bleeding
                // into the previous section — e.g. a relatives "Family" row
                // sitting right under the Friends groups looked like it was
                // categorised as a friend (its gold dot was the only cue).
                const showHeader = true;
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
                      const rowKey = `proposed-${idx}`;
                      const expanded = expandedGroupId === rowKey;
                      const isBase = !!g.isBase;
                      const isMergeSource = mergeSourceIdx === idx;
                      // Base groups are protected: never a merge target.
                      const isMergeTarget =
                        mergeSourceIdx !== null && !isMergeSource && !isBase;

                      // Merge-target mode: the whole row is a button that
                      // merges the chosen source group into this one.
                      if (isMergeTarget) {
                        return (
                          <TouchableOpacity
                            key={`${groupSignature(g)}-${idx}`}
                            style={[styles.row, styles.rowMergeTarget]}
                            onPress={() => handleMerge(mergeSourceIdx, idx)}
                            activeOpacity={0.7}
                          >
                            <View style={[styles.dot, { backgroundColor: cat.color }]} />
                            <View style={{ flex: 1 }}>
                              <Text style={styles.rowName} numberOfLines={1}>
                                {g.name}
                              </Text>
                              <Text style={styles.rowMeta}>
                                {count} {count === 1 ? 'contact' : 'contacts'} · tap to merge here
                              </Text>
                            </View>
                            <Icon name="call-merge" size={18} color={theme.colors.primary} />
                          </TouchableOpacity>
                        );
                      }

                      return (
                        <View
                          key={`${groupSignature(g)}-${idx}`}
                          style={[styles.row, isMergeSource && styles.rowMergeSource]}
                        >
                          <View style={[styles.dot, { backgroundColor: cat.color }]} />
                          <TouchableOpacity
                            style={{ flex: 1 }}
                            activeOpacity={0.7}
                            onPress={() =>
                              setExpandedGroupId(expanded ? null : rowKey)
                            }
                          >
                            <Text style={styles.rowName} numberOfLines={1}>
                              {g.name}
                            </Text>
                            <Text style={styles.rowMeta}>
                              {count} {count === 1 ? 'contact' : 'contacts'}
                              {isBase ? ' · from your profile' : ''}
                              {count ? (expanded ? ' · tap to hide' : ' · tap to show') : ''}
                            </Text>
                            {expanded && count ? (
                              <Text style={styles.memberList}>
                                {memberNamesOf(g).join(', ')}
                              </Text>
                            ) : null}
                          </TouchableOpacity>
                          {/* Action icons only outside merge mode. Base groups
                              get no merge icon — they can't be merged away. */}
                          {mergeSourceIdx === null ? (
                            <>
                              {!isBase && nonBaseCount > 1 ? (
                                <TouchableOpacity
                                  style={styles.rowActionBtn}
                                  onPress={() => {
                                    setExpandedGroupId(null);
                                    setMergeSourceIdx(idx);
                                  }}
                                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                >
                                  <Icon name="call-merge" size={18} color={theme.colors.textMuted} />
                                </TouchableOpacity>
                              ) : null}
                              <TouchableOpacity
                                style={styles.removeBtn}
                                onPress={() => handleRemove(idx)}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              >
                                <Icon name="close" size={18} color={theme.colors.textMuted} />
                              </TouchableOpacity>
                            </>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                );
              });
            })()}

            {mergeSourceIdx !== null ? null : !allowNewGroups ? null : addOpen ? (
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
  clusterSource: {
    marginLeft: 'auto',
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    fontStyle: 'italic',
  },
  contextBlock: {
    marginBottom: theme.spacing.md,
    padding: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  contextRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 3,
  },
  contextLabel: {
    width: 110,
    fontSize: theme.font.tiny,
    fontWeight: '700',
    color: theme.colors.textMuted,
  },
  contextValue: {
    flex: 1,
    fontSize: theme.font.tiny,
    color: theme.colors.text,
    lineHeight: 15,
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
  transformBlock: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    marginBottom: theme.spacing.xs,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  transformLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  transformActionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 3,
    paddingLeft: 1,
  },
  transformAction: {
    flex: 1,
    marginLeft: 6,
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    fontStyle: 'italic',
    lineHeight: 15,
  },
  removeBtn: {
    padding: 4,
  },
  rowActionBtn: {
    padding: 4,
    marginRight: 2,
  },
  rowMergeSource: {
    borderColor: theme.colors.primary,
    borderStyle: 'dashed',
  },
  rowMergeTarget: {
    borderColor: theme.colors.primary,
  },
  mergeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    marginBottom: theme.spacing.xs,
  },
  mergeBannerText: {
    flex: 1,
    marginLeft: 6,
    fontSize: theme.font.tiny,
    color: theme.colors.text,
  },
  mergeCancelText: {
    fontSize: theme.font.tiny,
    fontWeight: '600',
    color: theme.colors.primary,
  },
  undoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderStyle: 'dashed',
  },
  undoText: {
    marginLeft: 6,
    fontSize: theme.font.tiny,
    fontWeight: '600',
    color: theme.colors.primary,
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
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
    fontSize: theme.font.body,
    color: theme.colors.text,
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
