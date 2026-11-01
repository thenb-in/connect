import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import theme from '../theme';

const DAY_MS = 24 * 60 * 60 * 1000;

// Rough answers are enough: the engine only needs to know who has gone quiet.
const OPTIONS = [
  { label: 'This month', daysAgo: 14 },
  { label: '1–3 months', daysAgo: 60 },
  { label: '3–12 months', daysAgo: 180 },
  { label: 'Over a year', daysAgo: 400 },
];

/**
 * Onboarding sheet for iOS, which exposes no call history: asks roughly when
 * the user last spoke to each hand-picked person, so Reconnect has something to
 * work from on day one. Anyone left unanswered simply gets no call record.
 *
 * Props:
 *   visible — show/hide the sheet.
 *   people  — contacts to ask about.
 *   onDone  — (answers: Array<{ contact, timestamp }>) => void.
 *   onSkip  — () => void.
 */
const LastSpokeModal = ({ visible, people = [], onDone, onSkip }) => {
  const insets = useSafeAreaInsets();
  const [daysAgoByKey, setDaysAgoByKey] = useState({});

  const onPick = useCallback((key, daysAgo) => {
    setDaysAgoByKey((prev) => ({
      ...prev,
      [key]: prev[key] === daysAgo ? undefined : daysAgo,
    }));
  }, []);

  const handleDone = useCallback(() => {
    const now = Date.now();
    onDone?.(
      people
        .filter((c) => daysAgoByKey[c.normalized])
        .map((c) => ({
          contact: c,
          timestamp: now - daysAgoByKey[c.normalized] * DAY_MS,
        })),
    );
  }, [people, daysAgoByKey, onDone]);

  const renderItem = useCallback(
    ({ item }) => (
      <View style={styles.row}>
        <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
        <View style={styles.chips}>
          {OPTIONS.map((o) => {
            const active = daysAgoByKey[item.normalized] === o.daysAgo;
            return (
              <TouchableOpacity
                key={o.label}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => onPick(item.normalized, o.daysAgo)}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {o.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    ),
    [daysAgoByKey, onPick],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={() => onSkip?.()}>
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + theme.spacing.md }]}>
          <Text style={styles.title}>When did you last talk?</Text>
          <Text style={styles.subtitle}>
            iPhone keeps call history private, so a rough guess gives Connect a
            head start. Leave anyone blank if you&apos;re not sure.
          </Text>
        </View>

        <FlatList
          data={people}
          keyExtractor={(c) => c.normalized}
          renderItem={renderItem}
          extraData={daysAgoByKey}
          contentContainerStyle={{ paddingBottom: theme.spacing.lg }}
        />

        <View style={[styles.footer, { paddingBottom: insets.bottom + theme.spacing.lg }]}>
          <TouchableOpacity
            style={[styles.footerBtn, styles.btnSecondary]}
            onPress={() => onSkip?.()}
          >
            <Text style={styles.btnSecondaryText}>Skip</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.footerBtn, styles.btnPrimary]}
            onPress={handleDone}
          >
            <Text style={styles.btnPrimaryText}>Continue</Text>
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
    paddingBottom: theme.spacing.md,
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
  row: {
    marginHorizontal: theme.spacing.lg,
    marginVertical: 4,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  name: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  chip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  chipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surfaceAlt,
  },
  chipText: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
  },
  chipTextActive: {
    color: theme.colors.primary,
    fontWeight: '700',
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
});

export default LastSpokeModal;
