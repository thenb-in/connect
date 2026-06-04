import { useCallback, useState } from 'react';
import { Alert, Vibration } from 'react-native';
import {
  applyProposal,
  proposeContactGroups,
} from '../engine/categorization';
import { getContacts, getGroups, setLastCategorizedAt } from '../storage';

// Haptic patterns used as the "done" cue when the categorisation alert
// appears. The project doesn't ship a sound library so we use Vibration for
// a no-install, cross-platform completion signal — categorisation can take
// 10–30s and the user often switches apps in the meantime.
const VIBE_SUCCESS = [0, 60, 80, 60];
const VIBE_ERROR = [0, 140, 60, 140];

const STAMPABLE_PROPOSAL_SOURCES = new Set(['llm', 'local']);

// The engine wants `{ name, categoryId }` rows; user groups carry more.
const groupsToConstrainedList = (groups) =>
  (groups || [])
    .filter((g) => g && g.name && g.categoryId)
    .map((g) => ({ name: g.name, categoryId: g.categoryId }));

/**
 * Shared categorisation runner used by SettingsScreen and GroupsScreen.
 *
 * One entry point, `startCategorise({ allowNewGroups, useLocal })`:
 *   - allowNewGroups=true  → the LLM clusters from scratch; the user reviews
 *     in the proposal modal and may add/remove groups before apply.
 *   - allowNewGroups=false → the LLM is given the user's current group list
 *     and must only slot contacts into it (engine drops any hallucinated
 *     new groups before the proposal lands). The same modal is shown for
 *     debug visibility, but the "add custom group" UI is hidden.
 *
 * Both modes share:
 *   - the propose → review → apply pipeline,
 *   - the proposal-error handler (no_key / invalid_key / llm_failed / etc.),
 *   - the completion alert.
 *
 * The two paths converge in `applyEditedProposal`, which honours
 * `pendingProposal.allowNewGroups`. That means even from the "allow new"
 * path, if the user removes every newly-proposed group in the modal, the
 * apply is functionally identical to the "only existing" path.
 */
export const useRecategorise = ({ onComplete } = {}) => {
  const [categorising, setCategorising] = useState(false);
  const [categoriseProgress, setCategoriseProgress] = useState(null);
  const [llmPromptOpen, setLlmPromptOpen] = useState(false);
  const [llmPromptError, setLlmPromptError] = useState(null);
  // Pending proposal that the user is reviewing. While non-null, the
  // CategoriseProposalModal is visible. Cleared on apply, customise, or
  // cancel. Carries `allowNewGroups` so the modal and the apply step both
  // know which mode they're in.
  const [pendingProposal, setPendingProposal] = useState(null);

  // Centralised handler for every non-success proposal source. Returns true
  // when it handled the result (caller should bail), false otherwise. Each
  // entry returns a side-effect callback so the dispatch table stays a pure
  // lookup and the per-source vibrate/alert/prompt wiring lives next to its
  // source key — easier to scan than a stack of `if (res.source === '...')`.
  const handleProposalError = useCallback((res) => {
    const handlers = {
      noop: () => {
        Vibration.vibrate(VIBE_ERROR);
        Alert.alert(
          'Nothing to categorise',
          'No contacts are cached yet. Finish Connect setup first.',
        );
      },
      invalid_key: () => {
        Vibration.vibrate(VIBE_ERROR);
        setLlmPromptError(
          'Your LLM key was rejected by the provider. Paste a new one or use local heuristics.',
        );
        setLlmPromptOpen(true);
      },
      llm_failed: () => {
        Vibration.vibrate(VIBE_ERROR);
        Alert.alert(
          'LLM call failed',
          `${res.error || 'Unknown error'}\n\nFix the provider, model, or network and try again — or use local heuristics from the LLM key dialog.`,
        );
      },
      llm_empty: () => {
        Vibration.vibrate(VIBE_ERROR);
        Alert.alert(
          'LLM returned no groups',
          `${res.error || 'The model ran but produced no usable groups.'} No changes were made.`,
        );
      },
      // Shouldn't happen — we open the LlmKeyModal first. Defensive.
      no_key: () => setLlmPromptOpen(true),
    };
    const handler = handlers[res.source];
    if (!handler) return false;
    handler();
    return true;
  }, []);

  const startCategorise = useCallback(
    async ({ allowNewGroups = true, useLocal = false } = {}) => {
      const contacts = getContacts();
      if (!contacts.length) {
        handleProposalError({ source: 'noop' });
        return;
      }
      setCategorising(true);
      setCategoriseProgress(null);
      try {
        const existingGroups = allowNewGroups
          ? null
          : groupsToConstrainedList(getGroups());
        const proposal = await proposeContactGroups({
          contacts,
          useLocal,
          existingGroups,
          onProgress: (p) => setCategoriseProgress(p),
        });
        if (handleProposalError(proposal)) return;
        // Success → show the review modal. Stash the mode + useLocal flag
        // on the proposal so the modal can adapt and the apply step uses
        // the right allowNewGroups value.
        setPendingProposal({ ...proposal, allowNewGroups, useLocal });
      } catch (err) {
        Vibration.vibrate(VIBE_ERROR);
        Alert.alert('Categorisation failed', err?.message || 'Please try again.');
      } finally {
        setCategorising(false);
        setCategoriseProgress(null);
      }
    },
    [handleProposalError],
  );

  // Called by CategoriseProposalModal once the user confirms. The
  // `editedGroups` array reflects any inline remove/add the user did.
  // `mode` is 'apply' (stay on current screen, just commit) or 'customise'
  // (commit and let the caller navigate to the Groups page).
  const applyEditedProposal = useCallback(
    (editedGroups, { mode } = {}) => {
      const proposal = pendingProposal;
      if (!proposal) return null;
      const allowNewGroups = proposal.allowNewGroups !== false;
      const editedProposal = { ...proposal, groups: editedGroups };
      const summary = applyProposal(editedProposal, { allowNewGroups });
      if (STAMPABLE_PROPOSAL_SOURCES.has(proposal.source)) {
        setLastCategorizedAt(Date.now());
      }
      setPendingProposal(null);
      const result = { ...proposal, ...summary };
      onComplete?.(result);
      if (mode !== 'customise') {
        const sourceLabel = proposal.source === 'llm' ? 'LLM' : 'local heuristics';
        const tail = allowNewGroups
          ? `${summary.groupsCreated || 0} new groups, ${summary.contactsTagged || 0} contacts tagged.`
          : `${summary.contactsTagged || 0} contacts retagged into your existing groups.`;
        // The engine pre-filters manual-locked contacts now, so the
        // apply-time skip count will usually be 0. The trace carries the
        // real number — surface it so the user sees their lock-actions
        // are being respected.
        const manualCount =
          proposal.trace?.local?.manualLocked || summary.contactsSkippedManual || 0;
        const manualSuffix = manualCount
          ? `\n\n${manualCount} manually-edited ${manualCount === 1 ? 'contact was' : 'contacts were'} left untouched.`
          : '';
        const tokenSuffix = proposal.tokens
          ? `\n\n${proposal.tokens.toLocaleString()} tokens used.`
          : '';
        Vibration.vibrate(VIBE_SUCCESS);
        Alert.alert(
          'Categorisation done',
          `Via ${sourceLabel}: ${tail}${manualSuffix}${tokenSuffix}`,
        );
      }
      return result;
    },
    [pendingProposal, onComplete],
  );

  const dismissProposal = useCallback(() => {
    setPendingProposal(null);
  }, []);

  return {
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
  };
};
