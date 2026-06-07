import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  FlatList,
  ScrollView,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import DateTimePickerModal from './DateTimePickerModal';
import { buildSearchHaystack } from '../utils/contactSearch';
import { normalizeLast10 } from '../utils/phone';
import { formatTimestamp } from '../utils/dateUtils';

// The three call types a user can hand-log. Values match what the relationship
// engine and the Saved-call-logs viewer expect (they look for the OUT/IN/MISS
// substrings), so a manual row reasons exactly like a device-imported one.
const TYPES = [
  { value: 'OUTGOING', label: 'Outgoing', icon: 'phone-outgoing', color: theme.colors.primary },
  { value: 'INCOMING', label: 'Incoming', icon: 'phone-incoming', color: theme.colors.success },
  { value: 'MISSED', label: 'Missed', icon: 'phone-missed', color: theme.colors.accent },
];

/**
 * Full-screen sheet for hand-logging a call Connect didn't capture
 * automatically — the manual counterpart to the Android call-log import, and
 * the only way to feed the engine on iOS (which exposes no call history).
 *
 * The user picks a call type, a number (typed, or tapped from their contacts),
 * an optional duration, and when the call happened (defaults to now, via the
 * built-in date/time picker).
 *
 * Props:
 *   visible   — show/hide the sheet.
 *   contacts  — contacts to search when picking a number.
 *   onClose   — () => void, dismiss without saving.
 *   onAdd     — ({ phoneNumber, type, duration, timestamp }) => void, save it.
 */
