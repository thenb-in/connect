import {
  getGroups,
  getLlmConfig,
  getManualContactsSet,
  getUserProfile,
} from '../../storage';
import { mergeGroupsByKey } from './shared';
import {
  buildCandidateClusters,
  buildDeclaredContextAliases,
  buildUserWorkplaceMap,
  declaredContextMatcher,
  partitionContactsForLlm,
} from './step1Local';
import {
  batchSizeForProvider,
  buildConstrainedPrompt,
  buildContactCards,
  buildPrompt,
  callGemini,
  callOpenAi,
  callOpenRouter,
  indexBatchByName,
  isAuthError,
} from './step2SendToLlm';
import { parseModelResponse, sanitiseGroups } from './step3LlmReply';
import { enforceConstraints } from './step4Transform';

/**
 * Returns a "proposal": [{ name, categoryId, members:[phone, ...] }, ...].
 *
 * Sources returned (caller branches on these):
 *   - 'local'        — explicit local heuristic pass (`useLocal: true`).
 *   - 'llm'          — partition + LLM. Some contacts may have been assigned
 *                      locally without an LLM call; the rest came from the
 *                      model.
 *   - 'no_key'       — no LLM key configured.
 *   - 'invalid_key'  — provider rejected the key (4xx auth).
 *   - 'llm_failed'   — any other LLM/network/model error (e.g. 404 model).
 *   - 'llm_empty'    — LLM call succeeded but produced no groups (and the
 *                      local partition also produced nothing).
 *
 * We never silently fall back from LLM to local — that hides real errors
 * (bad key, deprecated model, network failure) behind a degraded result.
 * The UI surfaces the failure and the user explicitly chooses to retry the
 * key, switch model, or opt into local heuristics via the "Use local
 * heuristics anyway" path.
 *
 * @param {Object}  opts
 * @param {Array}   opts.contacts
 * @param {boolean} [opts.useLocal=false] - run local heuristics directly,
 *   skipping the LLM. Pass true ONLY when the user explicitly opted in.
 * @param {Array}   [opts.existingGroups] - when supplied (and non-empty),
 *   switch to the constrained-reassignment prompt: the LLM may only slot
 *   contacts into these groups and may not invent new ones.
 */
