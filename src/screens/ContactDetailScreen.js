import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Linking,
  TextInput,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import AppHeader from '../components/AppHeader';
import GroupPill from '../components/GroupPill';
import ConnectSetupGate from '../components/ConnectSetupGate';
import { useConnectAnalysis } from '../hooks/useConnectAnalysis';
import { findProfile } from '../engine/relationshipEngine';
import {
  getGroups,
  getGroupsForContact,
  recordReconnect,
  toggleContactInGroup,
  getNote,
  setNote,
  CATEGORIES,
  isDontSuggest,
  toggleDontSuggest,
} from '../storage';
import { reasonForProfile } from '../components/ReconnectCard';
import { makeImmediateCall } from '../utils/makeImmediateCall';
import { sendWhatsAppMessage } from '../utils/appShare';
import { formatShortDateTime, formatDuration } from '../utils/dateUtils';

// Per call-type presentation for the "Recent calls" list. Missed and rejected
// calls never connect, so they show a status word instead of a duration.
const CALL_TYPE_META = {
  outgoing: { icon: 'phone-outgoing', color: theme.colors.primary, label: 'Outgoing' },
  incoming: { icon: 'phone-incoming', color: theme.colors.success, label: 'Incoming' },
  missed: { icon: 'phone-missed', color: theme.colors.accent, label: 'Missed' },
  rejected: { icon: 'phone-cancel', color: theme.colors.accent, label: 'Rejected' },
  other: { icon: 'phone', color: theme.colors.textMuted, label: 'Call' },
};

const callTypeMeta = (type) => CALL_TYPE_META[type] || CALL_TYPE_META.other;

// Label-to-status mapping, in priority order. The first label found on a
// profile wins so a "lost_connection" never gets shadowed by a weaker
// signal. Replaces a stack of nested ternaries.
const STATUS_BY_LABEL = [
  ['lost_connection', 'Lost connection'],
  ['recently_reconnected', 'Recently reconnected'],
  ['consistent', 'Consistent communication'],
  ['strong_historical', 'Strong past communication'],
  ['never_connected', 'Never connected'],
];
const DEFAULT_STATUS = 'Quiet for a while';

const formatDate = (ms) => {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
};

/**
 * Per-contact relationship view. Intentionally avoids the CRM detail screen's
 * heavy "task / lead / status" UI: we show one prose line, soft stats, group
 * chips you can toggle, and a freeform note. No funnel stages or KPIs.
 */
