import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  Linking,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import DeviceInfo from 'react-native-device-info';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import AppHeader from '../components/AppHeader';
import {
  clearConnectStorage,
  clearConnectStorageSelective,
  getGroups,
  getLlmConfig,
  getLlmKeys,
  getUserProfile,
  hasLlmKey,
  isSetupCompleted,
  userProfileEntryCount,
  LLM_PROVIDER_META,
} from '../storage';
import LlmKeyModal from '../components/LlmKeyModal';
import CategoriseProposalModal from '../components/CategoriseProposalModal';
import ExportImportModal from '../components/ExportImportModal';
import UserContextModal from '../components/UserContextModal';
import { useRecategorise } from '../hooks/useRecategorise';
import {
  APP_NAME,
  APP_WEBSITE_URL,
  COMPANY_NAME,
  CONTACT_EMAIL,
  FOUNDER_CREDITS,
  PRIVACY_POLICY_URL,
  WHATSAPP_SUPPORT_NUMBER,
  getStoreUrl,
  sendWhatsAppMessage,
  shareApp,
} from '../utils/appShare';

const STEP_REFLECT = 'reflect';
const STEP_SELECT = 'select';
const STEP_DONE = 'done';

// Scopes the user can selectively wipe. Order here drives the order in the UI.
// Keep keys aligned with SCOPE_KEYS in storage.js.
const DELETE_SCOPES = [
  {
    id: 'groups',
    title: 'Groups & memberships',
    description: 'Custom groups and which contacts belong to which.',
  },
  {
    id: 'callLogs',
    title: 'Call log snapshot',
    description: 'Cached call history used by the relationship engine.',
  },
  {
    id: 'contacts',
    title: 'Contacts cache',
    description: 'Local copy of your address book that Connect reads from.',
  },
  {
    id: 'notes',
    title: 'Notes',
    description: 'Anything you typed into Contact Detail notes.',
  },
  {
    id: 'reconnects',
    title: 'Reconnect history',
    description: 'When you last reached out to each person.',
  },
  {
    id: 'goals',
    title: 'Goals',
    description: 'Soft goals like "reconnect with 5 people this week".',
  },
  {
    id: 'milestones',
    title: 'Milestones',
    description: 'Earned achievements like reconnect counts and day streaks.',
  },
  {
    id: 'userProfile',
    title: 'Your context',
    description:
      'Schools, colleges, workplaces, places lived, saving-logic notes used to improve LLM grouping.',
  },
  {
    id: 'llmKey',
    title: 'LLM key',
    description: 'Provider + API key used for auto-grouping.',
  },
];

// Scopes that start unchecked in the delete form — generally safer to keep
// these unless the user explicitly wants them gone.
const DEFAULT_UNCHECKED_SCOPES = new Set(['llmKey', 'userProfile']);
const defaultSelectedScopes = () =>
  new Set(
    DELETE_SCOPES.filter((s) => !DEFAULT_UNCHECKED_SCOPES.has(s.id)).map(
      (s) => s.id,
    ),
  );

const providerLabel = (p) => LLM_PROVIDER_META[p]?.label || p;

