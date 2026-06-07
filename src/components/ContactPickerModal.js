import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  FlatList,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import { buildSearchHaystack } from '../utils/contactSearch';

/**
 * Full-screen contact picker with search + "select all in this search".
 *
 * Selection is keyed by each contact's normalised (last-10) phone — the same
 * join key the group store uses — so the parent can hand the result straight
 * to addContactsToGroup. The component is self-contained: it manages its own
 * query and selection, resetting them every time it becomes visible.
 *
 * Props:
 *   visible        — show/hide the modal.
 *   title          — header title.
 *   subtitle       — header subtitle (optional).
 *   contacts       — array of contacts to choose from.
 *   confirmLabel   — verb shown on the primary button (default "Add").
 *   onConfirm      — (normalizedPhones: string[]) => void.
 *   onSkip         — () => void, the secondary "Skip" action.
 */
const ContactPickerModal = ({
  visible,
  title = 'Choose contacts',
  subtitle,
  contacts = [],
  confirmLabel = 'Add',
  onConfirm,
  onSkip,
}) => {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());

  // Reset query + selection each time the modal opens so a reopened picker
  // never inherits a stale search or selection from a previous run.
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setWasVisible(true);
    setQuery('');
    setSelected(new Set());
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }

  // Precompute the haystack once per contact so each keystroke is a cheap
  // String.includes rather than a re-flatten of every field.
  const indexed = useMemo(
    () => contacts.map((c) => ({ contact: c, haystack: buildSearchHaystack(c) })),
    [contacts],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return indexed;
    return indexed.filter((row) => row.haystack.includes(q));
  }, [indexed, query]);

  const visibleKeys = useMemo(
    () => filtered.map((r) => r.contact.normalized).filter(Boolean),
    [filtered],
  );
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));

  const toggle = useCallback((key) => {
    if (!key) return;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // "Select all" toggles every contact in the CURRENT search — selecting them
  // when any are missing, clearing them when all are already in. This is the
  // headline affordance: search to narrow, then grab the whole result set.
  const onSelectAllVisible = useCallback(() => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allVisibleSelected) {
        visibleKeys.forEach((k) => next.delete(k));
      } else {
        visibleKeys.forEach((k) => next.add(k));
      }
      return next;
    });
  }, [visibleKeys, allVisibleSelected]);

  const renderItem = useCallback(
    ({ item }) => {
      const c = item.contact;
      const key = c.normalized;
      const checked = key && selected.has(key);
      return (
        <TouchableOpacity
          onPress={() => toggle(key)}
          style={[styles.row, checked && styles.rowChecked]}
        >
          <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
            {checked ? (
              <Icon name="check" size={14} color={theme.colors.surface} />
            ) : null}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={1}>{c.name}</Text>
            <Text style={styles.meta} numberOfLines={1}>
              {c.phone || c.normalized || ''}
              {c.company ? `  ·  ${c.company}` : ''}
            </Text>
          </View>
        </TouchableOpacity>
      );
    },
    [selected, toggle],
  );

  const selectedPhones = useMemo(() => [...selected], [selected]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={() => onSkip?.()}
    >
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + theme.spacing.md }]}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>

        <View style={styles.searchWrap}>
          <Icon name="magnify" size={18} color={theme.colors.textSubtle} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search name, company, city, phone…"
            placeholderTextColor={theme.colors.textSubtle}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query ? (
            <TouchableOpacity
              onPress={() => setQuery('')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Icon name="close-circle" size={18} color={theme.colors.textSubtle} />
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.statusBar}>
          <Text style={styles.statusText}>
            {filtered.length} {filtered.length === 1 ? 'match' : 'matches'} ·{' '}
            {selected.size} selected
          </Text>
          {visibleKeys.length > 0 ? (
            <TouchableOpacity onPress={onSelectAllVisible} style={styles.statusBtn}>
              <Text style={styles.statusBtnText}>
                {allVisibleSelected ? 'Unselect filtered' : 'Select filtered'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <FlatList
          data={filtered}
          keyExtractor={(r) => r.contact.normalized || r.contact.key}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: theme.spacing.lg }}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {query
                  ? 'No contacts match that search.'
                  : 'No contacts to show yet.'}
              </Text>
            </View>
          }
        />

        <View style={[styles.footer, { paddingBottom: insets.bottom + theme.spacing.lg }]}>
          <TouchableOpacity
            style={[styles.footerBtn, styles.btnSecondary]}
            onPress={() => onSkip?.()}
          >
            <Text style={styles.btnSecondaryText}>Skip</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.footerBtn,
              styles.btnPrimary,
              selected.size === 0 && styles.btnDisabled,
            ]}
            disabled={selected.size === 0}
            onPress={() => onConfirm?.(selectedPhones)}
          >
            <Text style={styles.btnPrimaryText}>
              {selected.size > 0
                ? `${confirmLabel} (${selected.size})`
                : confirmLabel}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  title: {
    fontSize: theme.font.h3,
    fontWeight: '700',
    color: theme.colors.text,
  },
  subtitle: {
    marginTop: theme.spacing.xs,
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    lineHeight: 18,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  searchInput: {
    flex: 1,
    marginLeft: theme.spacing.sm,
    color: theme.colors.text,
    fontSize: theme.font.body,
    paddingVertical: 0,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
  },
  statusText: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  statusBtn: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
  },
  statusBtnText: {
    color: theme.colors.primary,
    fontWeight: '700',
    fontSize: theme.font.small,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: theme.spacing.lg,
    marginVertical: 4,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  rowChecked: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surfaceAlt,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    marginRight: theme.spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
  },
  checkboxChecked: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  name: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
  },
  meta: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  empty: {
    padding: theme.spacing.xl,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    textAlign: 'center',
  },
  footer: {
    flexDirection: 'row',
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.background,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  footerBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.pill,
  },
  btnPrimary: {
    backgroundColor: theme.colors.primary,
    marginLeft: theme.spacing.sm,
    flex: 2,
  },
  btnPrimaryText: {
    color: theme.colors.surface,
    fontWeight: '700',
    fontSize: theme.font.body,
  },
  btnSecondary: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  btnSecondaryText: {
    color: theme.colors.textMuted,
    fontWeight: '600',
    fontSize: theme.font.body,
  },
  btnDisabled: { opacity: 0.5 },
});

export default ContactPickerModal;
