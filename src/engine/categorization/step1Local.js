import { declaredOffices, normaliseCompanyKey, rawTokens, tokens } from './shared';

// ---- Tuning constants ----------------------------------------------------
// Decisions that were previously inline magic numbers, hoisted here so every
// clustering / alias-derivation threshold is visible and adjustable in one
// place rather than buried in the function bodies below.

// A name needs at least this many tokens before the name-token pass clusters
// on it — fewer than 2 means there's no distinct first vs last name to key on.
const MIN_NAME_TOKENS_TO_CLUSTER = 2;

// Single-character tokens are too ambiguous to seed a cluster (stray
// initials). tokens() already drops length-1 tokens; the name-token pass
// guards explicitly too.
const MIN_CLUSTER_TOKEN_LENGTH = 2;

// A name-token cluster is only emitted once at least this many DISTINCT
// contacts share the token — keeps one-off coincidences out of the seeds.
const LAST_NAME_MIN_MEMBERS = 2;

// Workplace-alias derivation (deriveWorkplaceAliases):
//   - need ≥2 capitals before treating them as a CamelCase short form
//     ("theNB" → "NB"); a single capital is just an ordinary initial.
const MIN_CAPITALS_FOR_CAMELCASE_ALIAS = 2;
//   - need ≥2 meaningful words before building an initialism
//     ("Delhi Public School" → "DPS").
const MIN_WORDS_FOR_INITIALS_ALIAS = 2;
//   - only derive substring-prefix aliases for single-word names at least
//     this long, so we don't clip short names like "Stripe" / "Acme" and
//     match unrelated tokens.
const MIN_NAME_LENGTH_FOR_PREFIX_ALIAS = 8;
//   - the substring-prefix lengths to emit ("Finmechanics" → "Finmec",
//     "Finmech").
const PREFIX_ALIAS_LENGTHS = [6, 7];

// Hand-picked, deliberately small. We are not trying to be a CRM tagger.
const LABEL_HINTS = [
  // Family / Helpers are single-instance "standard" categories — the engine
  // always collapses every relatives group into one "Family" and every
  // helpers group into one "Helpers" (see collapseToSingleton + the reserved-
  // name coercion in step4). So they use the bare standard name, NOT a
  // "– General" catch-all suffix (which only applies to multi-group
  // categories like Friends / Office that also hold specific sub-groups).
  { id: 'family-tag', name: 'Family', categoryId: 'relatives',
    regex: /\b(mom|mum|mother|dad|father|papa|mama|bro(?:ther)?|sis(?:ter)?|cousin|uncle|aunt(?:y|ie)?|nani|dadi|chacha|mami|mamu|bhai|behen|didi)\b/i },
  { id: 'friend-tag', name: 'Friends – General', categoryId: 'friends',
    regex: /\b(friend|buddy|bestie|yaar|dost)\b/i },
  { id: 'work-tag', name: 'Office – General', categoryId: 'colleagues',
    regex: /\b(office|work|boss|manager|colleague|hr|admin|ceo|cto|cfo|client)\b/i },
  { id: 'helper-tag', name: 'Helpers', categoryId: 'helpers',
    regex: /\b(driver|maid|cook|gardener|plumber|electrician|mechanic|guard|watchman|tutor|nurse|doctor|chemist|pharmacy|tailor|carpenter|chef|delivery|courier)\b/i },
];

// Helper keywords. If any of these appear as a whole-word match in the
// contact's `note`, `label`, or `name`, we route the contact straight into
// the "Helpers" group without consulting the LLM. Mirrors the in-prompt
// guidance so local and LLM agree on what counts as a service contact.
const HELPER_KEYWORD_RE =
  /\b(driver|maid|cook|chef|gardener|maali|plumber|electrician|mechanic|guard|watchman|chowkidar|society|tutor|coach|nurse|tailor|carpenter|painter|dhobi|istri|courier|delivery|milkman|doodhwala|kaamwali|bai|sweeper|nanny|helper|office\s*boy|chemist|pharmacy)\b/i;

const clusterByLabels = (contacts) => {
  const out = {};
  LABEL_HINTS.forEach((hint) => {
    const members = [];
    contacts.forEach((c) => {
      if (hint.regex.test(`${c?.name || ''} ${c?.label || ''}`)) {
        members.push(c.normalized);
      }
    });
    if (members.length) {
      out[hint.id] = {
        id: hint.id,
        name: hint.name,
        categoryId: hint.categoryId,
        // How this cluster was filled — surfaced in the proposal modal.
        source: 'label',
        members,
      };
    }
  });
  return out;
};

