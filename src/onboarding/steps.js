// The single ordered registry that decides "what's left" in onboarding. The
// app gate walks this on launch (see isOnboardingComplete in storage.js): if
// every step is satisfied the user lands on Home, otherwise onboarding opens
// and resumes at the first unsatisfied step. Because each step's completion is
// re-evaluated from live state every launch, a mid-setup app kill simply leaves
// the in-progress step unsatisfied and the flow resumes itself.
//
// This module is deliberately PURE — it takes a `ctx` snapshot and never imports
// storage, so storage.js can depend on it without a require cycle. storage.js
// owns buildOnboardingCtx() which assembles the snapshot below.
//
// ctx shape:
//   {
//     platform: 'ios' | 'android',
//     perms: { contacts, callLog },   // live OS permission state
//     acks: { [stepKey]: true },      // persisted one-way decisions
//   }
//
// `applicable` returning false means the step doesn't exist for this user
// (iOS has no call log) — a non-applicable step is treated as satisfied.
// `isComplete` is only consulted when the step applies.
//
// The LLM-key and "tell us about you" prompts are deliberately NOT gate steps:
// they're optional advanced-mode enhancements, not completion requirements.
// Completion is the same whether the user finished in basic or advanced mode —
// the terminal `analysed` ack (written only after the engine run succeeds) is
// the real "setup is done" signal. Gating on advanced-only steps would wrongly
// re-open onboarding the moment a basic-completed user flips advanced mode on.
// Those prompts are still acked (for resume / no-re-nag) and shown by the
// onboarding UI based on `advancedMode` — that's independent of this gate.
//
// Permission steps derive from live `perms` rather than a stored ack on
// purpose: a "contacts granted" boolean would go stale the moment the user
// revokes the permission from OS settings (no callback fires). Deriving means a
// revoke re-opens onboarding by itself. Acks are reserved for one-way decisions
// that have no live OS signal to re-read (welcome, want-to-connect, analysed).
export const ONBOARDING_STEPS = [
  {
    key: 'welcome',
    applicable: () => true,
    isComplete: (ctx) => Boolean(ctx.acks.welcome),
  },
  {
    key: 'contacts',
    applicable: () => true,
    // Contacts are the app's whole point — require an actual grant, matching
    // the existing `permsReady` rule in OnboardingScreen.
    isComplete: (ctx) => ctx.perms.contacts === 'granted',
  },
  {
    key: 'callLog',
    applicable: (ctx) => ctx.platform === 'android', // iOS exposes no call log
    // The call log is optional — proceeding after a denial is fine, so both
    // granted and an explicit denial satisfy the step.
    isComplete: (ctx) =>
      ctx.perms.callLog === 'granted' || ctx.perms.callLog === 'denied',
  },
  {
    key: 'wantToConnect',
    applicable: () => true,
    isComplete: (ctx) => Boolean(ctx.acks.wantToConnect),
  },
  {
    key: 'analysed',
    applicable: () => true,
    // The atomic "setup actually finished" flag — written only after the
    // engine run succeeds, so a kill mid-analysis re-runs the work stage.
    isComplete: (ctx) => Boolean(ctx.acks.analysed),
  },
];

export const isStepSatisfied = (step, ctx) =>
  !step.applicable(ctx) || step.isComplete(ctx);

// Per-step breakdown for diagnostics (logged in dev — see storage.js gate).
export const evaluateSteps = (ctx) =>
  ONBOARDING_STEPS.map((s) => {
    const applicable = s.applicable(ctx);
    const complete = applicable ? s.isComplete(ctx) : null;
    return {
      step: s.key,
      applicable,
      complete,
      satisfied: !applicable || complete,
    };
  });

export const isOnboardingCompleteForCtx = (ctx) =>
  ONBOARDING_STEPS.every((s) => isStepSatisfied(s, ctx));

export const firstIncompleteStep = (ctx) =>
  ONBOARDING_STEPS.find((s) => !isStepSatisfied(s, ctx)) || null;
