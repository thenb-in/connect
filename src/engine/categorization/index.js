// ---------------------------------------------------------------------------
// Categorisation engine
// ---------------------------------------------------------------------------
// Hybrid pipeline that turns cleaned contacts into proposed groups under the
// closed CATEGORIES (Friends, Relatives, Colleagues, Helpers, Unknown). Split
// one file per pipeline step, mirroring the proposal-modal tabs:
//
//   shared.js          — string / group helpers used across steps
//   step1Local.js      — Local categorisation: deterministic clustering +
//                        partition (helpers, declared-workplace offices).
//   step2SendToLlm.js  — Send to LLM: build the contact cards + prompt and
//                        call Gemini / OpenAI / OpenRouter.
//   step3LlmReply.js   — LLM reply: parse + sanitise the model's JSON.
//   step4Transform.js  — Transform: enforceConstraints collapses / dedupes /
//                        rejects hallucinated workplaces.
//   step5Propose.js    — Propose: the orchestrator (proposeContactGroups)
//                        that runs every step and returns the proposal.
//   apply.js           — Persist a confirmed proposal to MMKV.
// ---------------------------------------------------------------------------

export { proposeContactGroups } from './step5Propose';
export { applyProposal } from './apply';
export {
  buildCandidateClusters,
  partitionContactsForLlm,
  isHelperContact,
} from './step1Local';