// Surnames so common across unrelated Indian contacts that a shared
// last-name token is noise, not signal: a "Cluster: Singh" or "Cluster:
// Kumar" would lump together colleagues, friends, and acquaintances who have
// nothing to do with each other. We skip these in the LAST-NAME pass only —
// honorifics are already stripped globally by STOP_TOKENS (shared.js); this
// is the surname-position analogue. Tune freely; all entries must be
// lowercase since tokens() casefolds before matching.
const COMMON_SURNAME_STOP = new Set([
  'kumar', 'kumari', 'singh', 'devi', 'kaur', 'sharma', 'verma', 'gupta',
  'patel', 'shah', 'jain', 'agarwal', 'aggarwal', 'mehta', 'das', 'lal',
  'prasad', 'yadav', 'khan', 'sheikh', 'syed', 'ali', 'begum', 'bano',
  'uncle', 'aunty'
]);

// The name positions we cluster on. A token can be a given name for one
// contact and a surname for another, so we scan BOTH the first and last
// token. Listed first→last so the merged source label below stays stable.
// Each source may carry its own `stop` set: tokens that are valid names but
// too generic to seed a cluster in THAT position — e.g. common surnames in
// the last-name pass.
const NAME_TOKEN_SOURCES = [
  { source: 'first name', pick: (ts) => ts[0] },
  { source: 'last name', pick: (ts) => ts[ts.length - 1], stop: COMMON_SURNAME_STOP },
];

// "People who share a name token" pass. Clusters on the first AND last token
// and MERGES matches for the same token into ONE cluster — so "Cluster: Rao"
// holds everyone with "Rao" as a first OR last name, with a `source` label
// recording which position(s) contributed ("first name", "last name", or
// "first & last name"). Only emits a cluster when at least
// LAST_NAME_MIN_MEMBERS distinct contacts share the token, so we don't
// manufacture noise.
const clusterByNameTokens = (contacts) => {
  // token -> { members: Set<phone>, sources: Set<string>, caps: string|null }
  const byToken = new Map();
  contacts.forEach((c) => {
    const ts = tokens(c?.name);
    if (ts.length < MIN_NAME_TOKENS_TO_CLUSTER) return;
    // Original-cased tokens, aligned index-for-index with `ts`, so we can
    // recover how a matched token was actually spelled in the address book.
    const raw = rawTokens(c?.name);
    NAME_TOKEN_SOURCES.forEach(({ source, pick, stop }) => {
      const token = pick(ts);
      if (!token || token.length < MIN_CLUSTER_TOKEN_LENGTH) return;
      if (stop && stop.has(token)) return;
      if (!byToken.has(token)) {
        byToken.set(token, { members: new Set(), sources: new Set(), caps: null });
      }
      const entry = byToken.get(token);
      entry.members.add(c.normalized);
      entry.sources.add(source);
      // Caps take preference on screen: matching stays case-insensitive, but
      // if ANY contact wrote this token entirely in capitals (e.g. "IITB",
      // "NRI") we keep that all-caps spelling for display rather than
      // title-casing it. First all-caps spelling seen wins.
      const rawToken = pick(raw);
      if (!entry.caps && rawToken && rawToken === rawToken.toUpperCase()) {
        entry.caps = rawToken;
      }
    });
  });
  const out = {};
  // Emit clusters in alphabetical token order so the seeds, trace, and any
  // local-only proposal list them consistently regardless of the order
  // contacts happened to appear in the address book.
  const sortedTokens = [...byToken.keys()].sort((a, b) => a.localeCompare(b));
  sortedTokens.forEach((token) => {
    const { members, sources, caps } = byToken.get(token);
    if (members.size < LAST_NAME_MIN_MEMBERS) return;
    const id = `cluster-${token}`;
    // An all-caps spelling, if any contact used one, beats the default
    // title-case ("iitb"/"IITB" → "IITB"; "rao" → "Rao").
    const titled = caps || token.charAt(0).toUpperCase() + token.slice(1);
    const fromFirst = sources.has('first name');
    const fromLast = sources.has('last name');
    const source =
      fromFirst && fromLast
        ? 'first & last name'
        : fromFirst
          ? 'first name'
          : 'last name';
    // "Cluster: X" — explicit prefix so the LLM understands this
    // is a name-token signal (people sharing this token in their
    // address-book name), not a categorisation claim. Replaces the older
    // "X family" naming which leaked past `categoryId: 'unknown'` and
    // primed the model toward the relatives category, even when common
    // surnames (Sharma, Patel, Singh) appeared across unrelated colleagues
    // and friends.
    out[id] = {
      id,
      name: `Cluster: ${titled}`,
      categoryId: 'unknown',
      source,
      members: [...members],
    };
  });
  return out;
};