export const proposeContactGroups = async ({
  contacts,
  useLocal = false,
  existingGroups = null,
  onProgress,
}) => {
  const fullList = (contacts || []).filter((c) => c?.normalized && c?.name);
  // Manual-locked contacts will be skipped at apply time anyway — keeping
  // them out of the categorisation pipeline means no LLM tokens spent on
  // them, no partition heuristics churning over their fields, and a clean
  // trace that reflects the actual decision surface.
  const manualLocked = getManualContactsSet();
  const list = fullList.filter((c) => !manualLocked.has(c.normalized));
  const manualLockedCount = fullList.length - list.length;
  const constrained = Array.isArray(existingGroups) && existingGroups.length > 0;

  // What the user told us about themselves during onboarding (schools,
  // workplaces, places lived, etc). When set this is GROUND TRUTH the prompt
  // can use to name groups like "IIT-B friends" or "Acme colleagues" from a
  // cluster signal alone.
  const userProfile = getUserProfile();

  // Workplace alias → canonical map built from the user's profile. Built
  // early because both the local partition (claims contacts whose names
  // contain an alias as a token) and the enforceConstraints pass (allows
  // LLM-proposed Office groups matching an alias) consume it.
  const userWorkplaceAliases = buildUserWorkplaceMap(userProfile.workplaces);

  // Stage 1a: legacy candidate clusters (label regex + last-name) — still
  // useful as LLM seeds for the family/friends signal, since those aren't
  // covered by the company/note partition.
  const clusters = buildCandidateClusters({ contacts: list });

  // Stage 1b: authoritative local partition. Pull out helpers + clear
  // workplace clusters; everything else goes to the LLM batch. In
  // constrained mode the user has already curated groups, so we skip this
  // (otherwise we'd manufacture groups the user explicitly chose not to
  // have).
  const partition = constrained
    ? { localGroups: [], llmBatch: list, assigned: new Set() }
    : partitionContactsForLlm(list, { userWorkplaceAliases });

  // Structured snapshot of the personalised "About the user" block that gets
  // prepended to EVERY LLM prompt (see buildUserProfileBlock). Surfaced at the
  // top of the "Sent to LLM" tab so the user sees the ground-truth context the
  // model was handed, not just the contact cards. Only non-empty fields are
  // included; an empty list means no context block was sent.
  const profileContext = [];
  if (userProfile.schools?.length)
    profileContext.push({ label: 'Schools', value: userProfile.schools.join(', ') });
  if (userProfile.colleges?.length)
    profileContext.push({ label: 'Colleges / universities', value: userProfile.colleges.join(', ') });
  if (userProfile.workplaces?.length)
    profileContext.push({ label: 'Workplaces', value: userProfile.workplaces.join(', ') });
  if (userProfile.placesStayed?.length)
    profileContext.push({ label: 'Places lived', value: userProfile.placesStayed.join(', ') });
  if (userProfile.savingLogic)
    profileContext.push({ label: 'How I save contacts', value: userProfile.savingLogic });

  // ---- Trace ----
  // Populated as the pipeline runs and returned to the UI so the proposal
  // modal can show what local heuristics decided, what was sent to the LLM,
  // and what the LLM returned. Side-effect free; small enough to hold in
  // memory for a personal-scale address book.
  const phoneToFullName = new Map(list.map((c) => [c.normalized, c.name]));
  const resolveNames = (phones) =>
    (phones || []).map((p) => phoneToFullName.get(p) || p);
  // Phone → display-name lookup attached to every successful proposal so the
  // review modal can resolve a group's phone-keyed `members` to contact names
  // (e.g. tap-to-expand a proposed group). Manual-locked contacts are absent
  // from `list`, but they never appear in proposal members either, so the map
  // covers every phone a proposal can reference.
  const nameByPhone = Object.fromEntries(phoneToFullName);
  const trace = {
    mode: constrained ? 'constrained' : useLocal ? 'local' : 'hybrid',
    // Per-group transformation log, filled by enforceConstraints via
    // `finalise`. Each entry explains how one LLM-reply (or local) group
    // became — or didn't become — a proposed group. Empty in constrained
    // mode (contacts are slotted into existing groups, nothing is reshaped).
    transforms: [],
    local: {
      totalContacts: list.length,
      manualLocked: manualLockedCount,
      llmBatchSize: constrained ? list.length : partition.llmBatch.length,
      // Count assigned as "contacts NOT sent to the LLM" so the three numbers
      // always reconcile (locallyAssigned + llmBatchSize === totalContacts).
      // `partition.assigned` is a Set keyed by normalized phone, so its .size
      // counts unique phones — but cleanupContacts merges by NAME, not phone,
      // so `list` can hold several rows sharing one number. Using the batch
      // complement keeps the same per-row unit as totalContacts/llmBatchSize.
      locallyAssigned: constrained ? 0 : list.length - partition.llmBatch.length,
      groups: partition.localGroups.map((g) => ({
        name: g.name,
        categoryId: g.categoryId,
        memberNames: resolveNames(g.members),
      })),
      legacyClusters: Object.values(clusters).map((c) => ({
        name: c.name,
        categoryId: c.categoryId,
        count: c.members.length,
        source: c.source,
        // Member names let the Local-tab search answer "which cluster did this
        // contact land in?" without another lookup.
        memberNames: resolveNames(c.members),
      })),
    },
    llm: {
      skipped: false,
      constrained,
      batchCount: 0,
      batches: [],
      totalTokens: 0,
      // Context/metadata shown atop the "Sent to LLM" tab. `provider` is
      // filled once the LLM config is read below; `profile` is the personalised
      // ground-truth block sent with every prompt.
      context: {
        provider: null,
        profile: profileContext,
      },
    },
  };

  // User's current groups — passed to enforceConstraints so any LLM
  // proposal whose (categoryId, name) matches a curated group keeps its
  // name verbatim (no collapse to "Family", no downgrade to "Office").
  // In constrained mode we already filter against this exact set before
  // finalise runs, so it's redundant there but harmless.
  const userGroups = getGroups()
    .filter((g) => g && g.name && g.categoryId)
    .map((g) => ({ name: g.name, categoryId: g.categoryId }));

  // Tags groups with their provenance for the transform log. Stripped again
  // inside enforceConstraints before the groups reach the proposal.
  const withOrigin = (groupsIn, origin) =>
    (groupsIn || []).map((g) => ({ ...g, __origin: origin }));

  // Marks every group that references something the user declared in the
  // context form (workplace / school / college / place) as `isBase: true`.
  // The review modal uses this to protect base groups from merge. Runs at the
  // end of finalise so it covers both the hybrid and constrained paths.
  const isBaseName = declaredContextMatcher(buildDeclaredContextAliases(userProfile));
  const tagBase = (groupsIn) =>
    (groupsIn || []).map((g) =>
      g.isBase || isBaseName(g.name) ? { ...g, isBase: true } : g,
    );

  const finalise = (groupsIn) => {
    if (constrained) {
      // The user has hand-curated their group list. enforceConstraints
      // would rename groups OUT of the allowed set — all `relatives` →
      // "Family", any `Office – X` whose members lack a matching company
      // hint → "Office", generic colleague names → "Office", etc. Each
      // of those renames silently strands the LLM's correct slotting
      // because applyProposal can no longer find the group in the
      // existing list. The constrained filter above has already pinned
      // groups to the user's exact (categoryId, name) tuples, so here
      // we only drop empty member arrays and keep names as-is. (__origin is
      // the transform-log tag from withOrigin — strip it here since this
      // branch bypasses enforceConstraints, which is what normally removes it.)
      return tagBase(
        (groupsIn || [])
          .filter((g) => g && Array.isArray(g.members) && g.members.length)
          .map(({ __origin, ...g }) => g),
      );
    }
    return tagBase(
      enforceConstraints(groupsIn, {
        existingGroups: userGroups,
        userWorkplaceAliases,
        transforms: trace.transforms,
      }),
    );
  };

  // Local-only path (useLocal=true OR fallback when LLM batch is empty).
  // Includes the partition's authoritative locals plus the legacy
  // label/surname clusters so the user isn't left empty-handed.
  const buildLocalProposal = () =>
    finalise(
      withOrigin(
        [
          ...partition.localGroups,
          ...Object.values(clusters).map((c) => ({
            name: c.name,
            categoryId: c.categoryId,
            members: c.members,
          })),
        ],
        'local',
      ),
    );

  if (useLocal) {
    trace.llm.skipped = true;
    trace.llm.skipReason = 'useLocal';
    return { source: 'local', groups: buildLocalProposal(), tokens: 0, trace, nameByPhone };
  }

  const { provider, key } = getLlmConfig();
  if (!provider || !key) {
    return { source: 'no_key', groups: [], tokens: 0, error: 'No LLM key configured' };
  }
  trace.llm.context.provider = provider;

  // Nothing left for the LLM after partitioning (rare: an address book
  // where every contact has a strong company hint). Skip the API call.
  if (!constrained && partition.llmBatch.length === 0) {
    trace.llm.skipped = true;
    trace.llm.skipReason = 'empty_batch';
    const groups = finalise(withOrigin(partition.localGroups, 'local'));
    return { source: 'llm', groups, tokens: 0, trace, nameByPhone };
  }

  const llmContacts = constrained ? list : partition.llmBatch;
  const batchSize = batchSizeForProvider(provider);
  const batches = Array.from(
    { length: Math.ceil(llmContacts.length / batchSize) },
    (_, i) => llmContacts.slice(i * batchSize, (i + 1) * batchSize),
  );
  trace.llm.batchCount = batches.length;

  const aggregated = new Map();
  let tokens = 0;
  // Emit an initial 0/N tick so the UI can switch into "Batch 1/N…" mode
  // before the first network round-trip completes.
  if (onProgress) {
    onProgress({ batchIndex: 0, batchCount: batches.length, tokens: 0 });
  }
  try {
    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i];
      // The LLM only ever sees names — never phone numbers. We translate
      // names back to phones locally via nameToPhone after the response
      // lands. cleanupContacts merges same-name contacts upstream so a
      // name uniquely picks one phone within this batch.
      const nameToPhone = indexBatchByName(batch);
      const phoneToName = new Map(batch.map((c) => [c.normalized, c.name]));
      // Flat per-contact name+hint cards are ONLY sent in constrained mode,
      // where there are no seed clusters and the model needs the raw list to
      // slot contacts into the user's fixed groups. In the hybrid path we
      // deliberately do NOT send them: the model would re-derive its own
      // clusters (and group names) independently from the full list instead
      // of working from our locally-computed seed clusters. There it sees
      // ONLY the seed clusters (which already carry their member names).
      let contactCards = null;
      let seedClustersByName = null;
      let prompt;
      if (constrained) {
        contactCards = buildContactCards(batch);
        prompt = buildConstrainedPrompt({
          contactCards,
          existingGroups,
          userProfile,
        });
      } else {
        // Seed clusters the LLM sees include:
        //   - legacy label/surname clusters (family / friend / surname hints)
        //   - partition's already-committed groups (Helpers, Office – X)
        // We send phone-keyed local groups through the same phoneToName map
        // so the LLM sees member names. For partition groups whose members
        // are NOT in this batch (because they were filtered out), we still
        // emit the group with an empty member list — that signals to the
        // model "this workplace already exists, prefer more like it".
        // Both seed sources need the same shape: keep group name/category
        // but translate phone members to names. These member names are the
        // ONLY contact data the hybrid prompt carries — there is no flat
        // contact-card list — so the model clusters from the seeds, not from
        // an independently re-derived view of the whole address book.
        const toNameSeed = (g) => ({
          name: g.name,
          categoryId: g.categoryId,
          members: (g.members || [])
            .map((p) => phoneToName.get(p))
            .filter(Boolean),
        });
        const legacySeeds = Object.values(clusters)
          .map(toNameSeed)
          .filter((g) => g.members.length);
        const partitionSeeds = partition.localGroups.map(toNameSeed);
        // Order the seeds the LLM sees: named label / group seeds (Friends –
        // General, Helpers, Office – X) first in their incoming order,
        // then the anonymous "Cluster: <token>" seeds sorted by member count
        // descending so the biggest, highest-signal clusters lead. A seed is a
        // bare cluster iff its name carries the "Cluster: " prefix. This
        // mirrors the display order in the proposal modal's Local / Sent tabs.
        const isBareCluster = (g) => /^Cluster: /.test(g.name);
        seedClustersByName = [...legacySeeds, ...partitionSeeds].sort((a, b) => {
          const ba = isBareCluster(a);
          const bb = isBareCluster(b);
          if (ba !== bb) return ba ? 1 : -1;
          if (!ba) return 0;
          return b.members.length - a.members.length;
        });
        prompt = buildPrompt({ seedClustersByName, userProfile });
      }
      let result;
      if (provider === 'google') {
        result = await callGemini(key, prompt);
      } else if (provider === 'openrouter') {
        result = await callOpenRouter(key, prompt);
      } else {
        result = await callOpenAi(key, prompt);
      }
      const raw = result?.text || '';
      tokens += result?.tokens || 0;
      if (onProgress) {
        onProgress({ batchIndex: i + 1, batchCount: batches.length, tokens });
      }
      const { parsed, reason: parseReason } = parseModelResponse(raw);
      // Explain WHY a batch failed to parse. A truncation (finishReason
      // MAX_TOKENS / length) means the reply outgrew the model's output-token
      // budget and the JSON was cut off — distinct from malformed JSON, and
      // fixable by sending a smaller batch. We prefer that explanation over
      // the generic "not valid JSON" when the provider tells us it truncated.
      const finishReason = result?.finishReason || null;
      const truncated = /^(max_tokens|length)$/i.test(finishReason || '');
      const parseFailReason = parsed
        ? null
        : truncated
          ? `Reply hit the model's output-token limit (finishReason: ${finishReason}) and the JSON was cut off before completing. This batch had ${batch.length} contacts — a smaller batch would let the full reply fit.`
          : parseReason;
      if (!parsed) {
        console.warn(
          `[connect/categorization] batch ${i + 1}/${batches.length} parse failed: ${parseFailReason}`,
        );
      }
      // Capture this batch in the trace. Raw response is held in full for
      // small batches; truncated past 12k chars to keep memory bounded for
      // very large address books. parsedGroups carries the LLM's response
      // pre-sanitise / pre-constraint so the modal can show what the model
      // actually returned before our post-processing.
      const RAW_CAP = 12000;
      trace.llm.batches.push({
        index: i,
        contactCount: batch.length,
        contactCards,
        seedClusters: seedClustersByName,
        rawResponseSize: raw.length,
        rawResponse: raw.length > RAW_CAP ? `${raw.slice(0, RAW_CAP)}…` : raw,
        parsedGroups: parsed
          ? (parsed.groups || []).map((g) => ({
              name: g?.name || '',
              categoryId: g?.categoryId || 'unknown',
              memberNames: Array.isArray(g?.members) ? g.members : [],
            }))
          : null,
        parseFailed: !parsed,
        parseFailReason,
        finishReason,
      });
      if (!parsed) continue;
      const batchSanitised = sanitiseGroups(parsed, nameToPhone);
      mergeGroupsByKey(
        batchSanitised,
        (g) => `${g.categoryId}::${g.name.toLowerCase()}`,
      ).forEach((value, key) => {
        if (!aggregated.has(key)) {
          aggregated.set(key, value);
        } else {
          const existing = aggregated.get(key);
          existing.members = [...new Set([...existing.members, ...value.members])];
        }
      });
    }
  } catch (err) {
    console.warn('[connect/categorization] LLM call failed:', err?.message || err);
    const errMsg = err?.message || 'LLM failed';
    if (isAuthError(errMsg)) {
      return { source: 'invalid_key', groups: [], tokens, error: errMsg };
    }
    return { source: 'llm_failed', groups: [], tokens, error: errMsg };
  }

  // Merge local partition groups (helpers + declared-workplace office) with the LLM
  // groups before the final constraint pass. enforceConstraints handles
  // dedup, suffix-stripping, and hallucination rejection.
  let llmGroups = [...aggregated.values()];
  trace.llm.totalTokens = tokens;
  // Constrained mode: even though the prompt forbids new groups, models
  // occasionally hallucinate a new label. Drop those at the engine layer so
  // the proposal handed to the UI/apply step only ever contains existing
  // groups — keeps the trace and the "Proposed" tab honest, and means
  // applyProposal never reports groupsSkipped for this path.
  if (constrained) {
    const allowedKeys = new Set(
      existingGroups.map((g) => `${g.categoryId}::${(g.name || '').toLowerCase()}`),
    );
    const before = llmGroups.length;
    llmGroups = llmGroups.filter((g) =>
      allowedKeys.has(`${g.categoryId}::${(g.name || '').toLowerCase()}`),
    );
    trace.llm.constrainedDropped = before - llmGroups.length;
  }
  if (llmGroups.length === 0 && partition.localGroups.length === 0) {
    // In constrained mode, distinguish "model returned nothing" from
    // "model returned only groups outside the allowed list" — the latter
    // is actionable (user knows their existing groups didn't cover the
    // LLM's grouping intuition).
    const dropped = trace.llm.constrainedDropped || 0;
    const error = constrained && dropped > 0
      ? `The model proposed ${dropped} new ${dropped === 1 ? 'group' : 'groups'} instead of slotting contacts into your existing ones. Nothing matched.`
      : 'LLM returned no groups';
    return {
      source: 'llm_empty',
      groups: [],
      tokens,
      error,
      trace,
    };
  }
  const groups = finalise([
    ...withOrigin(partition.localGroups, 'local'),
    ...withOrigin(llmGroups, 'llm'),
  ]);
  return { source: 'llm', groups, tokens, trace, nameByPhone };
};
