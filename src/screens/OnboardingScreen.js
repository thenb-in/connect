import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
  StatusBar,
  TextInput,
  ScrollView,
  Linking,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import {
  refreshAnalysis,
  requestImportPermissions,
} from '../engine/analysisService';
import {
  setOnboarded,
  setSetupCompleted,
  getPermsState,
  getLlmConfig,
  hasLlmKey,
  setLlmConfig,
  hasUserProfile,
  LLM_PROVIDERS,
  LLM_PROVIDER_META,
} from '../storage';
import CategoriseProposalModal from '../components/CategoriseProposalModal';
import UserContextModal from '../components/UserContextModal';
import { useRecategorise } from '../hooks/useRecategorise';

// Single source of truth for badge appearance per step state. Maps a state
// to its background color and the badge glyph factory; the index is only
// used when there's no specific glyph (the pending case). Keeps badge logic
// declarative instead of a nested ternary stack.
const STEP_BADGE = {
  granted: {
    color: theme.colors.success,
    glyph: ({ scale }) => (
      <Icon name="check" size={Math.round(15 * scale)} color={theme.colors.surface} />
    ),
  },
  skipped: {
    color: theme.colors.textSubtle,
    glyph: ({ scale }) => (
      <Icon name="minus" size={Math.round(15 * scale)} color={theme.colors.surface} />
    ),
  },
  awaiting_review: {
    color: theme.colors.primary,
    glyph: ({ scale }) => (
      <Icon name="eye-outline" size={Math.round(15 * scale)} color={theme.colors.surface} />
    ),
  },
  running: {
    color: theme.colors.primary,
    glyph: () => <ActivityIndicator size="small" color={theme.colors.surface} />,
  },
  denied: {
    color: theme.colors.warning,
    glyph: ({ index }) => <Text style={styles.stepBadgeText}>{index}</Text>,
  },
};
const STEP_BADGE_PENDING = {
  color: theme.colors.textSubtle,
  glyph: ({ index }) => <Text style={styles.stepBadgeText}>{index}</Text>,
};

const Step = ({ index, icon, title, body, state, scale }) => {
  const badge = STEP_BADGE[state] || STEP_BADGE_PENDING;
  const badgeSize = Math.round(24 * scale);
  return (
    <View style={styles.step}>
      <View
        style={[
          styles.stepBadge,
          {
            backgroundColor: badge.color,
            width: badgeSize,
            height: badgeSize,
            borderRadius: badgeSize / 2,
          },
        ]}
      >
        {badge.glyph({ scale, index })}
      </View>
      <View style={styles.stepBody}>
        <View style={styles.stepTitleRow}>
          <Icon
            name={icon}
            size={Math.round(17 * scale)}
            color={theme.colors.primary}
            style={styles.stepTitleIcon}
          />
          <Text style={styles.stepTitle}>{title}</Text>
        </View>
        <Text style={styles.stepText}>{body}</Text>
      </View>
    </View>
  );
};

/**
 * First-time Connect Mode setup. Walks the user through:
 *   1. Importing contacts (+ Android call history).
 *   2. Adding an optional LLM key for smart categorisation.
 *   3. Running the relationship analysis + categorisation.
 *
 * The LLM step is skippable — the user can come back to it from Settings.
 */