const ContactDetailScreen = ({ navigation, route }) => {
  const phone = route?.params?.phone;
  const { analysis } = useConnectAnalysis();
  const profile = useMemo(() => findProfile(analysis, phone), [analysis, phone]);

  const [bump, setBump] = useState(0);
  // Resolve once so every handler reads the same phone — also lets us key
  // memos and the note-reset effect off a primitive instead of `profile`.
  const contactPhone = profile?.contact?.phone || null;
  const allGroups = useMemo(() => getGroups(), [bump]);
  const contactGroupIds = useMemo(
    () =>
      contactPhone
        ? new Set(getGroupsForContact(contactPhone).map((g) => g.id))
        : new Set(),
    [contactPhone, bump],
  );

  const [noteValue, setNoteValue] = useState(
    contactPhone ? getNote(contactPhone) : '',
  );
  // Same screen instance may be re-rendered with a different contact (e.g.
  // navigating between contacts via a peer-list). Re-seed the note draft
  // when the phone changes so we never show one contact's note on another.
  useEffect(() => {
    setNoteValue(contactPhone ? getNote(contactPhone) : '');
  }, [contactPhone]);

  const dontSuggest = useMemo(
    () => (contactPhone ? isDontSuggest(contactPhone) : false),
    [contactPhone, bump],
  );

  const onToggleDontSuggest = useCallback(() => {
    if (!contactPhone) return;
    toggleDontSuggest(contactPhone);
    setBump((b) => b + 1);
  }, [contactPhone]);

  const onCall = useCallback(() => {
    if (!contactPhone) return;
    recordReconnect(contactPhone);
    makeImmediateCall(contactPhone).catch(() => {});
  }, [contactPhone]);

  const onMessage = useCallback(() => {
    if (!contactPhone) return;
    Linking.openURL(`sms:${contactPhone}`).catch(() => {});
  }, [contactPhone]);

  const onWhatsApp = useCallback(() => {
    if (!contactPhone) return;
    sendWhatsAppMessage(contactPhone);
  }, [contactPhone]);

  const onToggleGroup = useCallback(
    (groupId) => {
      if (!contactPhone) return;
      toggleContactInGroup(contactPhone, groupId);
      setBump((b) => b + 1);
    },
    [contactPhone],
  );

  const saveNote = useCallback(
    (text) => {
      setNoteValue(text);
      if (contactPhone) setNote(contactPhone, text);
    },
    [contactPhone],
  );

  const onMarkReconnected = useCallback(() => {
    if (!contactPhone) return;
    recordReconnect(contactPhone);
    setBump((b) => b + 1);
  }, [contactPhone]);

  if (!profile) {
    return (
      <View style={styles.container}>
        <AppHeader title="Contact" onBack={() => navigation.goBack()} />
        <View style={styles.center}>
          <Text style={styles.muted}>Contact not found.</Text>
        </View>
      </View>
    );
  }

  const { contact, summary, labels } = profile;
  const status =
    STATUS_BY_LABEL.find(([label]) => labels.includes(label))?.[1] ||
    DEFAULT_STATUS;

  return (
    <View style={styles.container}>
      <AppHeader
        title={contact.name}
        subtitle={contact.phone}
        onBack={() => navigation.goBack()}
      />
      <ConnectSetupGate>
      <ScrollView contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}>
        <View style={styles.heroCard}>
          <View style={styles.statusRow}>
            <Icon name="heart-outline" size={16} color={theme.colors.accent} />
            <Text style={styles.statusText}>{status}</Text>
          </View>
          <Text style={styles.reason}>{reasonForProfile(profile)}</Text>

          <View style={styles.heroActions}>
            <TouchableOpacity style={styles.primaryAction} onPress={onCall}>
              <Icon name="phone" size={18} color={theme.colors.surface} />
              <Text style={styles.primaryActionText}>Call</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryAction} onPress={onMessage}>
              <Icon name="message-text-outline" size={18} color={theme.colors.primary} />
              <Text style={styles.secondaryActionText}>Message</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryAction} onPress={onWhatsApp}>
              <Icon name="whatsapp" size={18} color={theme.colors.primary} />
              <Text style={styles.secondaryActionText}>WhatsApp</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryAction} onPress={onMarkReconnected}>
              <Icon name="check-circle-outline" size={18} color={theme.colors.primary} />
              <Text style={styles.secondaryActionText}>Mark reconnected</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.secondaryAction,
                dontSuggest && styles.secondaryActionActive,
              ]}
              onPress={onToggleDontSuggest}
            >
              <Icon
                name={dontSuggest ? 'bell-off' : 'bell-off-outline'}
                size={18}
                color={dontSuggest ? theme.colors.surface : theme.colors.primary}
              />
              <Text
                style={[
                  styles.secondaryActionText,
                  dontSuggest && styles.secondaryActionActiveText,
                ]}
              >
                {dontSuggest ? "Won't suggest" : "Don't suggest"}
              </Text>
            </TouchableOpacity>
          </View>
          {dontSuggest ? (
            <Text style={styles.suppressedHint}>
              Hidden from Reconnect Today, Lost Connections, and reminders.
            </Text>
          ) : null}
        </View>

        <View style={styles.metaCard}>
          <Meta label="Last spoke" value={formatDate(summary.last)} />
          <Meta
            label="First seen"
            value={formatDate(summary.first)}
          />
          <Meta label="Total interactions" value={summary.total} />
          <Meta label="Missed" value={summary.missed} />
          <Meta label="Active span" value={summary.spanDays ? `${summary.spanDays} days` : '—'} />
          <Meta label="Peak / month" value={summary.peakPerMonth} />
        </View>

        {summary.recentCalls && summary.recentCalls.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Recent calls</Text>
            <Text style={styles.sectionCaption}>
              Number, date &amp; time, and how long each call lasted.
            </Text>
            <View style={styles.callsCard}>
              {summary.recentCalls.map((call, idx) => {
                const meta = callTypeMeta(call.type);
                const connected =
                  call.type !== 'missed' && call.type !== 'rejected';
                return (
                  <View
                    key={`${call.ts}_${idx}`}
                    style={[
                      styles.callRow,
                      idx > 0 && styles.callRowBordered,
                    ]}
                  >
                    <Icon name={meta.icon} size={18} color={meta.color} />
                    <View style={styles.callBody}>
                      <Text style={styles.callType}>{meta.label}</Text>
                      <Text style={styles.callWhen}>
                        {formatShortDateTime(call.ts) || '—'}
                      </Text>
                    </View>
                    <Text style={styles.callDuration}>
                      {connected ? formatDuration(call.durationSec) : meta.label}
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

        <Text style={styles.sectionTitle}>Groups</Text>
        <Text style={styles.sectionCaption}>
          Tap to add or remove this person. Groups live inside a category — a person can be in multiple.
        </Text>
        {CATEGORIES.map((cat) => {
          const groupsInCat = allGroups.filter((g) => g.categoryId === cat.id);
          if (groupsInCat.length === 0) return null;
          return (
            <View key={cat.id} style={styles.categoryBlock}>
              <Text style={[styles.categoryLabel, { color: cat.color }]}>
                {cat.name}
              </Text>
              <View style={styles.pillsWrap}>
                {groupsInCat.map((g) => (
                  <GroupPill
                    key={g.id}
                    group={g}
                    selected={contactGroupIds.has(g.id)}
                    onPress={() => onToggleGroup(g.id)}
                  />
                ))}
              </View>
            </View>
          );
        })}

        <View style={styles.notesHeader}>
          <Text style={styles.sectionTitle}>Notes</Text>
          {noteValue ? (
            <View style={styles.savedBadge}>
              <Icon
                name="check-circle"
                size={14}
                color={theme.colors.success}
              />
              <Text style={styles.savedText}>Saved</Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.sectionCaption, styles.sectionCaptionItalic]}>
          Saves automatically as you type — no need to tap anything.
        </Text>
        <TextInput
          style={styles.noteInput}
          value={noteValue}
          onChangeText={saveNote}
          placeholder="e.g. Loves long-form podcasts, asked me to introduce her to Ravi"
          placeholderTextColor={theme.colors.textSubtle}
          multiline
        />
      </ScrollView>
      </ConnectSetupGate>
    </View>
  );
};

const Meta = ({ label, value }) => (
  <View style={styles.metaCell}>
    <Text style={styles.metaValue}>{value}</Text>
    <Text style={styles.metaLabel}>{label}</Text>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  muted: { color: theme.colors.textMuted },

  heroCard: {
    margin: theme.spacing.lg,
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: theme.spacing.xs },
  statusText: {
    marginLeft: theme.spacing.xs,
    color: theme.colors.accent,
    fontWeight: '700',
    fontSize: theme.font.small,
  },
  reason: {
    fontSize: theme.font.h3,
    color: theme.colors.text,
    lineHeight: 24,
  },
  heroActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: theme.spacing.md,
  },
  primaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    marginRight: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  primaryActionText: {
    color: theme.colors.surface,
    fontWeight: '700',
    marginLeft: theme.spacing.xs,
  },
  secondaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    marginRight: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  secondaryActionText: {
    color: theme.colors.primary,
    fontWeight: '600',
    marginLeft: theme.spacing.xs,
  },
  secondaryActionActive: {
    backgroundColor: theme.colors.primary,
  },
  secondaryActionActiveText: {
    color: theme.colors.surface,
  },
  suppressedHint: {
    marginTop: theme.spacing.sm,
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    fontStyle: 'italic',
  },

  metaCard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: theme.spacing.lg,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  metaCell: { width: '33%', paddingVertical: theme.spacing.sm },
  metaValue: {
    fontSize: theme.font.body,
    fontWeight: '700',
    color: theme.colors.text,
  },
  metaLabel: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    marginTop: 2,
  },

  sectionTitle: {
    marginTop: theme.spacing.xl,
    marginHorizontal: theme.spacing.lg,
    fontSize: theme.font.h3,
    fontWeight: '700',
    color: theme.colors.text,
  },
  callsCard: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
  },
  callRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
  },
  callRowBordered: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  callBody: {
    flex: 1,
    marginLeft: theme.spacing.md,
  },
  callType: {
    fontSize: theme.font.small,
    fontWeight: '600',
    color: theme.colors.text,
  },
  callWhen: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    marginTop: 1,
  },
  callDuration: {
    fontSize: theme.font.small,
    fontWeight: '600',
    color: theme.colors.textMuted,
    marginLeft: theme.spacing.sm,
  },
  sectionCaption: {
    marginHorizontal: theme.spacing.lg,
    color: theme.colors.textMuted,
    fontSize: theme.font.small,
    marginTop: 2,
  },
  sectionCaptionItalic: {
    fontStyle: 'italic',
  },
  notesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginRight: theme.spacing.lg,
  },
  savedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: theme.spacing.xl,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    backgroundColor: 'rgba(60, 157, 106, 0.10)',
    borderRadius: theme.radius.pill,
  },
  savedText: {
    marginLeft: 4,
    color: theme.colors.success,
    fontSize: theme.font.tiny,
    fontWeight: '700',
  },
  pillsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.xs,
  },
  categoryBlock: {
    marginTop: theme.spacing.md,
  },
  categoryLabel: {
    marginHorizontal: theme.spacing.lg,
    fontSize: theme.font.small,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  noteInput: {
    minHeight: 100,
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    textAlignVertical: 'top',
    fontSize: theme.font.body,
  },
});

export default ContactDetailScreen;