/**
 * Pure: takes contacts (and an optional call-log summary), returns candidate
 * clusters. Always assigns a categoryId — defaults to 'unknown' when the
 * signal is too weak. Each cluster also carries a `source` label describing
 * how it was filled (e.g. "label", "first & last name"), for the
 * proposal-modal display.
 *
 * @param {Array} contacts - cleaned contacts (must have `normalized`, `name`)
 * @returns {Object<string, {id, name, categoryId, source, members:Array<string>}>}
 */
export const buildCandidateClusters = ({ contacts }) => {
  const list = (contacts || []).filter((c) => c?.normalized && c?.name);
  const merged = {
    ...clusterByLabels(list),
    ...clusterByNameTokens(list),
  };
  // Global sort across ALL passes (labels + name-token) alphabetically by
  // display name. The per-pass sort inside clusterByNameTokens only orders
  // within that pass; this is the order the consumers (seeds, trace, local
  // proposal) actually see.
  const sorted = {};
  Object.values(merged)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((c) => {
      sorted[c.id] = c;
    });
  return sorted;
};

// ---- Stage 1b: partition (authoritative local assignment) ----------------
//
// Splits the cleaned contact list into:
//   - localGroups  — groups we're confident enough to commit without LLM.
//                    Currently: Helpers + Office – <user-declared workplace>.
//   - llmBatch     — everything else. Passed to stage 2.
//   - assigned     — Set of normalized phones that were claimed locally,
//                    used to dedupe when merging with LLM output.
//
// The LLM never sees the locally-assigned contacts, which is where the cost
// saving comes from. Family is intentionally NOT partitioned — surname-only
// signal is too weak to commit without the model's semantic check. Contacts
// whose company field matches a DECLARED workplace are claimed here; a
// company that matches no declared workplace is left for the LLM, which may
// still cluster it into its own "Office – <X>" group.
export const isHelperContact = (c) => {
  const haystack = `${c?.note || ''} ${c?.label || ''} ${c?.name || ''}`;
  return HELPER_KEYWORD_RE.test(haystack);
};

// Pre-builds "Office – <canonical>" clusters from user-declared workplaces.
// Runs BEFORE the LLM and is the authoritative owner of every declared
// workplace:
//   - EVERY declared workplace gets a group, pre-seeded empty, so it appears
//     in the proposal even when no contact matches it (compulsory groups).
//   - A contact is claimed into a workplace when ANY of its cues point at it:
//       * a declared alias's parts all appear as tokens in the contact's
//         name, note, label, or company field, OR
//       * the contact's structured `company` field normalises straight to a
//         declared alias key (covers multi-word companies whose tokens don't
//         line up one-to-one).
//     Token-level matching (via `tokens()`) means "Naveen Tiwari" never
//     matches the "NT" alias — only a separate "NT" token does.
// A claimed contact is removed from the LLM batch, so these assignments are
// final and can never be misrouted or downgraded later.
//
// `userWorkplaceAliases` is the Map produced by buildUserWorkplaceMap:
// every alias key (`ms`, `microsoft`, `nt`, `thenb`, …)
// points at `{ canonicalKey, canonicalDisplay }`.
//
// Returns { groupsByCanonical: Map<canonicalKey, { display, members }>,
//           assigned: Set<phone> }.
const partitionByUserWorkplaces = (contacts, userWorkplaceAliases) => {
  const groupsByCanonical = new Map();
  const assigned = new Set();
  // Compulsory: seed an (empty) group for every declared workplace up front.
  declaredOffices(userWorkplaceAliases).forEach((display, canonicalKey) => {
    groupsByCanonical.set(canonicalKey, { display, members: [] });
  });
  if (!userWorkplaceAliases || userWorkplaceAliases.size === 0) {
    return { groupsByCanonical, assigned };
  }
  contacts.forEach((c) => {
    // Cue bag: name + note + label + company tokens. Users scatter the
    // workplace across any of these fields, so we pool them all.
    const bag = new Set(tokens(c?.name));
    tokens(`${c?.note || ''} ${c?.label || ''} ${c?.company || ''}`).forEach(
      (t) => bag.add(t),
    );
    const companyKey = normaliseCompanyKey(c?.company);
    userWorkplaceAliases.forEach(({ canonicalKey, canonicalDisplay }, aliasKey) => {
      // Match if every whitespace-separated part of the alias is present as a
      // token in the bag (handles multi-word aliases like "Stripe India"), OR
      // the company field normalises exactly to this alias key.
      const aliasParts = aliasKey.split(/\s+/).filter(Boolean);
      const tokenMatch = aliasParts.length > 0 && aliasParts.every((p) => bag.has(p));
      const companyMatch = !!companyKey && companyKey === aliasKey;
      if (!tokenMatch && !companyMatch) return;
      if (!groupsByCanonical.has(canonicalKey)) {
        groupsByCanonical.set(canonicalKey, {
          display: canonicalDisplay,
          members: [],
        });
      }
      groupsByCanonical.get(canonicalKey).members.push(c.normalized);
      assigned.add(c.normalized);
    });
  });
  return { groupsByCanonical, assigned };
};