const OnboardingScreen = ({ navigation, onFinished }) => {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scale = Math.min(Math.max(height / 780, 0.85), 1.15);
  const isCompact = height < 700;
  const heroSize = Math.round((isCompact ? 84 : 104) * scale);
  const heroIconSize = Math.round(heroSize * 0.6);
  const sectionGap = Math.round((isCompact ? 16 : 24) * scale);

  const initialPerms = getPermsState();
  const initialLlm = getLlmConfig();
  const [perms, setPerms] = useState({
    contacts: initialPerms.contacts,
    callLog: initialPerms.callLog,
  });
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [done, setDone] = useState(false);

  // LLM step state.
  const [llmProvider, setLlmProvider] = useState(initialLlm.provider || 'google');
  const [llmKey, setLlmKey] = useState(initialLlm.key || '');
  const [llmState, setLlmState] = useState(
    initialLlm.key ? 'granted' : 'pending',
  );

  // User-context step state. The modal shows the same form whether the user
  // is filling it for the first time or editing an existing profile — the
  // pending → granted/skipped transition gates the Analyse button so the
  // user gets a chance to fill it before clustering runs.
  const [contextOpen, setContextOpen] = useState(false);
  const [contextState, setContextState] = useState(
    hasUserProfile() ? 'granted' : 'pending',
  );

  // Auto-scroll the page when the LLM card appears so the user doesn't have
  // to hunt for it after granting permissions.
  const scrollRef = useRef(null);

  const handleAllow = async () => {
    setLoading(true);
    try {
      // requestImportPermissions now normalises and persists the perms shape
      // to MMKV itself, so we just mirror the result into local state.
      const result = await requestImportPermissions();
      setPerms(result.perms);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveKey = () => {
    const trimmed = (llmKey || '').trim();
    if (!trimmed) return;
    setLlmConfig(llmProvider, trimmed);
    setLlmState('granted');
  };

  const handleSkipKey = () => {
    setLlmState('skipped');
  };

  // Per-stage progress for the cluster + analyse steps so the user sees each
  // one tick from pending → running → awaiting_review → granted as the work
  // happens. `awaiting_review` is the new staged sub-state introduced when
  // onboarding switched to the shared propose+review flow — same modal that
  // Settings and Groups use, so the user gets one consistent experience
  // regardless of entry point.
  const [progress, setProgress] = useState({ cluster: 'pending', analyse: 'pending' });

  // The hook owns the LLM call, the proposal state, the LLM-key prompt, and
  // the apply-on-confirm step — shared with Settings/Groups so all three
  // entry points run the same flow.
  const {
    startCategorise,
    pendingProposal,
    applyEditedProposal,
    dismissProposal,
    categorising,
  } = useRecategorise();

  // Stage 3: full relationship analysis using contacts + call log + the
  // groups we just (maybe) created. Pulled out so it can be reached from
  // both the LLM-key path (after the user closes the proposal modal) and
  // the no-LLM-key path (immediately).
  const finishOnboarding = useCallback(async () => {
    setProgress((p) => ({ ...p, analyse: 'running' }));
    await refreshAnalysis({
      refreshContacts: false,
      refreshCallLogs: perms.callLog === 'granted',
    });
    setProgress((p) => ({ ...p, analyse: 'granted' }));

    setOnboarded(true);
    setSetupCompleted(true);
    setDone(true);
    setAnalyzing(false);
  }, [perms.callLog]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    // Stage 1: import contacts so the clusterer has data to work with.
    // We deliberately skip the call log here to keep the cluster step fast;
    // the analyse stage below picks it up.
    setProgress({ cluster: 'running', analyse: 'pending' });
    await refreshAnalysis({
      refreshContacts: perms.contacts === 'granted',
      refreshCallLogs: false,
    });

    // Stage 2: cluster the imported contacts. With an LLM key we propose
    // groups and let the user review/edit them in the same modal Settings
    // and Groups use. Without a key, skip and proceed straight to analyse —
    // local heuristics alone are too rough for an unattended onboarding step.
    if (hasLlmKey()) {
      // fire-and-forget: the hook drives the modal lifecycle from here.
      // The proposal-watching effect below picks up the next state.
      startCategorise({ allowNewGroups: true });
    } else {
      setProgress((p) => ({ ...p, cluster: 'skipped' }));
      await finishOnboarding();
    }
  };

  // Watches the categorisation hook. When the LLM call settles, either we
  // have a proposal to review (modal opens, cluster → awaiting_review) or an
  // error path already fired its alert (no modal, cluster → skipped, fall
  // through to stage 3).
  const wasCategorisingRef = useRef(false);
  useEffect(() => {
    const justFinished = wasCategorisingRef.current && !categorising;
    wasCategorisingRef.current = categorising;
    if (!justFinished) return;
    if (pendingProposal) {
      setProgress((p) => ({ ...p, cluster: 'awaiting_review' }));
    } else if (progress.cluster === 'running') {
      setProgress((p) => ({ ...p, cluster: 'skipped' }));
      finishOnboarding();
    }
  }, [categorising, pendingProposal, progress.cluster, finishOnboarding]);

  const onApplyProposal = useCallback(
    (editedGroups, { isEdited, allowNewGroups } = {}) => {
      applyEditedProposal(editedGroups, { mode: 'apply' });
      // When the user changed the group skeleton during an unconstrained
      // run, fire a constrained re-run instead of finishing onboarding.
      // The categorising effect above will flip cluster back to
      // 'awaiting_review' once the constrained proposal lands, and this
      // callback runs again when the user applies that one.
      if (isEdited && allowNewGroups) {
        startCategorise({ allowNewGroups: false });
        return;
      }
      setProgress((p) => ({ ...p, cluster: 'granted' }));
      finishOnboarding();
    },
    [applyEditedProposal, startCategorise, finishOnboarding],
  );

  const onCancelProposal = useCallback(() => {
    dismissProposal();
    setProgress((p) => ({ ...p, cluster: 'skipped' }));
    finishOnboarding();
  }, [dismissProposal, finishOnboarding]);

  // On iOS the engine has very little to chew on without a call log AND
  // without an LLM key — there's no "lost connections" lane to compute and no
  // smart grouping to run. Once contacts are granted and the user has
  // explicitly skipped the LLM step, fire `handleAnalyze` automatically so
  // they land straight in Connect Home instead of staring at an Analyse
  // button that has nothing meaningful to do.
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (autoFiredRef.current) return;
    if (done || analyzing) return;
    if (perms.contacts !== 'granted') return;
    if (llmState !== 'skipped') return;
    // Wait for the user to either fill or skip the context step so we don't
    // skip past it on iOS.
    if (contextState === 'pending') return;
    autoFiredRef.current = true;
    handleAnalyze();
  }, [perms.contacts, llmState, contextState, done, analyzing]);

  const handleEnter = () => {
    if (onFinished) onFinished();
    else if (navigation?.replace) navigation.replace('ConnectHome');
  };

  const permsReady =
    perms.contacts === 'granted' &&
    (perms.callLog === 'granted' ||
      perms.callLog === 'unsupported' ||
      perms.callLog === 'denied');

  // The "Analyse" button only lights up once the user has either saved a key
  // or explicitly skipped the LLM step. Defaults to skipped if a key already
  // exists from a previous session.
  const llmReady = llmState !== 'pending';
  const contextReady = contextState !== 'pending';

  const canAnalyze = permsReady && llmReady && contextReady;

  const providerMeta = LLM_PROVIDER_META[llmProvider] || LLM_PROVIDER_META.google;

  useEffect(() => {
    // Once the user has granted permissions, the next interactive card (LLM
    // key, then user context) is what they need next — scroll the page so
    // it's visible without them hunting for it.
    if (permsReady && (!llmReady || !contextReady)) {
      const t = setTimeout(() => {
        scrollRef.current?.scrollToEnd?.({ animated: true });
      }, 150);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [permsReady, llmReady, contextReady]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar
        barStyle="dark-content"
        backgroundColor={theme.colors.background}
      />
      <KeyboardAvoidingView
        style={styles.kbWrap}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.container,
          { paddingHorizontal: Math.round(width * 0.06), paddingBottom: sectionGap },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.header, { paddingTop: insets.top + Math.round(sectionGap / 2) }]}>
          <View
            style={[
              styles.heroIconWrap,
              {
                width: heroSize,
                height: heroSize,
                borderRadius: heroSize / 2,
              },
            ]}
          >
            <Icon
              name="account-heart"
              size={heroIconSize}
              color={theme.colors.primary}
            />
          </View>
          <Text style={styles.title}>Welcome to Connect</Text>
          <Text style={styles.subtitle}>
            A calmer way to stay in touch with the people who matter — friends,
            family, mentors, founders, alumni. We help you find who is worth
            reaching out to today.
          </Text>
          <View style={styles.privacyPill}>
            <Icon
              name="shield-lock-outline"
              size={12}
              color={theme.colors.textMuted}
              style={styles.privacyIcon}
            />
            <Text style={styles.privacyText}>
              Everything stays on your device. Nothing is uploaded.
            </Text>
          </View>
        </View>

        <View style={styles.bodyWrap}>
          {(() => {
            // iOS doesn't expose call logs, so the call-history step is just
            // noise — hide it. When the user has also explicitly skipped the
            // LLM key, the analyse-runs-on-confirm UX kicks in (see effect
            // above) so the Cluster + Analyse steps are hidden until the
            // work fires.
            const showCallLogStep = Platform.OS === 'android';
            const showWorkSteps =
              Platform.OS === 'android' || llmState !== 'skipped';
            const clusterBody =
              progress.cluster === 'awaiting_review'
                ? 'Review the proposed groups in the popup. Remove, rename, or add groups before applying.'
                : llmState === 'granted'
                ? 'Group your contacts with the LLM into Friends, Office, Family, ….'
                : 'Skipped — add an LLM key and run "Re-categorise contacts" from Settings any time.';
            // Declarative step list. Build it once, filter out hidden steps,
            // then number sequentially. Beats a mutable `let n = 1; n++;`
            // counter sprinkled through 6 conditional JSX blocks.
            const stepDefs = [
              {
                icon: 'contacts',
                title: 'Import contacts',
                body: 'So we know who you might want to reconnect with.',
                state: perms.contacts,
              },
              showCallLogStep && {
                icon: 'phone-log',
                title: 'Read call history',
                body: 'Used purely to spot communication patterns — no audio or content is read.',
                state: perms.callLog,
              },
              {
                icon: 'creation',
                title: 'LLM key (optional)',
                body: 'Lets us auto-group contacts into Friends, Office, Family, …. You can add it later from Settings.',
                state: llmState,
              },
              {
                icon: 'account-question-outline',
                title: 'Tell us about you (optional)',
                body: 'A few quick facts — schools, colleges, workplaces, places lived — so the LLM names groups correctly. Always skippable.',
                state: contextState,
              },
              showWorkSteps && {
                icon: 'account-group-outline',
                title: 'Cluster contacts',
                body: clusterBody,
                state: progress.cluster,
              },
              showWorkSteps && {
                icon: 'lightbulb-on-outline',
                title: 'Analyse relationships',
                body: 'Surface dormant friendships, lost connections, and group the people you care about.',
                state: progress.analyse,
              },
            ].filter(Boolean);
            return (
              <View style={styles.steps}>
                {stepDefs.map((step, i) => (
                  <Step
                    key={step.title}
                    index={i + 1}
                    scale={scale}
                    icon={step.icon}
                    title={step.title}
                    body={step.body}
                    state={step.state}
                  />
                ))}
              </View>
            );
          })()}

          {permsReady && llmReady && !contextReady ? (
            <View style={styles.llmCard}>
              <Text style={styles.llmTitle}>Tell us about you</Text>
              <Text style={styles.llmBody}>
                Optional facts — schools, colleges, workplaces, places lived,
                quirks in how you save contacts. The LLM uses these to name
                your groups accurately ("IIT-B friends" instead of
                "Cluster IITB"). Stored only on this device.
              </Text>
              <View style={styles.llmBtnRow}>
                <TouchableOpacity
                  style={[styles.llmBtn, styles.llmBtnSecondary]}
                  onPress={() => setContextState('skipped')}
                >
                  <Text style={styles.llmBtnSecondaryText}>Skip for now</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.llmBtn, styles.llmBtnPrimary]}
                  onPress={() => setContextOpen(true)}
                >
                  <Text style={styles.llmBtnPrimaryText}>Tell us</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {permsReady && !llmReady ? (
            <View style={styles.llmCard}>
              <Text style={styles.llmTitle}>Smart categorisation</Text>
              <Text style={styles.llmBody}>
                Drop in a key from Google AI Studio or OpenAI and we'll cluster
                your contacts into groups like "College friends" or
                "Acme colleagues". You can always do this later.
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.providerRow}
                contentContainerStyle={styles.providerRowContent}
              >
                {LLM_PROVIDERS.map((p) => (
                  <TouchableOpacity
                    key={p}
                    onPress={() => setLlmProvider(p)}
                    style={[
                      styles.providerChip,
                      llmProvider === p && styles.providerChipSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.providerChipText,
                        llmProvider === p && styles.providerChipTextSelected,
                      ]}
                    >
                      {LLM_PROVIDER_META[p].label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TextInput
                style={styles.input}
                value={llmKey}
                onChangeText={setLlmKey}
                placeholder={providerMeta.placeholder}
                placeholderTextColor={theme.colors.textSubtle}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <TouchableOpacity onPress={() => Linking.openURL(providerMeta.docsUrl)}>
                <Text style={styles.llmHelp}>Get a key from {providerMeta.label}</Text>
              </TouchableOpacity>

              <View style={styles.llmBtnRow}>
                <TouchableOpacity
                  style={[styles.llmBtn, styles.llmBtnSecondary]}
                  onPress={handleSkipKey}
                >
                  <Text style={styles.llmBtnSecondaryText}>Skip for now</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.llmBtn,
                    styles.llmBtnPrimary,
                    !llmKey.trim() && styles.btnDisabled,
                  ]}
                  disabled={!llmKey.trim()}
                  onPress={handleSaveKey}
                >
                  <Text style={styles.llmBtnPrimaryText}>Save key</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          <View style={[styles.actions, { marginBottom: sectionGap }]}>
          {!permsReady ? (
            <TouchableOpacity
              style={[styles.primaryBtn, loading && styles.btnDisabled]}
              disabled={loading}
              onPress={handleAllow}
            >
              {loading ? (
                <ActivityIndicator color={theme.colors.surface} />
              ) : (
                <Text style={styles.primaryBtnText}>Allow access</Text>
              )}
            </TouchableOpacity>
          ) : !canAnalyze ? null : !done ? (
            <TouchableOpacity
              style={[styles.primaryBtn, analyzing && styles.btnDisabled]}
              disabled={analyzing}
              onPress={handleAnalyze}
            >
              {analyzing ? (
                <ActivityIndicator color={theme.colors.surface} />
              ) : (
                <Text style={styles.primaryBtnText}>Analyse relationships</Text>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.primaryBtn} onPress={handleEnter}>
              <Text style={styles.primaryBtnText}>Enter Connect</Text>
            </TouchableOpacity>
          )}
          </View>
        </View>
      </ScrollView>
      </KeyboardAvoidingView>

      <CategoriseProposalModal
        visible={!!pendingProposal}
        proposal={pendingProposal}
        onApply={onApplyProposal}
        onCancel={onCancelProposal}
        showCustomise={false}
      />

      <UserContextModal
        visible={contextOpen}
        onClose={() => setContextOpen(false)}
        onSaved={() => setContextState('granted')}
        onSkipped={() => setContextState('skipped')}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: theme.colors.background },
  kbWrap: { flex: 1 },
  container: {
    flexGrow: 1,
  },
  header: { alignItems: 'center' },
  bodyWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  heroIconWrap: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  title: {
    fontSize: theme.font.h1,
    fontWeight: '700',
    color: theme.colors.text,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  subtitle: {
    marginTop: theme.spacing.sm,
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    textAlign: 'center',
    lineHeight: 19,
    paddingHorizontal: theme.spacing.lg,
    fontStyle: 'italic',
  },
  privacyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.chipBg,
  },
  privacyIcon: { marginRight: 4 },
  privacyText: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
  },
  steps: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    marginTop: theme.spacing.lg,
  },
  step: { flexDirection: 'row', marginBottom: theme.spacing.md },
  stepBadge: {
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.md,
    marginTop: 2,
  },
  stepBadgeText: {
    color: theme.colors.surface,
    fontWeight: '700',
    fontSize: theme.font.small,
  },
  stepBody: { flex: 1 },
  stepTitleRow: { flexDirection: 'row', alignItems: 'center' },
  stepTitleIcon: { marginRight: theme.spacing.sm },
  stepTitle: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
  },
  stepText: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    marginTop: 2,
    lineHeight: 18,
  },
  llmCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    marginTop: theme.spacing.lg,
  },
  llmTitle: {
    fontSize: theme.font.h3,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.xs,
  },
  llmBody: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    lineHeight: 19,
    marginBottom: theme.spacing.md,
  },
  providerRow: {
    marginBottom: theme.spacing.sm,
  },
  providerRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  providerChip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginRight: theme.spacing.sm,
  },
  providerChipSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  providerChipText: {
    fontSize: theme.font.small,
    color: theme.colors.text,
    fontWeight: '600',
  },
  providerChipTextSelected: { color: theme.colors.surface },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontSize: theme.font.body,
    color: theme.colors.text,
    marginBottom: theme.spacing.xs,
  },
  llmHelp: {
    fontSize: theme.font.tiny,
    color: theme.colors.primary,
    textDecorationLine: 'underline',
    marginBottom: theme.spacing.sm,
  },
  llmBtnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  llmBtn: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    marginLeft: theme.spacing.sm,
  },
  llmBtnPrimary: { backgroundColor: theme.colors.primary },
  llmBtnPrimaryText: { color: theme.colors.surface, fontWeight: '700' },
  llmBtnSecondary: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  llmBtnSecondaryText: { color: theme.colors.textMuted, fontWeight: '600' },
  actions: { alignItems: 'center', marginTop: theme.spacing.lg },
  primaryBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.xl,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.pill,
    minWidth: 240,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.6 },
  primaryBtnText: {
    color: theme.colors.surface,
    fontWeight: '700',
    fontSize: theme.font.body,
  },
});

export default OnboardingScreen;