const AddCallLogModal = ({ visible, contacts = [], onClose, onAdd }) => {
  const insets = useSafeAreaInsets();
  const [type, setType] = useState('OUTGOING');
  const [number, setNumber] = useState('');
  const [durationMin, setDurationMin] = useState('');
  const [query, setQuery] = useState('');
  const [timestamp, setTimestamp] = useState(() => Date.now());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [contactPickerOpen, setContactPickerOpen] = useState(false);

  // Reset every field each time the sheet opens so a reopened form never
  // inherits stale input from a previous entry.
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setWasVisible(true);
    setType('OUTGOING');
    setNumber('');
    setDurationMin('');
    setQuery('');
    setTimestamp(Date.now());
    setPickerOpen(false);
    setContactPickerOpen(false);
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }

  const indexed = useMemo(
    () => contacts.map((c) => ({ contact: c, haystack: buildSearchHaystack(c) })),
    [contacts],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return indexed;
    return indexed.filter((row) => row.haystack.includes(q));
  }, [indexed, query]);

  // Resolve a typed/picked number back to a saved contact name so we can echo
  // "who" the number belongs to right under the input.
  const nameByKey = useMemo(() => {
    const map = new Map();
    contacts.forEach((c) => {
      if (c.normalized && !map.has(c.normalized)) {
        map.set(c.normalized, c.name);
      }
    });
    return map;
  }, [contacts]);

  const selectedKey = normalizeLast10(number);
  const canSave = selectedKey.length > 0;
  const isMissed = type === 'MISSED';
  const resolvedName = selectedKey ? nameByKey.get(selectedKey) : null;

  const onPickContact = useCallback((c) => {
    setNumber(c.phone || c.normalized || '');
    setQuery('');
    setContactPickerOpen(false);
  }, []);

  const handleSave = useCallback(() => {
    if (!canSave) return;
    onAdd?.({
      phoneNumber: number.trim(),
      type,
      // A missed call never connected, so its duration is always zero.
      duration: isMissed ? 0 : (parseInt(durationMin, 10) || 0) * 60,
      timestamp,
    });
  }, [canSave, onAdd, number, type, isMissed, durationMin, timestamp]);

  const renderItem = useCallback(
    ({ item }) => {
      const c = item.contact;
      const checked = c.normalized && c.normalized === selectedKey;
      return (
        <TouchableOpacity
          onPress={() => onPickContact(c)}
          style={[styles.row, checked && styles.rowChecked]}
        >
          <Icon
            name={checked ? 'check-circle' : 'account-circle-outline'}
            size={22}
            color={checked ? theme.colors.primary : theme.colors.textSubtle}
          />
          <View style={{ flex: 1, marginLeft: theme.spacing.md }}>
            <Text style={styles.name} numberOfLines={1}>{c.name}</Text>
            <Text style={styles.meta} numberOfLines={1}>
              {c.phone || c.normalized || ''}
              {c.company ? `  ·  ${c.company}` : ''}
            </Text>
          </View>
        </TouchableOpacity>
      );
    },
    [selectedKey, onPickContact],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={() => onClose?.()}>
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + theme.spacing.md }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Add call log</Text>
            <Text style={styles.subtitle}>
              Record a call Connect didn&apos;t capture automatically.
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => onClose?.()}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Icon name="close" size={24} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={{ paddingBottom: theme.spacing.lg }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.sectionLabel}>Call type</Text>
          <View style={styles.typeRow}>
            {TYPES.map((t) => {
              const active = t.value === type;
              return (
                <TouchableOpacity
                  key={t.value}
                  style={[styles.typeChip, active && { borderColor: t.color, backgroundColor: theme.colors.surfaceAlt }]}
                  onPress={() => setType(t.value)}
                >
                  <Icon name={t.icon} size={18} color={active ? t.color : theme.colors.textSubtle} />
                  <Text style={[styles.typeText, active && { color: t.color }]}>{t.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.sectionLabel}>Phone number</Text>
          <View style={styles.numberWrap}>
            <Icon name="phone-outline" size={18} color={theme.colors.textSubtle} />
            <TextInput
              style={styles.numberInput}
              placeholder="Enter or pick a number"
              placeholderTextColor={theme.colors.textSubtle}
              value={number}
              onChangeText={setNumber}
              keyboardType="phone-pad"
            />
            {number ? (
              <TouchableOpacity
                onPress={() => setNumber('')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Icon name="close-circle" size={18} color={theme.colors.textSubtle} />
              </TouchableOpacity>
            ) : null}
            {/* Vertical divider separating the entry field from the contact
                selector button on its right. */}
            <View style={styles.fieldDivider} />
            <TouchableOpacity
              onPress={() => setContactPickerOpen(true)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.contactsBtn}
            >
              <Icon name="account-search-outline" size={20} color={theme.colors.primary} />
            </TouchableOpacity>
          </View>
          {/* Echo the saved contact name for the entered number, when we know it. */}
          {resolvedName ? (
            <View style={styles.resolvedRow}>
              <Icon name="account-check-outline" size={14} color={theme.colors.success} />
              <Text style={styles.resolvedText} numberOfLines={1}>{resolvedName}</Text>
            </View>
          ) : null}

          {!isMissed ? (
            <>
              <Text style={styles.sectionLabel}>Duration (minutes, optional)</Text>
              <View style={styles.numberWrap}>
                <Icon name="timer-outline" size={18} color={theme.colors.textSubtle} />
                <TextInput
                  style={styles.numberInput}
                  placeholder="0"
                  placeholderTextColor={theme.colors.textSubtle}
                  value={durationMin}
                  onChangeText={(t) => setDurationMin(t.replace(/\D/g, ''))}
                  keyboardType="number-pad"
                />
              </View>
            </>
          ) : null}

          <Text style={styles.sectionLabel}>Date &amp; time</Text>
          <TouchableOpacity
            style={styles.numberWrap}
            onPress={() => setPickerOpen(true)}
          >
            <Icon name="calendar-clock" size={18} color={theme.colors.textSubtle} />
            <Text style={[styles.numberInput, styles.dateText]}>
              {formatTimestamp(timestamp)}
            </Text>
            <Icon name="chevron-down" size={18} color={theme.colors.textSubtle} />
          </TouchableOpacity>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + theme.spacing.lg }]}>
          <TouchableOpacity
            style={[styles.footerBtn, styles.btnSecondary]}
            onPress={() => onClose?.()}
          >
            <Text style={styles.btnSecondaryText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.footerBtn, styles.btnPrimary, !canSave && styles.btnDisabled]}
            disabled={!canSave}
            onPress={handleSave}
          >
            <Text style={styles.btnPrimaryText}>Add call log</Text>
          </TouchableOpacity>
        </View>

        <DateTimePickerModal
          visible={pickerOpen}
          value={timestamp}
          maximumDate={Date.now()}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(ms) => {
            setTimestamp(ms);
            setPickerOpen(false);
          }}
        />

        {/* Contact selector — opened from the button beside the phone field.
            Tapping a contact fills the number and closes this sheet. */}
        <Modal
          visible={contactPickerOpen}
          animationType="slide"
          onRequestClose={() => setContactPickerOpen(false)}
        >
          <View style={styles.container}>
            <View style={[styles.header, { paddingTop: insets.top + theme.spacing.md }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>Pick a contact</Text>
                <Text style={styles.subtitle}>Tap a contact to use their number.</Text>
              </View>
              <TouchableOpacity
                onPress={() => setContactPickerOpen(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Icon name="close" size={24} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>

            <View style={styles.searchWrap}>
              <Icon name="magnify" size={18} color={theme.colors.textSubtle} />
              <TextInput
                style={styles.numberInput}
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

            <FlatList
              data={filtered}
              keyExtractor={(r) => r.contact.normalized || r.contact.key}
              renderItem={renderItem}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: insets.bottom + theme.spacing.lg }}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>
                    {query ? 'No contacts match that search.' : 'No contacts to pick from.'}
                  </Text>
                </View>
              }
            />
          </View>
        </Modal>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
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
  sectionLabel: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    fontSize: theme.font.tiny,
    fontWeight: '700',
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  typeRow: {
    flexDirection: 'row',
    marginHorizontal: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  typeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  typeText: {
    marginLeft: 6,
    fontSize: theme.font.small,
    fontWeight: '600',
    color: theme.colors.textMuted,
  },
  numberWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: theme.spacing.lg,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  numberInput: {
    flex: 1,
    marginLeft: theme.spacing.sm,
    color: theme.colors.text,
    fontSize: theme.font.body,
    paddingVertical: 0,
  },
  dateText: {
    paddingVertical: 2,
  },
  fieldDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: theme.colors.border,
    marginVertical: -theme.spacing.sm,
    marginHorizontal: theme.spacing.sm,
  },
  contactsBtn: {
    paddingHorizontal: theme.spacing.xs,
  },
  resolvedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
  },
  resolvedText: {
    marginLeft: 6,
    fontSize: theme.font.small,
    fontWeight: '600',
    color: theme.colors.success,
    flex: 1,
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
  empty: { padding: theme.spacing.xl, alignItems: 'center' },
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

export default AddCallLogModal;