export const partitionContactsForLlm = (
  contacts,
  { userWorkplaceAliases } = {},
) => {
  const list = (contacts || []).filter((c) => c?.normalized && c?.name);
  const assigned = new Set();
  const helperMembers = [];

  // Pre-pass: claim every contact whose name, note, label, OR company field
  // points at a user-declared workplace, and seed a (possibly empty) group
  // for every declared workplace. A workplace the user explicitly typed into
  // their profile is ground truth, so we commit these locally and skip the
  // model — they can't be misrouted or downgraded downstream.
  const userWorkplaceResult = partitionByUserWorkplaces(
    list,
    userWorkplaceAliases,
  );
  userWorkplaceResult.assigned.forEach((p) => assigned.add(p));

  list.forEach((c) => {
    if (assigned.has(c.normalized)) return;
    if (isHelperContact(c)) {
      helperMembers.push(c.normalized);
      assigned.add(c.normalized);
    }
  });

  const localGroups = [];
  // Emit user-declared workplace groups first — they're the strongest signal
  // and we want them at the top of the proposal. EVERY declared workplace is
  // emitted, including empty ones (zero matching contacts), so the group is
  // always present for the user to confirm or slot people into.
  userWorkplaceResult.groupsByCanonical.forEach(({ display, members }) => {
    localGroups.push({
      name: `Office – ${display}`,
      categoryId: 'colleagues',
      members: [...new Set(members)],
    });
  });
  if (helperMembers.length) {
    localGroups.push({
      name: 'Helpers',
      categoryId: 'helpers',
      members: [...new Set(helperMembers)],
    });
  }

  const llmBatch = list.filter((c) => !assigned.has(c.normalized));
  return { localGroups, llmBatch, assigned };
};

// ---- Stage 2: LLM refinement ---------------------------------------------

// Stop-words skipped when computing "first letter of each word"
// abbreviations. "Indian Institute OF Technology" → "IIT", not "IIOT".
const ALIAS_STOP_WORDS = new Set([
  'of', 'the', 'a', 'an', 'and', '&', 'at', 'in', 'on', 'for',
]);

// Auto-derive plausible short forms for a single workplace name so the user
// doesn't have to type every abbreviation themselves. Three deterministic
// strategies:
//   1. CamelCase / PascalCase capital-letter concatenation
//      ("theNB" → "NB", "OpenAI" → "OAI").
//   2. Initials of space-separated words, skipping stop words
//      ("Delhi Public School" → "DPS",
//       "Indian Institute of Technology" → "IIT").
//   3. Substring prefixes of length 6 and 7 for names long enough that the
//      prefix is itself unambiguous ("Finmechanics" → "Finmec", "Finmech").
//      Guarded by an 8-character minimum so we don't clip ordinary short
//      names like "Stripe" or "Acme" and end up matching unrelated tokens.
// Non-obvious abbreviations (e.g. "FM" for "Finmechanics") can't be derived
// from spelling alone — the user can declare those explicitly with "/".
const deriveWorkplaceAliases = (workplace) => {
  const out = new Set();
  const original = (workplace || '').trim();
  if (!original) return [];
  out.add(original);

  const caps = original.match(/[A-Z]/g);
  if (caps && caps.length >= MIN_CAPITALS_FOR_CAMELCASE_ALIAS) {
    out.add(caps.join(''));
  }

  const words = original.split(/\s+/).filter(Boolean);
  const meaningful = words.filter(
    (w) => !ALIAS_STOP_WORDS.has(w.toLowerCase()),
  );
  if (meaningful.length >= MIN_WORDS_FOR_INITIALS_ALIAS) {
    out.add(meaningful.map((w) => w.charAt(0).toUpperCase()).join(''));
  }

  // Substring prefixes are safe only for single-word names: deriving
  // "Indian " from "Indian Institute of Technology" would falsely match
  // any contact with "Indian" in their name. For multi-word names the
  // initials strategy above already covers the typical short forms.
  if (words.length === 1 && original.length >= MIN_NAME_LENGTH_FOR_PREFIX_ALIAS) {
    PREFIX_ALIAS_LENGTHS.forEach((len) => out.add(original.slice(0, len)));
  }
  return [...out];
};

