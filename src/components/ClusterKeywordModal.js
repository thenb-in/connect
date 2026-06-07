import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';

// Clusters this big are auto-selected on open — a recurring name shared by
// more than this many contacts is almost always a real cohort (a big family,
// a college batch) worth keeping, so we pre-check it rather than make the user
// hunt for it. "More than 30" → strictly greater than the threshold.
export const AUTO_SELECT_MIN_MEMBERS = 30;

// The chip label is the bare keyword. The clusterer already cased it
// (title-case, or all-caps when a contact wrote it that way), so we show it
// verbatim and only fall back to stripping a "Cluster: " prefix off the name.
const keywordOf = (c) =>
  c?.token || (c?.name || '').replace(/^Cluster:\s*/i, '');

// A single tickable keyword chip. Memoized so toggling one chip only
// re-renders that chip rather than the whole grid. The check glyph lives in a
// fixed-width slot that's always present (empty when unselected) so ticking
// never changes the chip's width and the wrap layout stays put.
const ClusterChip = React.memo(({ cluster, selected, onToggle }) => (
  <TouchableOpacity
    style={[styles.chip, selected && styles.chipSelected]}
    activeOpacity={0.7}
    delayPressIn={0}
    onPress={() => onToggle(cluster.id)}
  >
    <View style={styles.chipIconSlot}>
      {selected ? (
        <Icon name="check" size={14} color={theme.colors.surface} />
      ) : null}
    </View>
    <Text
      style={[styles.chipText, selected && styles.chipTextSelected]}
      numberOfLines={1}
    >
      {keywordOf(cluster)}
    </Text>
    <Text style={[styles.chipCount, selected && styles.chipCountSelected]}>
      {cluster.count}
    </Text>
  </TouchableOpacity>
));

/**
 * Onboarding step 1 of 2: the local clusterer found recurring name tokens
 * (shared surnames / first names). The user ticks the ones that mean something
 * to them — a family surname, a college batch. The picked clusters are handed
 * back to onboarding, which opens the review modal (step 2) where the user
 * marks each one's category and merges / removes before they become groups.
 *
 * Clusters with more than AUTO_SELECT_MIN_MEMBERS members start ticked.
 */
const ClusterKeywordModal = ({ visible, clusters = [], onConfirm }) => {
  // Set of selected cluster ids. Seeded from the big-cluster auto-select rule
  // every time the modal opens so a re-open starts from a sensible default.
  const [selected, setSelected] = useState(() => new Set());

  // Biggest clusters first — the most likely to be meaningful cohorts lead.
  const sorted = useMemo(
    () => [...clusters].sort((a, b) => (b.count || 0) - (a.count || 0)),
    [clusters],
  );

  useEffect(() => {
    if (!visible) return;
    const auto = new Set(
      clusters
        .filter((c) => (c.count || 0) > AUTO_SELECT_MIN_MEMBERS)
        .map((c) => c.id),
    );
    setSelected(auto);
  }, [visible, clusters]);

  const toggle = useCallback(
    (id) =>
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const handleConfirm = () => {
    const chosen = clusters.filter((c) => selected.has(c.id));
    onConfirm?.(chosen);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleConfirm}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Keywords you relate to</Text>
          <Text style={styles.subtitle}>
            We spotted these names recurring across your contacts. Tick the ones
            that mean something to you — a family surname, a college batch. Next
            you'll mark each one's group.
          </Text>

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
          >
            {sorted.length === 0 ? (
              <Text style={styles.emptyText}>
                No recurring name keywords found. Tap Continue to proceed.
              </Text>
            ) : (
              <View style={styles.chipWrap}>
                {sorted.map((c) => (
                  <ClusterChip
                    key={c.id}
                    cluster={c}
                    selected={selected.has(c.id)}
                    onToggle={toggle}
                  />
                ))}
              </View>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.footerBtn, styles.btnPrimary]}
              onPress={handleConfirm}
            >
              <Text style={styles.btnPrimaryText}>Continue</Text>
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
  },
  listContent: {
    paddingBottom: theme.spacing.sm,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 8,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    marginRight: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  chipSelected: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  // Always-present, fixed-width slot for the check glyph. Keeping it in the
  // layout whether or not the chip is selected means ticking/unticking never
  // changes the chip width, so the wrap grid doesn't reflow on every tap.
  chipIconSlot: {
    width: 16,
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontSize: theme.font.small,
    fontWeight: '600',
    color: theme.colors.text,
    maxWidth: 160,
  },
  chipTextSelected: {
    color: theme.colors.surface,
  },
  chipCount: {
    marginLeft: 6,
    fontSize: theme.font.tiny,
    fontWeight: '700',
    color: theme.colors.textSubtle,
  },
  chipCountSelected: {
    color: 'rgba(255,255,255,0.85)',
  },
  emptyText: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    fontStyle: 'italic',
    paddingVertical: theme.spacing.md,
    textAlign: 'center',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: theme.spacing.lg,
  },
  footerBtn: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    marginLeft: theme.spacing.sm,
  },
  btnPrimary: { backgroundColor: theme.colors.primary },
  btnPrimaryText: {
    color: theme.colors.surface,
    fontWeight: '700',
    fontSize: theme.font.small,
  },
  btnGhost: { backgroundColor: 'transparent' },
  btnGhostText: {
    color: theme.colors.textMuted,
    fontWeight: '600',
    fontSize: theme.font.small,
  },
});

export default ClusterKeywordModal;