const SettingsScreen = ({ navigation, mode = 'guest', user, onLogin, onLogout }) => {
  const [step, setStep] = useState(null);
  const [llmOpen, setLlmOpen] = useState(false);
  // 'export' | 'import' | null. Re-mounting the modal each time it opens
  // (via a bump key) is what lets it reset its internal step machine cleanly
  // when the same flow is opened twice in a row.
  const [backupMode, setBackupMode] = useState(null);
  const [backupBump, setBackupBump] = useState(0);
  // Bump-on-mutation pattern: every modal close that may have changed the
  // active key increments this, and the `llm`/`llmKeys` memos depend on it so
  // the row body re-reads MMKV without a global store.
  const [llmBump, setLlmBump] = useState(0);
  // User-context modal + its bump-on-mutation key. Same pattern as the LLM
  // key modal — incremented after Save so the row's count refreshes.
  const [contextOpen, setContextOpen] = useState(false);
  const [contextBump, setContextBump] = useState(0);
  const [selectedScopes, setSelectedScopes] = useState(defaultSelectedScopes);
  const llm = useMemo(() => getLlmConfig(), [llmBump]);
  const llmKeysSnapshot = useMemo(() => getLlmKeys(), [llmBump]);
  const userProfileSnapshot = useMemo(() => getUserProfile(), [contextBump]);
  const userProfileCount = userProfileEntryCount(userProfileSnapshot);

  const isAuthed = mode !== 'guest' && Boolean(user);

  const openFlow = () => {
    setSelectedScopes(defaultSelectedScopes());
    setStep(STEP_REFLECT);
  };
  const closeFlow = () => setStep(null);

  const onConfirmDelete = () => {
    const scopes = [...selectedScopes];
    if (scopes.length === DELETE_SCOPES.length) {
      // User picked everything — also wipe onboarding/setup flags so the
      // welcome screen returns. clearConnectStorage covers that.
      clearConnectStorage();
    } else {
      clearConnectStorageSelective(scopes);
    }
    setStep(STEP_DONE);
  };

  const onDoneAcknowledge = () => {
    setStep(null);
    const parent = navigation.getParent?.();
    if (parent) {
      parent.reset({
        index: 0,
        routes: [{ name: 'ConnectOnboarding' }],
      });
    }
  };

  const toggleScope = (id) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Categorisation orchestration (state + alerts + vibration + LLM-prompt
  // modal) is shared with GroupsScreen via useRecategorise. The prompt-modal
  // state (`llmPromptOpen` / `llmPromptError`) is returned from the hook so
  // the same dialog can surface auth failures from either screen.
  const {
    categorising,
    categoriseProgress,
    startCategorise,
    pendingProposal,
    applyEditedProposal,
    dismissProposal,
    llmPromptOpen,
    setLlmPromptOpen,
    llmPromptError,
    setLlmPromptError,
  } = useRecategorise();

  const onRecategorise = useCallback(() => {
    if (!isSetupCompleted()) {
      Alert.alert(
        'Set up Connect first',
        'Finish Connect setup so we have your contacts to categorise.',
      );
      return;
    }
    if (!hasLlmKey()) {
      setLlmPromptOpen(true);
      return;
    }
    // When groups already exist, ask which mode to run in. Both branches
    // go through the proposal modal so the user gets the same debug
    // showcase (Local / Sent / LLM reply / Proposed tabs) — the constrained
    // branch just hides the "add a custom group" UI in the modal.
    if (getGroups().length > 0) {
      Alert.alert(
        'Re-categorise contacts',
        'You already have groups. Should the LLM be allowed to propose new ones, or only re-tag contacts into your existing groups?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Only existing groups',
            onPress: () => startCategorise({ allowNewGroups: false }),
          },
          {
            text: 'Allow new groups',
            onPress: () => startCategorise({ allowNewGroups: true }),
          },
        ],
      );
      return;
    }
    startCategorise({ allowNewGroups: true });
  }, [startCategorise, setLlmPromptOpen]);

  const onApplyProposal = useCallback(
    (editedGroups, { isEdited, allowNewGroups } = {}) => {
      applyEditedProposal(editedGroups, { mode: 'apply' });
      // When the user changed the group skeleton during an unconstrained
      // run, immediately re-run in constrained mode so the LLM re-slots
      // contacts into the freshly-saved (edited) group list.
      if (isEdited && allowNewGroups) {
        startCategorise({ allowNewGroups: false });
      }
    },
    [applyEditedProposal, startCategorise],
  );

  // "Customise on Groups" jumps the user over to the Groups screen with a
  // banner so they can fine-tune the proposed list before the final
  // categorisation pass.
  const onCustomiseProposal = useCallback((editedGroups) => {
    applyEditedProposal(editedGroups, { mode: 'customise' });
    navigation?.navigate?.('ConnectGroups', { customiseAfterPropose: true });
  }, [applyEditedProposal, navigation]);

  return (
    <View style={styles.container}>
      <AppHeader title="Settings" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.sectionLabel}>Account</Text>

        <View style={styles.card}>
          {isAuthed ? (
            <TouchableOpacity
              style={styles.row}
              onPress={onLogout}
              activeOpacity={0.7}
            >
              <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
                <Icon
                  name="account-circle-outline"
                  size={20}
                  color={theme.colors.primary}
                />
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>
                  {user?.email || user?.name || 'Signed in'}
                </Text>
                <Text style={styles.rowSubtitle}>Tap to log out.</Text>
              </View>
              <Icon
                name="logout"
                size={20}
                color={theme.colors.textSubtle}
              />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.row}
              onPress={onLogin}
              activeOpacity={0.7}
            >
              <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
                <Icon name="login" size={20} color={theme.colors.primary} />
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>Login</Text>
                <Text style={styles.rowSubtitle}>
                  Sign in to switch to CRM mode and sync across devices.
                </Text>
              </View>
              <Icon
                name="chevron-right"
                size={22}
                color={theme.colors.textSubtle}
              />
            </TouchableOpacity>
          )}
        </View>

        <Text style={styles.sectionLabel}>AI categorisation</Text>

        <View style={styles.card}>
          <TouchableOpacity
            style={styles.row}
            onPress={() => setLlmOpen(true)}
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon
                name="creation"
                size={20}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.rowBody}>
              {(() => {
                const configured = Object.keys(llmKeysSnapshot);
                const activeLabel = llm.provider ? providerLabel(llm.provider) : null;
                if (!configured.length) {
                  return (
                    <>
                      <Text style={styles.rowTitle}>Add an LLM key</Text>
                      <Text style={styles.rowSubtitle}>
                        Google AI Studio, OpenAI, or OpenRouter. Used to
                        auto-group contacts. Stored only on this device.
                      </Text>
                    </>
                  );
                }
                const inactive = configured
                  .filter((p) => p !== llm.provider)
                  .map(providerLabel);
                const sub = inactive.length
                  ? `Active: ${activeLabel}. Also configured: ${inactive.join(', ')}.`
                  : `Active: ${activeLabel}. Tap to update or add another.`;
                return (
                  <>
                    <Text style={styles.rowTitle}>
                      {configured.length === 1
                        ? 'LLM key configured'
                        : `${configured.length} LLM keys configured`}
                    </Text>
                    <Text style={styles.rowSubtitle}>{sub}</Text>
                  </>
                );
              })()}
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.row}
            onPress={onRecategorise}
            disabled={categorising}
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon
                name="creation"
                size={20}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Categorise contacts</Text>
              <Text style={styles.rowSubtitle}>
                {categoriseProgress
                  ? `Batch ${categoriseProgress.batchIndex}/${categoriseProgress.batchCount}` +
                    (categoriseProgress.tokens
                      ? ` · ${categoriseProgress.tokens.toLocaleString()} tokens`
                      : '')
                  : 'Rebuild groups from your current contacts. Choose between creating new groups or only re-tagging into existing ones.'}
              </Text>
            </View>
            {categorising ? (
              <ActivityIndicator color={theme.colors.primary} size="small" />
            ) : (
              <Icon
                name="chevron-right"
                size={22}
                color={theme.colors.textSubtle}
              />
            )}
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.row}
            onPress={() => setContextOpen(true)}
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon
                name="account-question-outline"
                size={20}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Your context</Text>
              <Text style={styles.rowSubtitle}>
                {userProfileCount > 0
                  ? `${userProfileCount} ${userProfileCount === 1 ? 'answer' : 'answers'} saved. Tap to edit.`
                  : 'Schools, colleges, workplaces, places lived, saving notes. Improves LLM group names.'}
              </Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>Share & support</Text>

        <View style={styles.card}>
          <TouchableOpacity style={styles.row} onPress={shareApp} activeOpacity={0.7}>
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon
                name="share-variant-outline"
                size={20}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Share Connect</Text>
              <Text style={styles.rowSubtitle}>
                Send the Play Store link to a friend.
              </Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.row}
            onPress={() =>
              sendWhatsAppMessage(
                WHATSAPP_SUPPORT_NUMBER,
                `Hi ${COMPANY_NAME} — I'm using ${APP_NAME} Connect and `,
              )
            }
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon name="whatsapp" size={20} color={theme.colors.primary} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Message us on WhatsApp</Text>
              <Text style={styles.rowSubtitle}>
                Reach out with feedback, bugs, or feature requests.
              </Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.row}
            onPress={() => Linking.openURL(`mailto:${CONTACT_EMAIL}`)}
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon
                name="email-outline"
                size={20}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Email support</Text>
              <Text style={styles.rowSubtitle}>{CONTACT_EMAIL}</Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>About</Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon
                name="account-heart-outline"
                size={20}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>{APP_NAME}</Text>
              <Text style={styles.rowSubtitle}>
                A calmer way to stay in touch with the people who matter.
              </Text>
              <Text style={styles.rowSubtitle}>
                Version {DeviceInfo.getVersion()}
              </Text>
              {/* <Text style={styles.rowSubtitle}>By {COMPANY_NAME}</Text> */}
              <TouchableOpacity onPress={() => Linking.openURL(APP_WEBSITE_URL)}>
                <Text style={styles.linkText}>{APP_WEBSITE_URL}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}
              >
                <Text style={styles.linkText}>Privacy policy</Text>
              </TouchableOpacity>
              {getStoreUrl() ? (
                <TouchableOpacity onPress={() => Linking.openURL(getStoreUrl())}>
                  <Text style={styles.linkText}>
                    {Platform.OS === 'ios'
                      ? 'Rate us on the App Store'
                      : 'Rate us on the Play Store'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text style={[styles.rowSubtitle, styles.comingSoon]}>
                  iOS app coming soon
                </Text>
              )}
            </View>
          </View>
        </View>

        <Text style={styles.sectionLabel}>Backup</Text>

        <View style={styles.card}>
          <TouchableOpacity
            style={styles.row}
            onPress={() => {
              setBackupBump((b) => b + 1);
              setBackupMode('export');
            }}
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon
                name="file-download-outline"
                size={20}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Export your data</Text>
              <Text style={styles.rowSubtitle}>
                Pick what to include and save a portable JSON snapshot you can
                stash anywhere.
              </Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.row}
            onPress={() => {
              setBackupBump((b) => b + 1);
              setBackupMode('import');
            }}
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon
                name="file-import-outline"
                size={20}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Import from a file</Text>
              <Text style={styles.rowSubtitle}>
                Restore a previous export. You'll choose which scopes to bring
                back before anything is written.
              </Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>Data & Privacy</Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon
                name="shield-lock-outline"
                size={20}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Local-only storage</Text>
              <Text style={styles.rowSubtitle}>
                Everything in Connect lives on this device. Nothing is sent to
                a server.
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon
                name="eye-outline"
                size={20}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Read-only access</Text>
              <Text style={styles.rowSubtitle}>
                Connect only reads your contacts and call log to surface
                gentle reminders — it never edits, deletes, or shares them.
                Nothing ever leaves this device.
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.row}
            onPress={() => navigation.navigate('ConnectCallLogs')}
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
              <Icon name="phone-log" size={20} color={theme.colors.primary} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>View saved call logs</Text>
              <Text style={styles.rowSubtitle}>
                See the call history Connect has stored on this device —
                number, date &amp; time, and duration of each call.
              </Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.row}
            onPress={openFlow}
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrap, styles.iconWrapDanger]}>
              <Icon
                name="trash-can-outline"
                size={20}
                color={theme.colors.danger}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, styles.rowTitleDanger]}>
                Delete all Connect data
              </Text>
              <Text style={styles.rowSubtitle}>
                Remove contacts cache, groups, notes, and reconnect history
                from this device.
              </Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.brand}>
          <View style={styles.brandIconWrap}>
            <Icon
              name="account-heart-outline"
              size={28}
              color={theme.colors.primary}
            />
          </View>
          <Text style={styles.brandWordmark}>connect</Text>
          <Text style={styles.brandTagline}>
            staying in touch.
          </Text>
          <Text style={styles.brandCredits}>{FOUNDER_CREDITS}</Text>
        </View>
      </ScrollView>

      <LlmKeyModal
        visible={llmOpen}
        onClose={() => {
          setLlmOpen(false);
          setLlmBump((b) => b + 1);
        }}
      />

      <LlmKeyModal
        visible={llmPromptOpen}
        onClose={() => {
          setLlmPromptOpen(false);
          setLlmPromptError(null);
          setLlmBump((b) => b + 1);
        }}
        title={
          llmPromptError ? 'LLM key was rejected' : 'Add an LLM key for better grouping'
        }
        body="Local heuristics are rough — they only spot label cues (Mom, Office) and surname patterns. An LLM groups your contacts much more accurately. Add a key, or use local anyway."
        errorMessage={llmPromptError}
        onSaved={() => {
          setLlmPromptError(null);
          setLlmBump((b) => b + 1);
          startCategorise({ allowNewGroups: true });
        }}
        showLocalOption
        onUseLocal={() => {
          setLlmPromptError(null);
          startCategorise({ allowNewGroups: true, useLocal: true });
        }}
        useLocalLabel="Use local heuristics anyway"
      />

      <CategoriseProposalModal
        visible={!!pendingProposal}
        proposal={pendingProposal}
        onApply={onApplyProposal}
        onCustomise={onCustomiseProposal}
        onCancel={dismissProposal}
      />

      <ExportImportModal
        key={`backup-${backupBump}`}
        visible={backupMode !== null}
        mode={backupMode || 'export'}
        onClose={() => setBackupMode(null)}
      />

      <UserContextModal
        visible={contextOpen}
        onClose={() => {
          setContextOpen(false);
          setContextBump((b) => b + 1);
        }}
      />

      <Modal
        visible={step !== null}
        transparent
        animationType="fade"
        onRequestClose={closeFlow}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            {step === STEP_REFLECT && (
              <ReflectStep onCancel={closeFlow} onContinue={() => setStep(STEP_SELECT)} />
            )}
            {step === STEP_SELECT && (
              <SelectStep
                selected={selectedScopes}
                onToggle={toggleScope}
                onCancel={closeFlow}
                onDelete={onConfirmDelete}
              />
            )}
            {step === STEP_DONE && <DoneStep onClose={onDoneAcknowledge} />}
          </View>
        </View>
      </Modal>
    </View>
  );
};