// Build the alias→canonical map from a user-declared workplace string like
// "Microsoft/MS". Every declared alias is then expanded through
// deriveWorkplaceAliases so the user only needs to type the canonical name
// in the common case — "Finmechanics" alone catches contacts named "Rohit
// Finmech". Manually-declared slash aliases handle the non-obvious cases
// ("FM" → only a human would know that maps to Finmechanics).
//
// Used by enforceConstraints to:
//   1. allow LLM-proposed colleague cues that match any alias (so the
//      downgrade-to-"Office" rule doesn't kill them when no contact has the
//      `company` field set),
//   2. rename groups whose cue is a non-canonical alias to the canonical
//      display, so two groups for the same workplace dedupe.
export const buildUserWorkplaceMap = (workplaces) => {
  const aliasToCanonical = new Map();
  (workplaces || []).forEach((entry) => {
    const declared = (entry || '')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!declared.length) return;
    const canonicalDisplay = declared[0];
    const canonicalKey = normaliseCompanyKey(canonicalDisplay);
    if (!canonicalKey) return;

    // Combined alias set: declared aliases ∪ auto-derived short forms of each.
    const allAliases = new Set();
    declared.forEach((d) => {
      deriveWorkplaceAliases(d).forEach((a) => allAliases.add(a));
    });

    allAliases.forEach((alias) => {
      const k = normaliseCompanyKey(alias);
      // First-claim wins: if "MS" was already mapped to a previously-listed
      // workplace, don't let a later one steal it. The order of the user's
      // input is preserved.
      if (k && !aliasToCanonical.has(k)) {
        aliasToCanonical.set(k, { canonicalKey, canonicalDisplay });
      }
    });
  });
  return aliasToCanonical;
};

// ---- Base-group recognition ----------------------------------------------
//
// "Base" groups are everything the user declared in the context / onboarding
// form: workplaces, schools, colleges, and places lived. The review UI
// protects these (e.g. hides the merge action) so a foundational group built
// from the user's own answers can't be merged away by accident.
//
// We reuse buildUserWorkplaceMap for EVERY declared list — it already splits
// "X/Y" aliases and derives short forms — and union them into one alias map.
// The lists feed different categories (workplaces → colleagues, the rest →
// friends), but base recognition is category-agnostic: it only asks "does
// this group's name reference something the user declared?".
export const buildDeclaredContextAliases = (userProfile) => {
  const lists = [
    userProfile?.workplaces,
    userProfile?.schools,
    userProfile?.colleges,
    userProfile?.placesStayed,
  ];
  const combined = new Map();
  lists.forEach((list) => {
    buildUserWorkplaceMap(list).forEach((v, k) => {
      if (!combined.has(k)) combined.set(k, v);
    });
  });
  return combined;
};

// Returns a predicate `(groupName) => boolean` that is true when the name
// references any declared-context entity. A name matches an alias when EVERY
// whitespace-separated part of that alias appears as a token in the name —
// so "Office – Finmechanics" matches "finmechanics", "DPS school" matches
// "dps", and "Stripe India crew" matches the multi-word "stripe india".
export const declaredContextMatcher = (aliasMap) => {
  const aliasParts = [...(aliasMap?.keys?.() || [])]
    .map((k) => k.split(/\s+/).filter(Boolean))
    .filter((parts) => parts.length);
  return (name) => {
    if (!aliasParts.length) return false;
    const bag = new Set(tokens(name));
    if (!bag.size) return false;
    return aliasParts.some((parts) => parts.every((p) => bag.has(p)));
  };
};
