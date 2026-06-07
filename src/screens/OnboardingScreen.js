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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import {
  refreshAnalysis,
  requestImportPermissions,
} from '../engine/analysisService';
import {
  getOnboardingAcks,
  markOnboardingStep,
  getPermsState,
  getLlmConfig,
  hasLlmKey,
  setLlmConfig,
  hasUserProfile,
  getContacts,
  addContactsToGroup,
  ensureStandardGroups,
  getAdvancedMode,
  setAdvancedMode,
  setSelectedClusters,
  WANT_TO_CONNECT_GROUP_ID,
  LLM_PROVIDERS,
  LLM_PROVIDER_META,
} from '../storage';
import {
  applyProposal,
  buildCandidateClusters,
  isHelperContact,
} from '../engine/categorization';
import CategoriseProposalModal from '../components/CategoriseProposalModal';
import ClusterKeywordModal, {
  AUTO_SELECT_MIN_MEMBERS,
} from '../components/ClusterKeywordModal';
import ContactPickerModal from '../components/ContactPickerModal';
import UserContextModal from '../components/UserContextModal';
import { useRecategorise } from '../hooks/useRecategorise';

// A name-token cluster (e.g. "Cluster: Rao") vs a label cluster (Family,
// Helpers). Only the name-token ones are surfaced as user-pickable keywords —
// their ids carry the `cluster-` prefix from buildCandidateClusters.
const isNameTokenCluster = (c) => typeof c?.id === 'string' && c.id.startsWith('cluster-');

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
  // Resume snapshot from the onboarding step table (src/onboarding/steps.js).
  // We rehydrate the "Skip for now" decisions the user tapped on the LLM-key /
  // about-you steps so those cards don't re-nag after a restart. The welcome
  // splash is intentionally NOT resumed past (see `started` below) — onboarding
  // always reopens at welcome until the analysis finishes. The work stage
  // (cluster → choose-who → analyse) is a single live run with modals and async
  // LLM calls that can't survive a kill, so it restarts clean; only its terminal
  // `analysed` ack is persisted, written after the engine run succeeds. Acks are
  // cleared on a full data wipe / reset.
  const savedAcks = getOnboardingAcks();
  const [perms, setPerms] = useState({
    contacts: initialPerms.contacts,
    callLog: initialPerms.callLog,
  });
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [done, setDone] = useState(false);
  // True while the "Use defaults" path is running its non-interactive setup
  // (request perms → import → auto-cluster → analyse). Drives the same
  // "Setting up Connect…" overlay as `done`, but without the auto-enter timer.
  const [preparingDefaults, setPreparingDefaults] = useState(false);

  // First impression: a plain "Welcome to Connect" splash with a single Start
  // button. The setup steps (Advanced toggle, permissions, clustering, …) stay
  // hidden behind the header until the user taps Start, so they aren't dropped
  // straight into a wall of options. We always begin at the splash: this screen
  // only renders while onboarding is incomplete (the `analysed` step hasn't
  // run), and the rule is to restart from welcome until that analysis finishes —
  // a prior splash tap or a half-done permission grant doesn't skip it. Granted
  // permissions still show as done (derived), so re-running is one tap away.
  const [started, setStarted] = useState(false);

  // Latches true once clustering + the grouping review are done. The flow then
  // pauses back on the onboarding screen — the "Choose who to connect with"
  // picker only opens when the user taps Continue, rather than springing up on
  // its own the moment grouping finishes. Always starts false: this is work-
  // stage state, not resumed across a kill (see the savedAcks note above).
  const [clusterStageDone, setClusterStageDone] = useState(false);

  // Advanced mode opt-in (persisted). When off, onboarding is a quick import +
  // hand-pick; the LLM key, "tell us about you", clustering, and analysis
  // steps are hidden. Toggled via the tickbox on this screen and from Settings.
  const [advancedMode, setAdvancedModeState] = useState(() => getAdvancedMode());
  const toggleAdvancedMode = useCallback(() => {
    setAdvancedModeState((cur) => {
      const next = !cur;
      setAdvancedMode(next);
      return next;
    });
  }, []);

  // LLM step state.
  const [llmProvider, setLlmProvider] = useState(initialLlm.provider || 'google');
  const [llmKey, setLlmKey] = useState(initialLlm.key || '');
  // A saved key always wins (it's the source of truth); otherwise resume a
  // prior "Skip for now" decision so we don't re-prompt for a step the user
  // already dismissed.
  const [llmState, setLlmState] = useState(
    initialLlm.key
      ? 'granted'
      : savedAcks.llmKey
      ? 'skipped'
      : 'pending',
  );

  // User-context step state. The modal shows the same form whether the user
  // is filling it for the first time or editing an existing profile — the
  // pending → granted/skipped transition gates the Analyse button so the
  // user gets a chance to fill it before clustering runs.
  const [contextOpen, setContextOpen] = useState(false);
  const [contextState, setContextState] = useState(
    hasUserProfile()
      ? 'granted'
      : savedAcks.userContext
      ? 'skipped'
      : 'pending',
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
    markOnboardingStep('llmKey');
  };

  const handleSkipContext = () => {
    setContextState('skipped');
    markOnboardingStep('userContext');
  };

  // Per-stage progress for the cluster + analyse steps so the user sees each
  // one tick from pending → running → awaiting_review → granted as the work
  // happens. `awaiting_review` is the new staged sub-state introduced when
  // onboarding switched to the shared propose+review flow — same modal that
  // Settings and Groups use, so the user gets one consistent experience
  // regardless of entry point.
  // Work-stage progress. Always starts clean — an interrupted run restarts from
  // the "Analyse relationships" button rather than rehydrating half-done
  // sub-states (which would let a partially-run clustering step look complete).
  const [progress, setProgress] = useState({
    wantToConnect: 'pending',
    cluster: 'pending',
    analyse: 'pending',
  });

  // The hand-pick "Want to connect" step. After contacts import we open a
  // searchable picker so the user can seed their standard "Want to connect"
  // group before clustering/analysis run. `wantContacts` is snapshotted from
  // the freshly-imported list so the modal has data without re-reading MMKV.
  const [wantPickerOpen, setWantPickerOpen] = useState(false);
  const [wantContacts, setWantContacts] = useState([]);

  // The local clustering step (simple mode, or advanced without an LLM key).
  // `keywordClusters` are the name-token clusters surfaced for selection;
  // `keywordContacts` is the contact snapshot used to resolve member names in
  // the review modal; `localProposal` holds the picked clusters as a proposal
  // while the user runs the merge/delete review before they become groups.
  const [keywordModalOpen, setKeywordModalOpen] = useState(false);
  const [keywordClusters, setKeywordClusters] = useState([]);
  const [keywordContacts, setKeywordContacts] = useState([]);
  const [localProposal, setLocalProposal] = useState(null);

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
    try {
      const imported = await refreshAnalysis({
        refreshContacts: false,
        refreshCallLogs: perms.callLog === 'granted',
      });
      // If call-log access was granted but the import itself errored (silent
      // permission revoke, content-provider hiccup), the cache holds no call
      // log and Home's "Missed connections" lane would be empty. Treat that as
      // a failed setup: leave onboarding incomplete so the next launch returns
      // here to retry, rather than entering Connect with no data.
      if (perms.callLog === 'granted' && imported?.refreshError) {
        throw new Error(imported.refreshError);
      }
    } catch (err) {
      // Setup didn't complete — do NOT mark `analysed`. A kill or import error
      // before this point leaves the ack false, so reopening the app brings the
      // user back to onboarding instead of a half-set-up Home.
      setProgress((p) => ({ ...p, analyse: 'pending' }));
      setAnalyzing(false);
      return;
    }
    setProgress((p) => ({ ...p, analyse: 'granted' }));

    // Genuine success only: now that contacts + call log are imported and the
    // engine has run, mark onboarding complete and enter Connect. `analysed` is
    // the atomic gate ack — flipping it only here means a kill mid-analysis
    // leaves it false and the next launch re-runs the work stage by itself.
    markOnboardingStep('wantToConnect');
    markOnboardingStep('analysed');
    setDone(true);
    setAnalyzing(false);
  }, [perms.callLog]);

  // Clustering + grouping review finished. Don't barge into the next step —
  // hand control back to the onboarding screen so a Continue button reappears.
  // The cluster progress (granted/skipped) is set by each call site first.
  const completeClusterStage = useCallback(() => {
    setAnalyzing(false);
    setClusterStageDone(true);
  }, []);

  // Opens the "Want to connect" hand-pick. Runs *after* clustering + the
  // grouping review (so the user picks from a contact list that already
  // reflects the groups we just built) and only when the user taps Continue.
  // The picker's own confirm/skip handlers run finishOnboarding.
  const openWantPicker = useCallback(() => {
    ensureStandardGroups();
    setWantContacts(getContacts());
    setAnalyzing(true);
    setProgress((p) => ({ ...p, wantToConnect: 'running' }));
    setWantPickerOpen(true);
  }, []);

  // Stage 2: cluster the imported contacts. With an LLM key we propose groups
  // and let the user review/edit them in the same modal Settings and Groups
  // use. Without a key, skip and proceed straight to analyse — local
  // heuristics alone are too rough for an unattended onboarding step. Reached
  // only after the "Want to connect" picker is dismissed.
  const runClusterAndAnalyse = useCallback(async () => {
    // Advanced mode + an LLM key keeps the smart LLM proposal flow — the hook
    // drives the modal lifecycle and the proposal-watching effect below picks
    // up the next state.
    if (advancedMode && hasLlmKey()) {
      setProgress((p) => ({ ...p, cluster: 'running' }));
      startCategorise({ allowNewGroups: true });
      return;
    }
    // Simple mode (or advanced without a key): run the local clusterer and let
    // the user pick the name keywords they relate to. Big clusters are
    // auto-selected in the modal. With nothing to pick we skip straight to
    // analysis.
    setProgress((p) => ({ ...p, cluster: 'running' }));
    // Filter service contacts (drivers, maids, …) out BEFORE clustering so
    // they never form name-token keyword chips — they're routed to Helpers
    // separately and the keyword step is about the people you relate to.
    const contacts = getContacts().filter((c) => !isHelperContact(c));
    const nameClusters = Object.values(buildCandidateClusters({ contacts }))
      .filter(isNameTokenCluster)
      .map((c) => ({
        id: c.id,
        name: c.name,
        token: c.name.replace(/^Cluster:\s*/i, ''),
        categoryId: c.categoryId,
        members: c.members,
        count: c.members.length,
      }));
    if (!nameClusters.length) {
      setProgress((p) => ({ ...p, cluster: 'skipped' }));
      completeClusterStage();
      return;
    }
    setKeywordContacts(contacts);
    setKeywordClusters(nameClusters);
    setKeywordModalOpen(true);
  }, [advancedMode, startCategorise, completeClusterStage]);

  // Local keyword step confirmed: persist the picked clusters, then open the
  // shared review modal so the user can merge/delete before they become real
  // groups. Picking nothing skips straight to analysis.
  const onKeywordConfirm = useCallback(
    (chosen) => {
      setKeywordModalOpen(false);
      setSelectedClusters(chosen);
      if (!chosen.length) {
        setProgress((p) => ({ ...p, cluster: 'skipped' }));
        completeClusterStage();
        return;
      }
      setProgress((p) => ({ ...p, cluster: 'awaiting_review' }));
      setLocalProposal({
        source: 'local',
        // The modal hands back each cluster with the category the user
        // dropped/tapped it into (defaulting to 'unknown'). Name the group by
        // the bare keyword ("Rao", "IITB") now that it carries a real
        // category — the "Cluster: " prefix was only a hint for the LLM seed.
        groups: chosen.map((c) => ({
          name: c.token || (c.name || '').replace(/^Cluster:\s*/i, ''),
          categoryId: c.categoryId || 'unknown',
          members: c.members,
        })),
        nameByPhone: Object.fromEntries(
          keywordContacts.map((c) => [c.normalized, c.name]),
        ),
        allowNewGroups: true,
      });
    },
    [keywordContacts, completeClusterStage],
  );

  // Review modal confirmed: commit the (possibly edited) clusters as real
  // groups, then run the analysis.
  const onLocalApply = useCallback(
    (editedGroups) => {
      applyProposal(
        { ...localProposal, groups: editedGroups },
        { allowNewGroups: true },
      );
      setLocalProposal(null);
      setProgress((p) => ({ ...p, cluster: 'granted' }));
      completeClusterStage();
    },
    [localProposal, completeClusterStage],
  );

  const onLocalCancel = useCallback(() => {
    setLocalProposal(null);
    setProgress((p) => ({ ...p, cluster: 'skipped' }));
    completeClusterStage();
  }, [completeClusterStage]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    // Stage 1: import contacts so the clusterer has data to work with. We
    // deliberately skip the call log here to keep this step fast; the analyse
    // stage picks it up. Once contacts are in, go straight to clustering — the
    // "Want to connect" hand-pick now runs after clustering + grouping review.
    setProgress({ wantToConnect: 'pending', cluster: 'running', analyse: 'pending' });
    await refreshAnalysis({
      refreshContacts: perms.contacts === 'granted',
      refreshCallLogs: false,
    });
    runClusterAndAnalyse();
  };

  // "Want to connect" picker confirmed: union the chosen contacts into the
  // standard group, then run the final analysis. The picker is the last step
  // before we enter Connect.
  const onWantToConnectConfirm = useCallback(
    (phones) => {
      if (phones && phones.length) {
        addContactsToGroup(phones, WANT_TO_CONNECT_GROUP_ID);
      }
      setWantPickerOpen(false);
      setProgress((p) => ({ ...p, wantToConnect: 'granted' }));
      markOnboardingStep('wantToConnect');
      finishOnboarding();
    },
    [finishOnboarding],
  );

  const onWantToConnectSkip = useCallback(() => {
    setWantPickerOpen(false);
    setProgress((p) => ({ ...p, wantToConnect: 'skipped' }));
    markOnboardingStep('wantToConnect');
    finishOnboarding();
  }, [finishOnboarding]);

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
      completeClusterStage();
    }
  }, [categorising, pendingProposal, progress.cluster, completeClusterStage]);

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
      completeClusterStage();
    },
    [applyEditedProposal, startCategorise, completeClusterStage],
  );

  const onCancelProposal = useCallback(() => {
    dismissProposal();
    setProgress((p) => ({ ...p, cluster: 'skipped' }));
    completeClusterStage();
  }, [dismissProposal, completeClusterStage]);

  // On iOS the engine has very little to chew on without a call log AND
  // without an LLM key — there's no "lost connections" lane to compute and no
  // smart grouping to run. Once contacts are granted and the user has
  // explicitly skipped the LLM step, fire `handleAnalyze` automatically so
  // they land straight in Connect Home instead of staring at an Analyse
  // button that has nothing meaningful to do.
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    // Only relevant to advanced mode — in simple mode there's no LLM/context
    // step to skip, and the picker gives the user something to do, so we just
    // show the Continue button rather than auto-firing.
    if (!advancedMode) return;
    if (autoFiredRef.current) return;
    if (done || analyzing) return;
    if (perms.contacts !== 'granted') return;
    if (llmState !== 'skipped') return;
    // Wait for the user to either fill or skip the context step so we don't
    // skip past it on iOS.
    if (contextState === 'pending') return;
    autoFiredRef.current = true;
    handleAnalyze();
  }, [advancedMode, perms.contacts, llmState, contextState, done, analyzing]);

  const handleEnter = useCallback(() => {
    if (onFinished) onFinished();
    else if (navigation?.replace) navigation.replace('ConnectHome');
  }, [onFinished, navigation]);

  // "Use defaults for now" on the welcome splash: run setup non-interactively
  // with sensible defaults instead of bypassing it. We request permissions,
  // import contacts + (Android) call log, auto-cluster, and analyse — so Home
  // lands with real data (the missed-connections lane, reconnect suggestions,
  // …) rather than an empty shell.
  const handleUseDefaults = useCallback(async () => {
    // The user made the welcome-splash decision; record it so a kill mid-defaults
    // resumes past the splash rather than re-prompting.
    markOnboardingStep('welcome');
    setPreparingDefaults(true);
    try {
      // 1. Permissions + import. requestImportPermissions persists the perms
      //    shape itself; we mirror it locally and use the fresh result (state
      //    updates are async, so `perms` would be stale within this tick).
      const { perms: granted } = await requestImportPermissions();
      setPerms(granted);
      const imported = await refreshAnalysis({
        refreshContacts: granted.contacts === 'granted',
        refreshCallLogs: granted.callLog === 'granted',
      });
      // Call-log access was granted but the import errored → the cache has no
      // call log and Home's "Missed connections" lane would be empty. Treat as
      // a failed setup so we don't mark onboarding complete below (the catch
      // returns the user to onboarding to retry).
      if (granted.callLog === 'granted' && imported?.refreshError) {
        throw new Error(imported.refreshError);
      }

      // 2. Seed the standard groups ("Want to connect", …).
      ensureStandardGroups();

      // 3. Clustering with defaults — "take what we already have": apply the
      //    big name-token clusters the keyword picker would auto-tick
      //    (count > AUTO_SELECT_MIN_MEMBERS) as groups, without prompting.
      //    Helpers are filtered out first, exactly as runClusterAndAnalyse does.
      const contacts = getContacts().filter((c) => !isHelperContact(c));
      const bigClusters = Object.values(buildCandidateClusters({ contacts }))
        .filter(isNameTokenCluster)
        .filter((c) => (c.members?.length || 0) > AUTO_SELECT_MIN_MEMBERS);
      if (bigClusters.length) {
        setSelectedClusters(
          bigClusters.map((c) => ({
            id: c.id,
            name: c.name,
            token: (c.name || '').replace(/^Cluster:\s*/i, ''),
            categoryId: c.categoryId,
            members: c.members,
            count: c.members.length,
          })),
        );
        applyProposal(
          {
            source: 'local',
            groups: bigClusters.map((c) => ({
              name: (c.name || '').replace(/^Cluster:\s*/i, ''),
              categoryId: c.categoryId || 'unknown',
              members: c.members,
            })),
            nameByPhone: Object.fromEntries(
              contacts.map((c) => [c.normalized, c.name]),
            ),
            allowNewGroups: true,
          },
          { allowNewGroups: true },
        );
      }

      // 4. Final analysis so the new groups + call-log data show up on Home.
      await refreshAnalysis({
        refreshContacts: false,
        refreshCallLogs: granted.callLog === 'granted',
      });

      // Genuine success only: now that import + analysis have actually run, mark
      // the gate steps complete and enter Connect. Keeping these OUT of a
      // `finally` means a kill or import error before this point leaves
      // `analysed` false, so the app reopens to onboarding instead of a
      // half-set-up Home with an empty missed-connections lane.
      markOnboardingStep('wantToConnect');
      markOnboardingStep('analysed');
      // Leave `preparingDefaults` true through navigation — the overlay covers
      // the splash until handleEnter replaces this screen.
      handleEnter();
    } catch (err) {
      // Setup didn't complete (permission/import error or interruption). Drop
      // the overlay and return to the onboarding screen so the user can retry;
      // do NOT mark onboarded.
      setPreparingDefaults(false);
    }
  }, [handleEnter]);

  // Once setup finishes we show a brief loading screen and auto-enter Connect
  // after a short beat — no "Enter Connect" tap required.
  useEffect(() => {
    if (!done) return undefined;
    const t = setTimeout(handleEnter, 1200);
    return () => clearTimeout(t);
  }, [done, handleEnter]);

  // The pre-work decisions are persisted at the moment the user makes them, by
  // marking the matching step in the onboarding table (welcome on Start/Use
  // defaults; llmKey on skip; userContext on skip). The work stage
  // (clusterStageDone / progress) is intentionally NOT persisted — it restarts
  // clean on resume, with only its terminal `analysed` ack written on success.
  // Permissions, advanced mode, the LLM key and the user profile each persist
  // themselves elsewhere, so nothing extra is duplicated here.

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

  // In simple mode the LLM key + context steps don't exist, so permissions
  // alone unlock the Continue button. Advanced mode still gates on them.
  const canAnalyze =
    permsReady && (!advancedMode || (llmReady && contextReady));

  const providerMeta = LLM_PROVIDER_META[llmProvider] || LLM_PROVIDER_META.google;

  useEffect(() => {
    // Once the user has granted permissions, the next interactive card (LLM
    // key, then user context) is what they need next — scroll the page so
    // it's visible without them hunting for it. Only advanced mode has those
    // cards.
    if (advancedMode && permsReady && (!llmReady || !contextReady)) {
      const t = setTimeout(() => {
        scrollRef.current?.scrollToEnd?.({ animated: true });
      }, 150);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [advancedMode, permsReady, llmReady, contextReady]);

  return (
    <View style={styles.safeArea}>
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
        <View
          style={[
            styles.header,
            !started && styles.headerWelcome,
            { paddingTop: insets.top + Math.round(sectionGap / 2) },
          ]}
        >
          <View
            style={[
              styles.heroIconWrap,
              !started && styles.heroIconWrapWelcome,
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
          <Text style={[styles.title, !started && styles.titleWelcome]}>
            Welcome to Connect
          </Text>
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

          {!started ? (
            <>
              <TouchableOpacity
                style={[styles.primaryBtn, styles.welcomeBtn]}
                onPress={() => {
                  markOnboardingStep('welcome');
                  setStarted(true);
                }}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryBtnText}>Personalize Connect</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.skipBtn}
                onPress={handleUseDefaults}
                activeOpacity={0.7}
              >
                <Text style={styles.skipBtnText}>Use defaults for now</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>

        {started ? (
        <View style={styles.bodyWrap}>
          {!analyzing && !done ? (
            <TouchableOpacity
              style={styles.advancedRow}
              onPress={toggleAdvancedMode}
              activeOpacity={0.7}
            >
              <View
                style={[
                  styles.advancedCheckbox,
                  advancedMode && styles.advancedCheckboxChecked,
                ]}
              >
                {advancedMode ? (
                  <Icon name="check" size={14} color={theme.colors.surface} />
                ) : null}
              </View>
              <View style={styles.advancedTextWrap}>
                <Text style={styles.advancedTitle}>Advanced setup</Text>
                <Text style={styles.advancedBody}>
                  Add an LLM key, tell us about you, and auto-cluster + analyse
                  your contacts. Leave it off for a quick import — you can turn
                  it on later in Settings.
                </Text>
              </View>
            </TouchableOpacity>
          ) : null}

          {(() => {
            // iOS doesn't expose call logs, so the call-history step is just
            // noise — hide it. When the user has also explicitly skipped the
            // LLM key, the analyse-runs-on-confirm UX kicks in (see effect
            // above) so the Cluster + Analyse steps are hidden until the
            // work fires.
            const showCallLogStep = Platform.OS === 'android';
            // Cluster + Analyse are advanced-only and, on iOS with the LLM
            // step skipped, fire automatically — so hide them until they run.
            const showWorkSteps =
              advancedMode &&
              (Platform.OS === 'android' || llmState !== 'skipped');
            const clusterBody =
              progress.cluster === 'awaiting_review'
                ? 'Review the proposed groups in the popup. Remove, rename, or add groups before applying.'
                : llmState === 'granted'
                ? 'Group your contacts with the LLM into Friends, Office, Family, ….'
                : 'Skipped — add an LLM key and run "Re-categorise contacts" from Settings any time.';
            const wantToConnectBody =
              progress.wantToConnect === 'running'
                ? 'Search and pick the people you want to stay in touch with in the popup.'
                : 'Hand-pick people into your "Want to connect" group — search, then select all.';
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
              advancedMode && {
                icon: 'creation',
                title: 'LLM key (optional)',
                body: 'Lets us auto-group contacts into Friends, Office, Family, …. You can add it later from Settings.',
                state: llmState,
              },
              advancedMode && {
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
              {
                icon: 'account-multiple-plus-outline',
                title: 'Choose who to connect with',
                body: wantToConnectBody,
                state: progress.wantToConnect,
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

          {advancedMode && permsReady && llmReady && !contextReady ? (
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
                  onPress={handleSkipContext}
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

          {advancedMode && permsReady && !llmReady ? (
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
              onPress={clusterStageDone ? openWantPicker : handleAnalyze}
            >
              {analyzing ? (
                <ActivityIndicator color={theme.colors.surface} />
              ) : (
                <Text style={styles.primaryBtnText}>
                  {clusterStageDone
                    ? 'Continue'
                    : advancedMode
                    ? 'Analyse relationships'
                    : 'Continue'}
                </Text>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.primaryBtn} onPress={handleEnter}>
              <Text style={styles.primaryBtnText}>Enter Connect</Text>
            </TouchableOpacity>
          )}
          </View>
        </View>
        ) : null}
      </ScrollView>
      </KeyboardAvoidingView>

      <ContactPickerModal
        visible={wantPickerOpen}
        title="Any particular set of people you want to connect with?"
        subtitle="Pick the people you most want to stay in touch with. They go into your special “Want to connect” group. Search, then “Select all” to grab a whole group at once."
        contacts={wantContacts}
        confirmLabel="Want to connect"
        onConfirm={onWantToConnectConfirm}
        onSkip={onWantToConnectSkip}
      />

      <ClusterKeywordModal
        visible={keywordModalOpen}
        clusters={keywordClusters}
        onConfirm={onKeywordConfirm}
      />

      <CategoriseProposalModal
        visible={!!pendingProposal}
        proposal={pendingProposal}
        onApply={onApplyProposal}
        onCancel={onCancelProposal}
        showCustomise={false}
      />

      <CategoriseProposalModal
        visible={!!localProposal}
        proposal={localProposal}
        onApply={onLocalApply}
        onCancel={onLocalCancel}
        showCustomise={false}
        proposedOnly
      />

      <UserContextModal
        visible={contextOpen}
        onClose={() => setContextOpen(false)}
        onSaved={() => setContextState('granted')}
        onSkipped={handleSkipContext}
      />

      {done || preparingDefaults ? (
        <View style={styles.loadingOverlay}>
          <View
            style={[
              styles.heroIconWrap,
              { width: heroSize, height: heroSize, borderRadius: heroSize / 2 },
            ]}
          >
            <Icon name="account-heart" size={heroIconSize} color={theme.colors.primary} />
          </View>
          <ActivityIndicator
            color={theme.colors.primary}
            style={{ marginTop: theme.spacing.lg }}
          />
          <Text style={styles.loadingText}>Setting up Connect…</Text>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: theme.colors.background },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: theme.spacing.md,
    fontSize: theme.font.body,
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  kbWrap: { flex: 1 },
  container: {
    flexGrow: 1,
  },
  header: { alignItems: 'center' },
  // Welcome splash: take the whole screen and center the hero + copy + Start
  // button as one calm column instead of pinning the header to the top.
  headerWelcome: {
    flex: 1,
    justifyContent: 'center',
    paddingBottom: theme.spacing.xl,
  },
  heroIconWrapWelcome: {
    marginBottom: theme.spacing.lg,
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 6,
  },
  titleWelcome: {
    fontSize: Math.round(theme.font.h1 * 1.1),
    marginTop: theme.spacing.xs,
  },
  welcomeBtn: {
    marginTop: theme.spacing.xl,
    minWidth: 200,
  },
  skipBtn: {
    marginTop: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  skipBtnText: {
    color: theme.colors.textMuted,
    fontSize: theme.font.small,
    fontWeight: '600',
  },
  bodyWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  advancedRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    marginTop: theme.spacing.lg,
  },
  advancedCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    marginRight: theme.spacing.md,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
  },
  advancedCheckboxChecked: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  advancedTextWrap: { flex: 1 },
  advancedTitle: {
    fontSize: theme.font.body,
    fontWeight: '700',
    color: theme.colors.text,
  },
  advancedBody: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    lineHeight: 18,
    marginTop: 2,
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