const ReflectStep = ({ onCancel, onContinue }) => (
  <View>
    <View style={styles.modalIconRow}>
      <View style={[styles.modalIconWrap, styles.modalIconWrapWarm]}>
        <Icon
          name="heart-outline"
          size={28}
          color={theme.colors.accent}
        />
      </View>
    </View>
    <Text style={styles.modalTitle}>Before you delete…</Text>
    <Text style={styles.modalBody}>
      Connect has been quietly keeping track of the people who matter to
      you — the contacts you've grouped, the notes you've written, the
      reconnects you've made.
    </Text>
    <Text style={styles.modalBody}>
      Take a moment: how important has staying in touch been for you here?
      If you delete now, all of this local history will be gone.
    </Text>
    <View style={styles.modalBtnRow}>
      <TouchableOpacity
        onPress={onCancel}
        style={[styles.modalBtn, styles.modalBtnSecondary]}
      >
        <Text style={styles.modalBtnSecondaryText}>Keep my data</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onContinue}
        style={[styles.modalBtn, styles.modalBtnGhostDanger]}
      >
        <Text style={styles.modalBtnGhostDangerText}>Continue</Text>
      </TouchableOpacity>
    </View>
  </View>
);

const SelectStep = ({ selected, onToggle, onCancel, onDelete }) => {
  const allSelected = selected.size === DELETE_SCOPES.length;
  const ctaLabel = selected.size === 0
    ? 'Nothing selected'
    : allSelected
    ? 'Delete everything'
    : `Delete ${selected.size} item${selected.size === 1 ? '' : 's'}`;
  return (
    <View>
      <View style={styles.modalIconRow}>
        <View style={[styles.modalIconWrap, styles.modalIconWrapDanger]}>
          <Icon
            name="alert-octagon-outline"
            size={28}
            color={theme.colors.danger}
          />
        </View>
      </View>
      <Text style={styles.modalTitle}>Choose what to delete</Text>
      <Text style={styles.modalBody}>
        Tap the items you want to remove from this device. This cannot be
        undone.
      </Text>
      <ScrollView
        style={styles.scopeList}
        contentContainerStyle={{ paddingBottom: theme.spacing.sm }}
      >
        {DELETE_SCOPES.map((scope) => {
          const checked = selected.has(scope.id);
          return (
            <TouchableOpacity
              key={scope.id}
              style={styles.scopeRow}
              onPress={() => onToggle(scope.id)}
              activeOpacity={0.7}
            >
              <View
                style={[
                  styles.checkbox,
                  checked && styles.checkboxChecked,
                ]}
              >
                {checked ? (
                  <Icon name="check" size={14} color={theme.colors.surface} />
                ) : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.scopeTitle}>{scope.title}</Text>
                <Text style={styles.scopeSubtitle}>{scope.description}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <Text style={styles.modalFootnote}>
        Your phone's contacts and call log are not affected.
      </Text>
      <View style={styles.modalBtnRow}>
        <TouchableOpacity
          onPress={onCancel}
          style={[styles.modalBtn, styles.modalBtnSecondary]}
        >
          <Text style={styles.modalBtnSecondaryText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onDelete}
          disabled={selected.size === 0}
          style={[
            styles.modalBtn,
            styles.modalBtnDanger,
            selected.size === 0 && styles.btnDisabled,
          ]}
        >
          <Text style={styles.modalBtnDangerText}>{ctaLabel}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const DoneStep = ({ onClose }) => (
  <View>
    <View style={styles.modalIconRow}>
      <View style={[styles.modalIconWrap, styles.modalIconWrapSuccess]}>
        <Icon
          name="check-circle-outline"
          size={28}
          color={theme.colors.success}
        />
      </View>
    </View>
    <Text style={styles.modalTitle}>Cleared</Text>
    <Text style={styles.modalBody}>
      Your Connect data has been removed from this device. You can set
      Connect up again anytime.
    </Text>
    <View style={styles.modalBtnRow}>
      <TouchableOpacity
        onPress={onClose}
        style={[styles.modalBtn, styles.modalBtnPrimary]}
      >
        <Text style={styles.modalBtnPrimaryText}>OK</Text>
      </TouchableOpacity>
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scroll: {
    padding: theme.spacing.lg,
  },
  sectionLabel: {
    fontSize: theme.font.small,
    fontWeight: '700',
    color: theme.colors.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: theme.spacing.sm,
    marginLeft: theme.spacing.xs,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: theme.spacing.lg,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.md,
  },
  iconWrapNeutral: { backgroundColor: theme.colors.chipBg },
  iconWrapDanger: { backgroundColor: 'rgba(176, 70, 60, 0.10)' },
  rowBody: { flex: 1 },
  rowTitle: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
    marginBottom: 2,
  },
  rowTitleDanger: { color: theme.colors.danger },
  rowSubtitle: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    lineHeight: 18,
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.divider,
    marginLeft: theme.spacing.lg + 36 + theme.spacing.md,
  },

  brand: {
    alignItems: 'center',
    marginTop: theme.spacing.xxl,
    marginBottom: theme.spacing.lg,
  },
  brandIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: theme.colors.chipBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.sm,
  },
  brandWordmark: {
    fontSize: theme.font.body,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'lowercase',
    color: theme.colors.primary,
  },
  brandTagline: {
    fontSize: theme.font.small,
    color: theme.colors.textSubtle,
    fontStyle: 'italic',
    marginTop: theme.spacing.xs,
  },
  brandCredits: {
    fontSize: theme.font.small,
    color: theme.colors.textSubtle,
    marginTop: theme.spacing.sm,
    textAlign: 'center',
  },
  comingSoon: {
    marginTop: theme.spacing.xs,
    fontStyle: 'italic',
    color: theme.colors.textSubtle,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  },
  modalCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.xl,
  },
  modalIconRow: {
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  modalIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalIconWrapWarm: { backgroundColor: 'rgba(224, 120, 86, 0.12)' },
  modalIconWrapDanger: { backgroundColor: 'rgba(176, 70, 60, 0.12)' },
  modalIconWrapSuccess: { backgroundColor: 'rgba(60, 157, 106, 0.12)' },
  modalTitle: {
    fontSize: theme.font.h2,
    fontWeight: '700',
    color: theme.colors.text,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
  },
  modalBody: {
    fontSize: theme.font.body,
    color: theme.colors.textMuted,
    lineHeight: 21,
    marginBottom: theme.spacing.md,
  },
  modalFootnote: {
    fontSize: theme.font.small,
    color: theme.colors.textSubtle,
    lineHeight: 18,
    marginBottom: theme.spacing.md,
    fontStyle: 'italic',
  },
  scopeList: {
    maxHeight: 320,
    marginBottom: theme.spacing.sm,
  },
  scopeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: theme.spacing.sm,
    paddingRight: theme.spacing.xs,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    marginRight: theme.spacing.md,
  },
  checkboxChecked: {
    backgroundColor: theme.colors.danger,
    borderColor: theme.colors.danger,
  },
  scopeTitle: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
  },
  scopeSubtitle: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    lineHeight: 18,
    marginTop: 2,
  },
  modalBtnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: theme.spacing.sm,
  },
  modalBtn: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm + 2,
    borderRadius: theme.radius.pill,
    marginLeft: theme.spacing.sm,
  },
  modalBtnPrimary: { backgroundColor: theme.colors.primary },
  modalBtnPrimaryText: { color: theme.colors.surface, fontWeight: '700' },
  modalBtnSecondary: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  modalBtnSecondaryText: { color: theme.colors.textMuted, fontWeight: '600' },
  modalBtnDanger: { backgroundColor: theme.colors.danger },
  modalBtnDangerText: { color: theme.colors.surface, fontWeight: '700' },
  modalBtnGhostDanger: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.danger,
  },
  modalBtnGhostDangerText: {
    color: theme.colors.danger,
    fontWeight: '700',
  },
  linkText: {
    color: theme.colors.primary,
    fontSize: theme.font.small,
    textDecorationLine: 'underline',
    marginTop: theme.spacing.xs,
  },
  btnDisabled: { opacity: 0.6 },
});

export default SettingsScreen;
