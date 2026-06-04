import React, { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
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
import {
  getActiveLlmProvider,
  getLlmKeys,
  LLM_PROVIDERS,
  LLM_PROVIDER_META,
  setActiveLlmProvider,
  setLlmKeyForProvider,
} from '../storage';

/**
 * Multi-provider LLM key modal. Stores one key per provider (Google AI
 * Studio, OpenAI, OpenRouter) and tracks which one is active — the active
 * provider is what categorisation actually calls. The user can paste keys
 * for multiple providers without losing the others, then switch the active
 * one at any time.
 *
 *   - `errorMessage` shows a red banner above the body (used when the LLM
 *     call came back with an auth failure so the user knows which key to
 *     fix).
 *   - `onSaved` fires after Save when at least one key was persisted.
 *   - `showLocalOption` (default false) renders the "Use local heuristics
 *     anyway" escape hatch. ONLY set true on the Settings surface — Groups
 *     should never give the user this opt-out, since the first-run flow is
 *     LLM-only by design.
 *   - `onUseLocal` is the handler fired when the user taps that option.
 */
const LlmKeyModal = ({
  visible,
  onClose,
  title = 'LLM keys',
  body = 'Configure one or more provider keys. The active one runs categorisation. Stored only on this device.',
  errorMessage,
  onSaved,
  showLocalOption = false,
  onUseLocal,
  useLocalLabel = 'Use local heuristics',
}) => {
  // Local drafts of each provider's key. We commit them to storage on Save
  // (not on every keystroke) so the user can cancel without persisting.
  const [drafts, setDrafts] = useState({});
  const [active, setActive] = useState(null);
  const [secure, setSecure] = useState({});

  useEffect(() => {
    if (visible) {
      const keys = getLlmKeys();
      setDrafts({ ...keys });
      setActive(getActiveLlmProvider());
      // Default every input to hidden each time the modal opens.
      setSecure(Object.fromEntries(LLM_PROVIDERS.map((p) => [p, true])));
    }
  }, [visible]);

  const providersWithKey = useMemo(
    () => LLM_PROVIDERS.filter((p) => (drafts[p] || '').trim()),
    [drafts],
  );

  const onSave = () => {
    LLM_PROVIDERS.forEach((p) => {
      const next = (drafts[p] || '').trim();
      setLlmKeyForProvider(p, next || null);
    });
    // If the user picked an active provider that has a key, persist it.
    // Otherwise let the storage layer auto-pick the first configured one.
    if (active && providersWithKey.includes(active)) {
      setActiveLlmProvider(active);
    } else if (providersWithKey.length) {
      setActiveLlmProvider(providersWithKey[0]);
    } else {
      setActiveLlmProvider(null);
    }
    if (onSaved) onSaved();
    onClose();
  };

  const updateDraft = (provider, value) => {
    setDrafts((prev) => ({ ...prev, [provider]: value }));
    // If the user just typed the first character into a previously empty
    // provider, make it active so Save doesn't no-op silently.
    if (value && (!active || !providersWithKey.includes(active))) {
      setActive(provider);
    }
  };

  const toggleSecure = (provider) => {
    setSecure((prev) => ({ ...prev, [provider]: !prev[provider] }));
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.card}>
            <Text style={styles.title}>{title}</Text>
            {errorMessage ? (
              <View style={styles.errorBanner}>
                <Icon
                  name="alert-circle-outline"
                  size={16}
                  color={theme.colors.danger}
                />
                <Text style={styles.errorText}>{errorMessage}</Text>
              </View>
            ) : null}
            <Text style={styles.body}>{body}</Text>

            {LLM_PROVIDERS.map((provider) => {
              const meta = LLM_PROVIDER_META[provider];
              const value = drafts[provider] || '';
              const hasKey = Boolean(value.trim());
              const isActive = active === provider && hasKey;
              return (
                <View key={provider} style={styles.providerBlock}>
                  <TouchableOpacity
                    style={styles.providerHeader}
                    onPress={() => hasKey && setActive(provider)}
                    activeOpacity={hasKey ? 0.7 : 1}
                  >
                    <View
                      style={[
                        styles.radio,
                        isActive && styles.radioActive,
                        !hasKey && styles.radioDisabled,
                      ]}
                    >
                      {isActive ? <View style={styles.radioDot} /> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.providerLabel}>{meta.label}</Text>
                      <Text style={styles.providerHint}>{meta.hint}</Text>
                    </View>
                    {isActive ? (
                      <Text style={styles.activeBadge}>Active</Text>
                    ) : null}
                  </TouchableOpacity>
                  <View style={styles.inputRow}>
                    <TextInput
                      style={styles.inputField}
                      value={value}
                      onChangeText={(t) => updateDraft(provider, t)}
                      placeholder={meta.placeholder}
                      placeholderTextColor={theme.colors.textSubtle}
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry={secure[provider] !== false}
                    />
                    <TouchableOpacity
                      onPress={() => toggleSecure(provider)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={styles.eyeBtn}
                    >
                      <Icon
                        name={secure[provider] !== false ? 'eye-outline' : 'eye-off-outline'}
                        size={20}
                        color={theme.colors.textMuted}
                      />
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity onPress={() => Linking.openURL(meta.docsUrl)}>
                    <Text style={styles.linkText}>Get a key from {meta.label}</Text>
                  </TouchableOpacity>
                </View>
              );
            })}

            {showLocalOption && onUseLocal ? (
              <TouchableOpacity
                onPress={() => {
                  onClose();
                  onUseLocal();
                }}
                style={styles.useLocalRow}
              >
                <Text style={styles.useLocalText}>{useLocalLabel}</Text>
              </TouchableOpacity>
            ) : null}

            <View style={styles.btnRow}>
              <TouchableOpacity
                onPress={onClose}
                style={[styles.btn, styles.btnSecondary]}
              >
                <Text style={styles.btnSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onSave}
                style={[styles.btn, styles.btnPrimary]}
              >
                <Text style={styles.btnPrimaryText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: theme.spacing.xl,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.xl,
  },
  title: {
    fontSize: theme.font.h2,
    fontWeight: '700',
    color: theme.colors.text,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
  },
  body: {
    fontSize: theme.font.body,
    color: theme.colors.textMuted,
    lineHeight: 21,
    marginBottom: theme.spacing.md,
  },
  providerBlock: {
    marginBottom: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  providerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
  },
  providerLabel: {
    fontSize: theme.font.body,
    fontWeight: '700',
    color: theme.colors.text,
  },
  providerHint: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    marginTop: 2,
    lineHeight: 16,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.md,
  },
  radioActive: {
    borderColor: theme.colors.primary,
  },
  radioDisabled: {
    opacity: 0.4,
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.primary,
  },
  activeBadge: {
    fontSize: theme.font.tiny,
    color: theme.colors.primary,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingRight: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  inputField: {
    flex: 1,
    paddingVertical: theme.spacing.sm,
    fontSize: theme.font.body,
    color: theme.colors.text,
  },
  eyeBtn: {
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: 4,
  },
  linkText: {
    color: theme.colors.primary,
    fontSize: theme.font.small,
    textDecorationLine: 'underline',
    marginTop: theme.spacing.xs,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(176, 70, 60, 0.10)',
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  errorText: {
    flex: 1,
    marginLeft: theme.spacing.xs,
    fontSize: theme.font.small,
    color: theme.colors.danger,
    lineHeight: 18,
  },
  useLocalRow: {
    marginTop: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  useLocalText: {
    color: theme.colors.textMuted,
    fontWeight: '600',
    fontSize: theme.font.small,
    textDecorationLine: 'underline',
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

export default LlmKeyModal;
