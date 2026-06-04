import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import { getUserProfile, setUserProfile } from '../storage';

const listToText = (list) => (Array.isArray(list) ? list.join(', ') : '');

// Splits the user's free-text entry into a clean list. Commas, newlines, and
// the Hindi-style enumeration character "·" all count as separators so users
// can paste from notes without rewriting.
const textToList = (text) =>
  (text || '')
    .split(/[,\n·]/g)
    .map((s) => s.trim())
    .filter(Boolean);

const FIELDS = [
  {
    key: 'schools',
    label: 'Schools',
    icon: 'school-outline',
    hint:
      'Comma-separated. We auto-match obvious short forms ("Delhi Public School" already catches "DPS"). Only add "/aliases" for non-obvious ones.',
    placeholder: 'Delhi Public School, KV Pune',
    isList: true,
  },
  {
    key: 'colleges',
    label: 'Colleges & universities',
    icon: 'book-open-variant',
    hint:
      'Comma-separated. Obvious short forms ("IITB", "IIMB") are matched automatically. Add "/aliases" only if your shortform is uncommon.',
    placeholder: 'IIT Bombay, IIM Bangalore',
    isList: true,
  },
  {
    key: 'workplaces',
    label: 'Workplaces',
    icon: 'briefcase-outline',
    hint:
      'Past and present, comma-separated. We auto-match substring shortforms ("Finmechanics" already catches "Finmech"). Only add "/FM" if you save contacts that way.',
    placeholder: 'Finmechanics, theNB/NT, Stripe',
    isList: true,
  },
  {
    key: 'placesStayed',
    label: 'Places you have lived',
    icon: 'map-marker-outline',
    hint: 'Cities or neighborhoods. Comma-separated.',
    placeholder: 'Mumbai, Bangalore HSR, Goa',
    isList: true,
  },
  {
    key: 'savingLogic',
    label: 'Notes on how you save contacts',
    icon: 'note-text-outline',
    hint:
      'Quirks the LLM should know — e.g. "I save relatives as <relation> <name>", "office contacts get a · suffix".',
    placeholder:
      'I prefix family with their relation. Helpers get a role suffix like "Driver", "Maid".',
    isList: false,
  },
];

/**
 * Lightweight onboarding form for the user's "about me" facts that the
 * categorisation prompt uses to name groups accurately. Every field is
 * optional. Save commits to MMKV via setUserProfile; Skip closes without
 * touching storage. Both fire `onClose` so callers can advance their step
 * state regardless of which path the user took.
 *
 *   - `onSaved(profile)` fires only on a successful save with the persisted
 *     payload, so callers can refresh memoised reads.
 *   - `onSkipped()` fires when the user dismisses without saving.
 */
const UserContextModal = ({ visible, onClose, onSaved, onSkipped }) => {
  const [drafts, setDrafts] = useState({
    schools: '',
    colleges: '',
    workplaces: '',
    placesStayed: '',
    savingLogic: '',
  });

  useEffect(() => {
    if (!visible) return;
    const profile = getUserProfile();
    setDrafts({
      schools: listToText(profile.schools),
      colleges: listToText(profile.colleges),
      workplaces: listToText(profile.workplaces),
      placesStayed: listToText(profile.placesStayed),
      savingLogic: profile.savingLogic || '',
    });
  }, [visible]);

  const onChange = (key) => (text) => {
    setDrafts((cur) => ({ ...cur, [key]: text }));
  };

  const onSave = () => {
    const payload = {
      schools: textToList(drafts.schools),
      colleges: textToList(drafts.colleges),
      workplaces: textToList(drafts.workplaces),
      placesStayed: textToList(drafts.placesStayed),
      savingLogic: drafts.savingLogic.trim(),
    };
    setUserProfile(payload);
    onSaved?.(payload);
    onClose?.();
  };

  const onSkip = () => {
    onSkipped?.();
    onClose?.();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onSkip}
    >
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          style={styles.kbWrap}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.card}>
            <View style={styles.iconRow}>
              <View style={styles.iconWrap}>
                <Icon
                  name="account-question-outline"
                  size={28}
                  color={theme.colors.primary}
                />
              </View>
            </View>
            <Text style={styles.title}>Tell us about you</Text>
            <Text style={styles.body}>
              A few quick facts so the LLM can name your groups correctly —
              "IIT-B friends" instead of "Cluster IITB". All optional, all
              stored locally.
            </Text>

            <ScrollView
              style={styles.formScroll}
              contentContainerStyle={styles.formContent}
              keyboardShouldPersistTaps="handled"
            >
              {FIELDS.map((f) => (
                <View key={f.key} style={styles.field}>
                  <View style={styles.fieldLabelRow}>
                    <Icon
                      name={f.icon}
                      size={16}
                      color={theme.colors.primary}
                      style={styles.fieldLabelIcon}
                    />
                    <Text style={styles.fieldLabel}>{f.label}</Text>
                  </View>
                  <Text style={styles.fieldHint}>{f.hint}</Text>
                  <TextInput
                    style={[styles.input, !f.isList && styles.inputMulti]}
                    value={drafts[f.key]}
                    onChangeText={onChange(f.key)}
                    placeholder={f.placeholder}
                    placeholderTextColor={theme.colors.textSubtle}
                    autoCapitalize="words"
                    autoCorrect={false}
                    multiline={!f.isList}
                  />
                </View>
              ))}
            </ScrollView>

            <View style={styles.btnRow}>
              <TouchableOpacity
                onPress={onSkip}
                style={[styles.btn, styles.btnSecondary]}
              >
                <Text style={styles.btnSecondaryText}>Skip</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onSave}
                style={[styles.btn, styles.btnPrimary]}
              >
                <Text style={styles.btnPrimaryText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: theme.spacing.lg,
  },
  kbWrap: { width: '100%' },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.xl,
    maxHeight: '92%',
  },
  iconRow: {
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.chipBg,
  },
  title: {
    fontSize: theme.font.h2,
    fontWeight: '700',
    color: theme.colors.text,
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
  body: {
    fontSize: theme.font.body,
    color: theme.colors.textMuted,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
  },
  formScroll: {
    maxHeight: 380,
  },
  formContent: {
    paddingBottom: theme.spacing.sm,
  },
  field: {
    marginBottom: theme.spacing.md,
  },
  fieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  fieldLabelIcon: { marginRight: theme.spacing.xs },
  fieldLabel: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
  },
  fieldHint: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
    marginBottom: theme.spacing.xs,
    lineHeight: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontSize: theme.font.body,
    color: theme.colors.text,
    backgroundColor: theme.colors.surface,
  },
  inputMulti: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  btnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: theme.spacing.md,
  },
  btn: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm + 2,
    borderRadius: theme.radius.pill,
    marginLeft: theme.spacing.sm,
  },
  btnPrimary: { backgroundColor: theme.colors.primary },
  btnPrimaryText: { color: theme.colors.surface, fontWeight: '700' },
  btnSecondary: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  btnSecondaryText: { color: theme.colors.textMuted, fontWeight: '600' },
});

export default UserContextModal;
