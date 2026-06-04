import {
  CATEGORIES,
  CATEGORY_ID,
  getCachedGeminiModel,
  getCategoryById,
  getContactGroupMap,
  getGroups,
  getLlmConfig,
  getManualContactsSet,
  getUserProfile,
  setCachedGeminiModel,
  setGroups,
} from '../storage';
import { writeJson } from '../utils/syncStoreMmkv';

// ---------------------------------------------------------------------------
// Categorisation engine
// ---------------------------------------------------------------------------
// Hybrid pipeline. Given cleaned contacts, propose groups under the closed
// CATEGORIES (Friends, Relatives, Colleagues, Helpers, Unknown).
//
// Three stages:
//   1. Partition — pure, deterministic. Address-book fields (`company`,
//      `note`, label, name) are inspected and contacts with a strong local
//      signal are assigned directly:
//        - shared `company` field with ≥2 members → "Office – <company>"
//        - helper keyword in `note` / `label` / `name` → "Helpers"
//      These contacts are REMOVED from the LLM batch (they don't need the
//      model to decide). Everyone else passes through to stage 2.
//   2. LLM refinement — the remaining ambiguous contacts (mostly family /
//      friends / unsignalled) go to Gemini or OpenAI. The model produces
//      group proposals with names + categoryIds + member name lists.
//   3. Merge + constrain — local assignments and LLM groups are merged,
//      then `enforceConstraints` collapses to one Family / one Helpers,
//      normalises Office names, strips company suffixes, dedupes, and
//      rejects hallucinated workplaces. No size filter — the user sees
//      and confirms every group in the proposal modal before commit.
//
// If no LLM key is configured (or the user opts into useLocal), stage 2 is
// skipped — local partition + family-label / surname heuristics still
// produce a reasonable starter taxonomy.

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

// Merge a list of groups into a Map keyed by `keyFn(group)`. When two groups
// share a key, their members are concatenated (deduplicated by phone). Used
// in both the per-batch LLM accumulator and the final constraint pass so the
// "two groups with the same name get folded into one" behaviour can't drift.
const mergeGroupsByKey = (groups, keyFn) => {
  const byKey = new Map();
  groups.forEach((g) => {
    const key = keyFn(g);
    if (!byKey.has(key)) {
      byKey.set(key, { ...g, members: [...new Set(g.members)] });
      return;
    }
    const existing = byKey.get(key);
    existing.members = [...new Set([...existing.members, ...g.members])];
  });
  return byKey;
};

// Hand-picked, deliberately small. We are not trying to be a CRM tagger.
const LABEL_HINTS = [
  { id: 'family-tag', name: 'Family (from labels)', categoryId: 'relatives',
    regex: /\b(mom|mum|mother|dad|father|papa|mama|bro(?:ther)?|sis(?:ter)?|cousin|uncle|aunt(?:y|ie)?|nani|dadi|chacha|mami|mamu|bhai|behen|didi)\b/i },
  { id: 'friend-tag', name: 'Friends (from labels)', categoryId: 'friends',
    regex: /\b(friend|buddy|bestie|yaar|dost)\b/i },
  { id: 'work-tag', name: 'Office contacts', categoryId: 'colleagues',
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

// Tokens that look like company-name suffixes — stripped before we use the
// company string as a group key. Keeps "Acme Inc" / "Acme Inc." / "ACME
// Pvt. Ltd." / "Acme (India)" from generating three separate Office groups.
const COMPANY_SUFFIX_TOKENS =
  /\b(inc|inc\.|incorporated|llc|llp|ltd|ltd\.|limited|pvt|pvt\.|private|co|co\.|corp|corp\.|corporation|company|gmbh|sa|ag|pte|plc|holdings|group|technologies|tech|labs|systems|solutions|software|services|enterprises)\b/gi;

// Minimum members for a company-keyed local Office group. A solo company
// match isn't useful — let the LLM decide whether the contact belongs in a
// broader colleagues group or not at all.
const COMPANY_MIN_MEMBERS = 2;

// Normalised company key used for grouping. Strips suffixes, punctuation,
// parenthesised qualifiers ("(India)", "(NYC)"), and casefolds.
const normaliseCompanyKey = (s) =>
  (s || '')
    .toString()
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[.,&]/g, ' ')
    .replace(COMPANY_SUFFIX_TOKENS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Title-cased display form of a (possibly all-caps or all-lowercase) company
// name. We trust the user's casing when it's already mixed (e.g. "OpenAI"),
// otherwise we capitalise each word so "acme pvt ltd" doesn't shout in the
// UI.
const displayCompanyName = (raw) => {
  const s = (raw || '').toString().trim();
  if (!s) return s;
  const hasMixedCase = /[a-z]/.test(s) && /[A-Z]/.test(s);
  if (hasMixedCase) return s;
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
};

const LAST_NAME_MIN_MEMBERS = 3;

const STOP_TOKENS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'jr', 'sr', 'sir', 'madam', 'uncle', 'aunty', 'aunt', 'auntie',
  'bhai', 'bhaiya', 'didi', 'sahab', 'ji', 'the', 'of', 'and', 'office', 'home', 'work',
]);

const tokens = (s) =>
  (s || '')
    .toString()
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1 && !STOP_TOKENS.has(t));

// ---- Stage 1: local clustering -------------------------------------------

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
      out[hint.id] = { id: hint.id, name: hint.name, categoryId: hint.categoryId, members };
    }
  });
  return out;
};

const clusterByLastName = (contacts) => {
  // A simple "people who share a last token (probably last name)" pass. Only
  // produces a candidate group when at least LAST_NAME_MIN_MEMBERS contacts
  // share the token, so we don't manufacture noise.
  const byToken = new Map();
  contacts.forEach((c) => {
    const ts = tokens(c?.name);
    if (ts.length < 2) return;
    const last = ts[ts.length - 1];
    if (last.length < 3) return;
    if (!byToken.has(last)) byToken.set(last, []);
    byToken.get(last).push(c.normalized);
  });
  const out = {};
  byToken.forEach((members, token) => {
    if (members.length < LAST_NAME_MIN_MEMBERS) return;
    const id = `lname-${token}`;
    const titled = token.charAt(0).toUpperCase() + token.slice(1);
    // "Cluster: X" — explicit prefix so the LLM understands this
    // is a name-token signal (people sharing this last token in their
    // address-book name), not a categorisation claim. Replaces the older
    // "X family" naming which leaked past `categoryId: 'unknown'` and
    // primed the model toward the relatives category, even when common
    // surnames (Sharma, Patel, Singh) appeared across unrelated colleagues
    // and friends.
    out[id] = {
      id,
      name: `Cluster: ${titled}`,
      categoryId: 'unknown',
      members,
    };
  });
  return out;
};

/**
 * Pure: takes contacts (and an optional call-log summary), returns candidate
 * clusters. Always assigns a categoryId — defaults to 'unknown' when the
 * signal is too weak.
 *
 * @param {Array} contacts - cleaned contacts (must have `normalized`, `name`)
 * @returns {Object<string, {id, name, categoryId, members:Array<string>}>}
 */
export const buildCandidateClusters = ({ contacts }) => {
  const list = (contacts || []).filter((c) => c?.normalized && c?.name);
  return {
    ...clusterByLabels(list),
    ...clusterByLastName(list),
  };
};

// ---- Stage 1b: partition (authoritative local assignment) ----------------
//
// Splits the cleaned contact list into:
//   - localGroups  — groups we're confident enough to commit without LLM.
//                    Currently: Helpers + Office – <company> clusters.
//   - llmBatch     — everything else. Passed to stage 2.
//   - assigned     — Set of normalized phones that were claimed locally,
//                    used to dedupe when merging with LLM output.
//
// The LLM never sees the locally-assigned contacts, which is where the cost
// saving comes from. Family is intentionally NOT partitioned — surname-only
// signal is too weak to commit without the model's semantic check.
const isHelperContact = (c) => {
  const haystack = `${c?.note || ''} ${c?.label || ''} ${c?.name || ''}`;
  return HELPER_KEYWORD_RE.test(haystack);
};

// Pre-builds "Office – <canonical>" clusters from user-declared workplace
// aliases against contact-name tokens. Runs BEFORE the LLM so contacts with
// a name like "Rohit MS" or "Anika Mircosoft" land in the right group
// without depending on the model spotting the cue. Token-level matching
// (via `tokens()`) means "Naveen Tiwari" never matches the "NT" alias —
// only contacts with "NT" as a separate token do.
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
  if (!userWorkplaceAliases || userWorkplaceAliases.size === 0) {
    return { groupsByCanonical, assigned };
  }
  contacts.forEach((c) => {
    const nameTokens = new Set(tokens(c?.name));
    if (!nameTokens.size) return;
    // Also include note/label tokens — users sometimes drop the company
    // into the note field instead of the structured `company` slot.
    const extraTokens = tokens(`${c?.note || ''} ${c?.label || ''}`);
    extraTokens.forEach((t) => nameTokens.add(t));
    userWorkplaceAliases.forEach(({ canonicalKey, canonicalDisplay }, aliasKey) => {
      // Match if every whitespace-separated part of the alias is present
      // as a token in the contact's name. Handles multi-word aliases like
      // "Stripe India" too.
      const aliasParts = aliasKey.split(/\s+/).filter(Boolean);
      if (!aliasParts.length) return;
      const allMatch = aliasParts.every((p) => nameTokens.has(p));
      if (!allMatch) return;
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
  const byCompany = new Map();

  // Pre-pass: claim every contact whose name carries a token matching a
  // user-declared workplace alias. These groups are authoritative — they
  // win over the company-field partition (in the rare event the user has
  // BOTH a declared workplace and a different `company` on a contact, the
  // declaration is the stronger signal because it came from the user
  // explicitly setting up Connect).
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
      return;
    }
    const key = normaliseCompanyKey(c.company);
    if (!key) return;
    if (!byCompany.has(key)) {
      byCompany.set(key, { display: displayCompanyName(c.company), members: [] });
    }
    byCompany.get(key).members.push(c.normalized);
  });

  const localGroups = [];
  // Emit user-declared workplace groups first — they're the strongest
  // signal and we want them visible at the top of the proposal.
  userWorkplaceResult.groupsByCanonical.forEach(({ display, members }) => {
    const unique = [...new Set(members)];
    if (!unique.length) return;
    localGroups.push({
      name: `Office – ${display}`,
      categoryId: 'colleagues',
      members: unique,
    });
  });
  if (helperMembers.length) {
    localGroups.push({
      name: 'Helpers',
      categoryId: 'helpers',
      members: [...new Set(helperMembers)],
    });
  }
  byCompany.forEach(({ display, members }) => {
    const unique = [...new Set(members)];
    if (unique.length < COMPANY_MIN_MEMBERS) return;
    localGroups.push({
      name: `Office – ${display}`,
      categoryId: 'colleagues',
      members: unique,
    });
    unique.forEach((m) => assigned.add(m));
  });

  const llmBatch = list.filter((c) => !assigned.has(c.normalized));
  return { localGroups, llmBatch, assigned };
};

// ---- Stage 2: LLM refinement ---------------------------------------------

// Per-provider batch ceilings. Sized to fit one call for most personal
// address books (<2000 contacts) so we save round-trips and let the model
// reason over the whole list at once — better cross-batch clustering and
// less wall-clock time. Numbers come from:
//   - Gemini Flash family: 250k input / ~8k output. At ~5 tokens per name
//     plus prompt overhead, ~8k contacts is the practical ceiling before
//     we eat into the output budget for the response groups.
//   - GPT-4o-mini: 128k input / 16k output. Output is the binding limit
//     for clusters-with-members, so 1500 contacts is the safe ceiling.
//   - OpenRouter defaults to Gemini Flash → same as Google.
// Falls back to a conservative default if the provider is unknown.
const PROVIDER_BATCH_SIZE = {
  google: 8000,
  openai: 1500,
  openrouter: 8000,
};
const DEFAULT_BATCH_SIZE = 1500;
const batchSizeForProvider = (p) => PROVIDER_BATCH_SIZE[p] || DEFAULT_BATCH_SIZE;

// Returns true when the LLM HTTP error looks like an authentication problem
// (bad key, expired key, missing key). Both Gemini ("API_KEY_INVALID",
// "API key not valid") and OpenAI ("Incorrect API key", 401) end up here.
const isAuthError = (msg) => {
  if (!msg) return false;
  const s = String(msg).toLowerCase();
  if (/\b(401|403)\b/.test(s)) return true;
  return /(api[_ ]?key (not valid|invalid)|api_key_invalid|incorrect api key|invalid api key|unauthorized|invalid_argument)/i.test(
    s,
  );
};

// The contact NAME is the only thing the model actually needs to cluster on
// — phone numbers don't help and are pure PII. We send names only, and
// translate the model's response back to phones via a local name → phone
// map. cleanupContacts merges same-name contacts upstream so name is a
// safe primary key within a batch.
//
// Normalisation strips diacritics, punctuation, and case so that "Dr.
// Sharma" / "Dr Sharma" / "dr sharma", or "José" / "Jose", all collide on
// the same key. Without this the model's slight reformatting (a common
// failure mode that ends as "LLM returned no groups") drops every match.
const normaliseNameKey = (s) =>
  (s || '')
    .toString()
    .normalize('NFD')                  // decompose accented characters
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritic marks
    .replace(/[^a-zA-Z0-9\s]/g, ' ')   // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const indexBatchByName = (batch) => {
  const nameToPhone = new Map();
  batch.forEach((c) => {
    const key = normaliseNameKey(c.name);
    if (!key) return;
    if (!nameToPhone.has(key)) nameToPhone.set(key, c.normalized);
  });
  return nameToPhone;
};

// Squashes the side-channel fields the LLM cares about into a single short
// hint string per contact. We deliberately keep this small — the model
// already eats prompt-overhead per row, and most contacts have no hints at
// all so the JSON stays compact. Order matters: workplace cues are the
// strongest clustering signal, then role/title, then birthday/city which
// mostly help disambiguate honorifics.
const buildContactHint = (c) => {
  const parts = [];
  const company = (c.company || '').trim();
  const jobTitle = (c.jobTitle || '').trim();
  const department = (c.department || '').trim();
  if (company || jobTitle || department) {
    const work = [jobTitle, department, company].filter(Boolean).join(' · ');
    if (work) parts.push(`work: ${work}`);
  }
  const note = (c.note || '').trim();
  // Notes often carry workplace details ("met at Acme, marketing team")
  // that are the LLM's only signal when `company` isn't filled. 80 was too
  // tight — bumped to 200 since input tokens aren't the binding constraint
  // (output tokens are).
  if (note) parts.push(`note: ${note.slice(0, 200)}`);
  const city = (c.postalAddresses?.[0]?.city || '').trim();
  if (city) parts.push(`city: ${city}`);
  return parts.join(' | ');
};

const buildContactCards = (batch) =>
  batch.map((c) => {
    const hint = buildContactHint(c);
    return hint ? { name: c.name, hint } : { name: c.name };
  });

// Inserts a "what the user told us about themselves" section into the prompt.
// Every field is optional; when nothing is filled we emit nothing so the
// prompt stays compact. The exact strings the user typed land verbatim — the
// model gets to do the fuzzy matching against contact-name cues.
//
// Slash-separated entries are treated as aliases for the same thing. The
// first alias is the canonical name the LLM should use in group titles, the
// others are alternate forms it should match against contact names but
// never use as the group title.
const buildUserProfileBlock = (profile) => {
  if (!profile) return null;
  const lines = [];
  if (profile.schools?.length) {
    lines.push(`- Schools attended: ${profile.schools.join(', ')}`);
  }
  if (profile.colleges?.length) {
    lines.push(`- Colleges / universities attended: ${profile.colleges.join(', ')}`);
  }
  if (profile.workplaces?.length) {
    lines.push(`- Workplaces (past or present): ${profile.workplaces.join(', ')}`);
  }
  if (profile.placesStayed?.length) {
    lines.push(`- Places lived in: ${profile.placesStayed.join(', ')}`);
  }
  if (profile.savingLogic) {
    lines.push(`- How the user typically labels / saves contacts: ${profile.savingLogic}`);
  }
  if (!lines.length) return null;
  return [
    'About the user (use this to match contact-name cues to real',
    'institutions / cohorts — it is GROUND TRUTH the user volunteered):',
    ...lines,
    '',
    'How to use these facts:',
    '- Slash-separated entries ("Microsoft/MS", "theNB/NT") are explicit',
    '  ALIASES the user typed for the same workplace / school / place.',
    '  Bucket every contact whose name carries ANY alias into ONE group',
    '  and name it after the FIRST alias (the canonical form).',
    '- For each declared workplace / school / college, ALSO brainstorm',
    '  likely short forms BEFORE scanning contacts. Consider:',
    '    * Substring prefixes — "Finmechanics" → "Finmech", "Finmec".',
    '    * Initials of compound words — "Delhi Public School" → "DPS",',
    '      "Indian Institute of Technology" → "IIT".',
    '    * Two-letter short forms a human might invent —',
    '      "Finmechanics" → "FM"; "TheNoteBank" → "NB";',
    '      "Goldman Sachs" → "GS". The user can\'t list every short form',
    '      they personally use; be alert for these in contact names.',
    '- When a contact name carries a token matching a declared name OR',
    '  any of the short forms above, that is a STRONG colleagues signal —',
    '  assign the contact to colleagues even without a "work:" hint and',
    '  name the group "Office – <canonical>".',
    '  Worked example: with "Workplaces: Finmechanics", the contacts',
    '  "Rohit FM", "Priya Finmech", "Anika Finmechanics" all belong in a',
    '  single "Office – Finmechanics" group.',
    '- When a "Cluster: <token>" or institution marker matches one of',
    '  these, prefer naming the group after the canonical name (e.g.',
    '  "IIT-B friends", "Office – Finmechanics", "Mumbai crew") instead',
    '  of a generic label.',
  ].join('\n');
};

const buildPrompt = ({ contactCards, seedClustersByName, userProfile }) => {
  const categoryList = CATEGORIES.map((c) => c.id).join(', ');
  const profileBlock = buildUserProfileBlock(userProfile);
  return [
    'You are helping organise a personal contact list into small, intuitive',
    'groups. The user is Indian, so the contact list reflects Indian naming',
    'and social conventions. Every group must be tagged to exactly one',
    `category from this closed list: [${categoryList}].`,
    '',
    ...(profileBlock ? [profileBlock, ''] : []),
    'Cultural context (important):',
    '- "Uncle" / "Aunty" / "Aunti" / "Bhaiya" / "Didi" / "Sir" / "Madam" /',
    '  "Ji" are commonly used as RESPECTFUL HONORIFICS for any senior or',
    '  acquaintance, not just blood relatives. Do NOT assume "X Uncle" or',
    '  "Y Aunty" is family. Use other cues (Clusters, household',
    '  context, role hint) to decide.',
    '- Role/service cues like "Driver", "Maid", "Cook", "Bai", "Didi"',
    '  (when paired with a service role), "Watchman", "Guard", "Society",',
    '  "Electrician", "Plumber", "Carpenter", "Painter", "Tailor", "Dhobi",',
    '  "Istri", "Maali" / "Gardener", "Milkman", "Doodhwala", "Kaamwali",',
    '  "Sweeper", "Tutor", "Coach", "Nanny", "Helper", "Office Boy", and',
    '  shop/vendor names usually indicate a HELPER, not a relative or',
    '  friend.',
    '',
    'Each contact is a JSON object:',
    '  { "name": "<display name, may include prefix/suffix like Dr., PhD>",',
    '    "hint": "<optional. May contain: work: <jobTitle · department ·',
    '             company> | note: <free text> | city: <city>>" }',
    'The "hint" field, when present, is GROUND TRUTH from the user\'s address',
    'book — trust it over surname guesses. e.g. a "work:" hint means the',
    'contact almost certainly belongs in a "colleagues" group keyed off that',
    'company; a clear service-role "note:" hint strongly implies helpers.',
    '',
    'Process:',
    '1. Read the contact list below carefully.',
    '2. Identify natural social clusters from BOTH the names and the hints —',
    '   workplace/department from "work:" hints, role from "note:" hints,',
    '   clusters, institution markers, nicknames, honorific patterns.',
    '3. ONLY THEN propose groups based on those clusters. Do not invent groups',
    '   that no contact fits into.',
    '',
    'Rules:',
    '- Output STRICT JSON, no prose.',
    '- A contact can appear in multiple groups.',
    '- For categoryId "relatives": output AT MOST ONE group, named exactly',
    '  "Family". Include the FULL extended family — not just the nuclear',
    '  household. Collapse parents, siblings, spouse, children, cousins,',
    '  in-laws, grandparents, aunts, uncles, nieces, nephews, and any',
    '  further-out kin into this single group. Common Indian-family cues',
    '  include explicit relation labels like "Mom", "Dad", "Bhai", "Behen",',
    '  "Didi", "Bhaiya", "Chacha", "Chachi", "Tau", "Tai", "Mama", "Mami",',
    '  "Mausi", "Mausa", "Bua", "Fufa", "Nana", "Nani", "Dada", "Dadi",',
    '  "Jiju", "Bhabhi", "Devar", "Nanad", "Saala", "Sasur", "Saas",',
    '  "Samdhi", "Cousin", "Bro" / "Sis" when paired with a family name,',
    '  and a clearly shared family surname across multiple contacts. A bare',
    '  "Uncle" / "Aunty" label on its own is NOT enough — pair it with a',
    '  clusters or another family cue before including.',
    '- For categoryId "friends": group by shared SOCIAL context — college /',
    '  school cohort, hometown / neighborhood crew, hobby club, online',
    '  community, batch. Examples: "IITB friends", "DPS school", "Goa',
    '  group", "Cricket buddies", "College batch". Use these signals:',
    '    * "Cluster: <X>" seed where X looks like an educational',
    '      institution (IIT, IIM, DTU, BITS, NIT, VIT, IISc, NLU, AIIMS,',
    '      St., DPS, KV, …) → name the group "<X> friends" or "<X> alumni"',
    '    * "Cluster: <X>" seed where X is a hometown, city, or neighborhood',
    '      label → name like "<X> group" or "<X> crew"',
    '    * "note:" hint mentioning college / school / club / batch',
    '    * "Friends (from labels)" seed → reuse exactly',
    '  Don\'t manufacture a generic "Friends" bucket from contacts with no',
    '  shared context — leave them out.',
    '- For categoryId "colleagues": ONLY assign when there is a real',
    '  workplace signal. PREFER multiple distinct "Office – <cue>" groups',
    '  over a single generic "Office". Acceptable signals:',
    '    * "work:" hint with a company / department / jobTitle (strongest)',
    '    * "note:" hint explicitly mentioning a workplace, team, or company',
    '    * shared institution markers in the contact name (e.g. "Rohit Acme",',
    '      "Anika @ Stripe") that match a workplace pattern',
    '  A "Cluster: <X>" seed BY ITSELF is NOT a workplace signal — it could',
    '  just as easily be a college, hometown, or coincidence. Inspect the',
    '  contacts\' hints; if none have a workplace cue, the cluster belongs',
    '  in FRIENDS (or stays unassigned), not colleagues.',
    '  Examples of valid colleague names: "Office – Acme", "Office – Stripe",',
    '  "Office – Marketing". Prefer the company name from the "work:" hint',
    '  over department or job title when both are present.',
    '  For EVERY "Office – <cue>" group, include a "cueTokens" array: 2–5',
    '  short LITERAL substrings (each ≤ 20 chars) as they actually appear in',
    '  the contact data — both the canonical company name AND any short',
    '  forms / abbreviations you observed in contact names or hints. Example:',
    '  contacts saved as "Aman FM", "Riya FM" with company "Finmech" →',
    '  cueTokens: ["fm", "finmech"]. These tokens are checked against contact',
    '  text; if none appear, the group is collapsed into generic "Office".',
    '  Only fall back to a single plain "Office" group when NO contact in the',
    '  batch has any workplace signal at all.',
    '  Group all contacts sharing the same workplace cue into the SAME',
    '  "Office – <company>" group — do not split a single company across',
    '  multiple groups.',
    '  Small workplace clusters (even 2 people) are valuable; do NOT collapse',
    '  them into a generic "Office" just because they\'re small.',
    '- For categoryId "helpers": output AT MOST ONE group, named exactly',
    '  "Helpers". Put service / household / society / vendor / tradesperson',
    '  contacts here (driver, maid, cook, watchman, electrician, plumber,',
    '  tailor, milkman, gardener, tutor, etc.). When a contact is clearly a',
    '  service provider but has no family or workplace cue, prefer',
    '  "helpers" over leaving them out.',
    '- If a contact doesn\'t fit any clear group, leave them out instead of',
    '  forcing them in.',
    '- Refer to a contact by its EXACT name from the list. Do not paraphrase,',
    '  truncate, or invent names.',
    '',
    'Contacts:',
    JSON.stringify(contactCards),
    '',
    'Seed signals (computed locally from the address book — each entry tells',
    'you WHAT was detected, not which category to use):',
    '  * "Friends (from labels)" / "Family (from labels)" / "Office contacts"',
    '    / "Helpers" — direct keyword matches on the contact label or name.',
    '    The seed name itself names the category; reuse the exact group name',
    '    when appropriate.',
    '  * "Cluster: <token>" — multiple contacts share this token in their',
    '    name. The token could be a workplace, school/college, hometown,',
    '    club, common surname, or coincidence. The categoryId is "unknown"',
    '    on purpose — YOU decide what it means by inspecting the contacts',
    '    and their hints. Specifically: do NOT default a "Cluster: <token>"',
    '    to colleagues. If none of its contacts has a workplace ("work:")',
    '    hint, the cluster is more likely a college/hometown/club (→ friends)',
    '    or a coincidence (→ leave out) than an office.',
    '  * Existing "Office – <company>" seeds came from the user\'s "company"',
    '    field — these are real workplaces. Do not duplicate; route matching',
    '    contacts to the existing seed by exact name.',
    JSON.stringify(seedClustersByName),
    '',
    'Respond with JSON in this exact shape (cueTokens is REQUIRED for any',
    '"Office – <cue>" group, optional/omitted everywhere else):',
    '{"groups":[{"name":"<string>","categoryId":"<one of the closed list>","members":["<contact name>", ...],"cueTokens":["<literal substring>", ...]}]}',
  ].join('\n');
};

// Constrained-reassignment prompt. Used when the caller has supplied a
// fixed list of target groups (the "user already curated their groups, now
// just slot contacts in" path). The LLM may only assign each name to one of
// the listed groups or omit it — it may NOT propose new groups.
const buildConstrainedPrompt = ({
  contactCards,
  existingGroups,
  userProfile,
}) => {
  const groupList = existingGroups
    .map((g) => `  - "${g.name}" (categoryId: ${g.categoryId})`)
    .join('\n');
  const profileBlock = buildUserProfileBlock(userProfile);
  return [
    'You are slotting Indian personal contacts into a FIXED list of groups',
    'the user has already curated. Do NOT invent, rename, or remove groups.',
    'For each contact, decide which (if any) of the listed groups it belongs',
    'to. A contact may belong to multiple groups. Contacts with no good fit',
    'should be left out.',
    '',
    ...(profileBlock ? [profileBlock, ''] : []),
    'Available groups:',
    groupList,
    '',
    'Each contact is a JSON object:',
    '  { "name": "<display name>",',
    '    "hint": "<optional. work: <jobTitle · department · company> |',
    '             note: <free text> | city: <city>>" }',
    'The "hint" field, when present, is ground truth from the user\'s address',
    'book — trust it over surname guesses.',
    '',
    'Cultural context (important):',
    '- "Uncle" / "Aunty" / "Bhaiya" / "Didi" / "Sir" / "Madam" / "Ji" are',
    '  Indian honorifics, not necessarily family. Pair with other cues',
    '  (clusters, household context) before assigning to a family',
    '  group.',
    '- Role/service cues (driver, maid, cook, watchman, plumber, tailor,',
    '  electrician, gardener, milkman, tutor, etc.) indicate helpers.',
    '',
    'Rules:',
    '- Output STRICT JSON, no prose.',
    '- Refer to a contact by its EXACT name from the list. Do not paraphrase.',
    '- Use the EXACT group name from the list. Do not paraphrase.',
    '- If unsure, leave the contact out.',
    '',
    'Contacts:',
    JSON.stringify(contactCards),
    '',
    'Respond with JSON in this exact shape:',
    '{"groups":[{"name":"<exact group name>","categoryId":"<exact categoryId>","members":["<contact name>", ...]}]}',
  ].join('\n');
};

// Static fallback list. Just the current Gemini Flash Lite — older versions
// have been deprecated and only add 404 noise. Resilience for future
// renames comes from the ListModels discovery path below, not from
// hardcoding many generations.
const GEMINI_FALLBACK_MODELS = [
  'gemini-3.1-flash-lite',
];

// Preference order for the dynamic-discovery path. We always want the
// newest "flash-lite" variant first — flash-lite is the cost/speed sweet
// spot for "cluster these names". If nothing matches we accept any flash
// model, then any model the key can access at all.
const GEMINI_PREFERRED_PATTERNS = [
  /^gemini-\d+(?:\.\d+)?-flash-lite(-\d+)?$/,
  /^gemini-\d+(?:\.\d+)?-flash(-\d+)?$/,
  /flash-lite/,
  /flash/,
  /./,
];

/**
 * Asks Google for the list of generateContent-capable models for this API
 * key. Returns plain model names like "gemini-2.5-flash". On any failure we
 * return null and let the caller fall back to the static list — categorise
 * should still work even if ListModels itself is hosed.
 */
const listGeminiModels = async (apiKey) => {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return (json?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => (m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  } catch {
    return null;
  }
};

const pickGeminiModel = (available) => {
  if (!available?.length) return null;
  for (const pattern of GEMINI_PREFERRED_PATTERNS) {
    const match = available.find((m) => pattern.test(m));
    if (match) return match;
  }
  return available[0];
};

const resolveGeminiModel = async (apiKey, { forceRefresh = false } = {}) => {
  if (!forceRefresh) {
    const cached = getCachedGeminiModel();
    if (cached) return cached;
    // Cold start: skip ListModels and use the static fallback. This saves a
    // ~500-1500ms round-trip on the very first categorisation. If the
    // fallback was deprecated, callGemini will see a 404 and re-enter this
    // function with forceRefresh=true — only paying the discovery cost
    // when it's actually needed.
    return GEMINI_FALLBACK_MODELS[0];
  }
  const available = await listGeminiModels(apiKey);
  const picked = pickGeminiModel(available || []) || GEMINI_FALLBACK_MODELS[0];
  if (picked) setCachedGeminiModel(picked);
  return picked;
};

const callGeminiOnce = async (apiKey, prompt, model) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

// Statuses we retry once on. 429 = quota burst, 502/503/504 = upstream
// hiccups (e.g. "model experiencing high demand and is temporarily
// unavailable"). A single retry with a short delay usually clears these
// without papering over real errors.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_RETRY_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const callGemini = async (apiKey, prompt) => {
  let model = await resolveGeminiModel(apiKey);
  let res = await callGeminiOnce(apiKey, prompt, model);

  // If the cached model 404s, Google likely deprecated/renamed it. Clear
  // the cache, re-discover, and retry once with whatever ListModels now
  // returns — so the user doesn't need an app update to keep working.
  if (res.status === 404) {
    setCachedGeminiModel(null);
    const fresh = await resolveGeminiModel(apiKey, { forceRefresh: true });
    if (fresh && fresh !== model) {
      model = fresh;
      res = await callGeminiOnce(apiKey, prompt, model);
    }
  }

  if (TRANSIENT_STATUSES.has(res.status)) {
    await sleep(TRANSIENT_RETRY_MS);
    res = await callGeminiOnce(apiKey, prompt, model);
  }

  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = await res.json();
  return {
    text: json?.candidates?.[0]?.content?.parts?.[0]?.text || '',
    tokens: json?.usageMetadata?.totalTokenCount || 0,
  };
};

const callOpenAiOnce = (apiKey, prompt) =>
  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You categorise personal contact lists.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

const callOpenAi = async (apiKey, prompt) => {
  let res = await callOpenAiOnce(apiKey, prompt);
  if (TRANSIENT_STATUSES.has(res.status)) {
    await sleep(TRANSIENT_RETRY_MS);
    res = await callOpenAiOnce(apiKey, prompt);
  }
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = await res.json();
  return {
    text: json?.choices?.[0]?.message?.content || '',
    tokens: json?.usage?.total_tokens || 0,
  };
};

// OpenRouter is OpenAI-compatible, so the request body shape is shared. The
// only differences are the host, an optional referrer/title header for their
// dashboard, and the prefixed model name (`<provider>/<model>`). We default
// to Gemini 2.5 flash via OpenRouter to keep the cost/quality profile in
// line with the direct-Google path.
const callOpenRouterOnce = (apiKey, prompt) =>
  fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://callbuddy.app',
      'X-Title': 'CallBuddy Connect',
    },
    body: JSON.stringify({
      model: 'google/gemini-3.1-flash-lite',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You categorise personal contact lists.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

const callOpenRouter = async (apiKey, prompt) => {
  let res = await callOpenRouterOnce(apiKey, prompt);
  if (TRANSIENT_STATUSES.has(res.status)) {
    await sleep(TRANSIENT_RETRY_MS);
    res = await callOpenRouterOnce(apiKey, prompt);
  }
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = await res.json();
  return {
    text: json?.choices?.[0]?.message?.content || '',
    tokens: json?.usage?.total_tokens || 0,
  };
};

const parseModelResponse = (raw) => {
  if (!raw) return null;
  let text = raw.trim();
  // Models occasionally wrap JSON in a fenced code block despite instructions.
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.groups)) return parsed;
    return null;
  } catch {
    return null;
  }
};

// Generic workplace words we filter out of cueTokens — they'd false-positive
// against almost any "work:" hint and tell us nothing about whether the
// LLM's specific cue ("Finmech", "TheNB") is real.
const CUE_TOKEN_DENYLIST = new Set([
  'office', 'work', 'team', 'company', 'corp', 'inc', 'ltd', 'llc', 'pvt',
]);

// Translate the model's response (which only knows contact NAMES) back into
// phone-keyed group members via the per-batch name → phone map. Anything
// that isn't a known name is dropped — guards against hallucinated members.
// For colleagues groups we also preserve `cueTokens` (literal short
// substrings the LLM claims to have observed in the data); enforceConstraints
// verifies these against actual contact text to reject hallucinated
// workplaces.
const sanitiseGroups = (parsed, nameToPhone) => {
  const groups = [];
  (parsed.groups || []).forEach((g) => {
    const name = (g?.name || '').toString().trim();
    if (!name) return;
    const categoryId = CATEGORY_IDS.includes(g?.categoryId) ? g.categoryId : 'unknown';
    const members = (g?.members || [])
      .map((m) => nameToPhone.get(normaliseNameKey(m)))
      .filter(Boolean);
    if (!members.length) return;
    const out = { name, categoryId, members };
    if (Array.isArray(g?.cueTokens)) {
      // Slash-separated entries are split into individual tokens — same
      // convention as workplace aliases in the user profile, so the LLM
      // can emit either ["fm", "finmech"] or ["fm/finmech"] and we'll
      // handle both. Dedup with a Set since the LLM occasionally repeats.
      const seen = new Set();
      const cueTokens = [];
      g.cueTokens
        .flatMap((t) =>
          typeof t === 'string'
            ? t.split('/').map((s) => s.trim().toLowerCase())
            : [],
        )
        .forEach((t) => {
          if (
            t.length >= 2 &&
            t.length <= 32 &&
            !CUE_TOKEN_DENYLIST.has(t) &&
            !seen.has(t)
          ) {
            seen.add(t);
            cueTokens.push(t);
          }
        });
      if (cueTokens.length) out.cueTokens = cueTokens.slice(0, 8);
    }
    groups.push(out);
  });
  return groups;
};

// Post-LLM constraint pass. Applied to the merged (local + LLM) proposal so
// the user always sees the same shape regardless of source:
//   - Exactly one "Family" group in the relatives category (only fires if
//     a relatives group sneaks in from somewhere — the LLM is told not to
//     produce one).
//   - "Office" (or "Office – <cue>") in the colleagues category. A non-
//     generic colleague cue is trusted when it matches a user-declared
//     workplace alias, OR a member's `company` field matches the cue, OR
//     the LLM-emitted `cueTokens` have enough literal evidence in the
//     members' hint text (handles "FM" → "Finmech"-style shortforms).
//     Otherwise the cue is treated as hallucinated and downgraded to
//     plain "Office".
//   - Group names are deduped after stripping company suffixes so
//     "Office – Acme Inc" + "Office – Acme" + "Office – ACME Pvt Ltd"
//     collapse into one group.
//
// @param {Array}   groups
// @param {Object}  [opts]
// @param {Map<string,string>} [opts.phoneToCompanyKey] - phone → normalised
//   company key. Verifies a colleague cue against the `company` field.
// @param {Map<string,string>} [opts.phoneToHintText]   - phone → lower-cased
//   rollup of every text field the LLM saw. Used to verify LLM-emitted
//   `cueTokens` actually appear in the data.
const OFFICE_GENERIC = /^(colleagues?|office|work|team)\b/i;
const OFFICE_PREFIX_RE = /^\s*office\s*[–\-]\s*/i;

const colleagueDedupeKey = (name) => {
  const stripped = (name || '').replace(OFFICE_PREFIX_RE, '');
  return normaliseCompanyKey(stripped);
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Verifies LLM-emitted cueTokens against the actual contact text the LLM
// saw. Each token is matched case-insensitively with word boundaries
// against the lower-cased rollup of name + jobTitle + department + company
// + note + city. Threshold: at least min(2, groupSize) members must hit
// at least one of the group's tokens — so a 2+-member group needs 2 hits,
// a singleton needs 1. Word boundaries keep short tokens like "fm" from
// false-positing against "Information".
const verifyCueTokens = (members, cueTokens, phoneToHintText) => {
  if (!phoneToHintText || !cueTokens?.length || !members?.length) return false;
  const patterns = cueTokens
    .map((t) => (t || '').toString().trim().toLowerCase())
    .filter((t) => t.length >= 2)
    .map((t) => new RegExp(`\\b${escapeRegex(t)}\\b`, 'i'));
  if (!patterns.length) return false;
  const needed = Math.min(2, members.length);
  let hits = 0;
  for (const phone of members) {
    const blob = phoneToHintText.get(phone);
    if (blob && patterns.some((re) => re.test(blob))) {
      hits += 1;
      if (hits >= needed) return true;
    }
  }
  return false;
};

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
  if (caps && caps.length >= 2) {
    out.add(caps.join(''));
  }

  const words = original.split(/\s+/).filter(Boolean);
  const meaningful = words.filter(
    (w) => !ALIAS_STOP_WORDS.has(w.toLowerCase()),
  );
  if (meaningful.length >= 2) {
    out.add(meaningful.map((w) => w.charAt(0).toUpperCase()).join(''));
  }

  // Substring prefixes are safe only for single-word names: deriving
  // "Indian " from "Indian Institute of Technology" would falsely match
  // any contact with "Indian" in their name. For multi-word names the
  // initials strategy above already covers the typical short forms.
  if (words.length === 1 && original.length >= 8) {
    out.add(original.slice(0, 6));
    out.add(original.slice(0, 7));
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
const buildUserWorkplaceMap = (workplaces) => {
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

const enforceConstraints = (groups, {
  phoneToCompanyKey,
  phoneToHintText,
  existingGroups = [],
  userWorkplaceAliases = new Map(),
} = {}) => {
  const cleaned = (groups || []).filter(
    (g) => g && Array.isArray(g.members) && g.members.length,
  );

  // Names the user has already curated. A proposed group whose
  // (categoryId, name) matches one of these must survive Stage 1/2
  // verbatim — collapsing "Cousins" → "Family" or downgrading
  // "Office – Acme" → "Office" would strand the LLM's correct slotting,
  // since applyProposal can no longer match the renamed group against
  // any existing user group.
  const existingKeys = new Set(
    (existingGroups || [])
      .filter((g) => g && g.name && g.categoryId)
      .map((g) => `${g.categoryId}::${g.name.toLowerCase()}`),
  );
  const isExisting = (g) =>
    existingKeys.has(`${g.categoryId}::${(g.name || '').toLowerCase()}`);

  const preserved = cleaned.filter(isExisting);
  const toNormalise = cleaned.filter((g) => !isExisting(g));

  // Stage 1: collapse non-preserved relatives into one "Family" group,
  // and non-preserved helpers into one "Helpers" group. Preserved
  // relatives/helpers (e.g. user's manual "Cousins") keep their own
  // names — they're folded back in at Stage 3.
  const collapseToSingleton = (categoryId, name) => {
    const candidates = toNormalise.filter((g) => g.categoryId === categoryId);
    if (!candidates.length) return [];
    return [{
      name,
      categoryId,
      members: [...new Set(candidates.flatMap((g) => g.members))],
    }];
  };
  const familyGroup = collapseToSingleton(CATEGORY_ID.RELATIVES, 'Family');
  const helpersGroup = collapseToSingleton(CATEGORY_ID.HELPERS, 'Helpers');
  const rest = toNormalise.filter(
    (g) => g.categoryId !== CATEGORY_ID.RELATIVES && g.categoryId !== CATEGORY_ID.HELPERS,
  );

  // Stage 2: normalise colleagues group names AND reject hallucinated
  // workplace cues. A non-generic "Office – X" group must satisfy ONE of:
  //   (a) match a user-declared workplace alias from the profile — rename
  //       to the canonical display and trust the cue.
  //   (b) at least one member's `company` field normalises to the same key
  //       as the group's cue (the original strict check; covers contacts
  //       with the company column filled out).
  //   (c) the LLM emitted `cueTokens` and at least min(2, groupSize) of the
  //       members' hint text contains one of those tokens (word-boundary,
  //       case-insensitive). This is the FM-vs-Finmech path: the canonical
  //       company name never appears in contact text, but the abbreviation
  //       the LLM observed ("fm") does.
  // Otherwise the cue was invented and we downgrade to plain "Office".
  // Preserved colleague groups skip this — we trust the user's chosen name.
  const normalised = rest.map((g) => {
    if (g.categoryId !== 'colleagues') return g;
    const n = (g.name || '').trim();
    // cueTokens was verification-only metadata; strip from the output
    // regardless of which branch we hit so downstream consumers don't see it.
    const { cueTokens, ...gOut } = g;
    if (!n || OFFICE_GENERIC.test(n)) {
      return { ...gOut, name: 'Office' };
    }
    const cueKey = colleagueDedupeKey(n.startsWith('Office') ? n : `Office – ${n}`);
    const aliasHit = cueKey ? userWorkplaceAliases.get(cueKey) : null;
    if (aliasHit) {
      return { ...gOut, name: `Office – ${aliasHit.canonicalDisplay}` };
    }
    const companyMatch =
      !!(cueKey && phoneToCompanyKey) &&
      g.members.some((phone) => phoneToCompanyKey.get(phone) === cueKey);
    const cueTokenMatch =
      !companyMatch && verifyCueTokens(g.members, cueTokens, phoneToHintText);
    if (!companyMatch && !cueTokenMatch) {
      return { ...gOut, name: 'Office' };
    }
    return { ...gOut, name: n.startsWith('Office') ? n : `Office – ${n}` };
  });

  // Stage 3: merge duplicate groups. For colleagues we key off the
  // suffix-stripped company name so "Office – Acme Inc" and "Office – Acme"
  // collide; for everything else lowercase name is enough. Preserved
  // groups participate in the dedup map too — if the LLM happened to
  // emit the same name twice, those merge with the preserved entry.
  const dedupKey = (g) =>
    g.categoryId === CATEGORY_ID.COLLEAGUES
      ? `colleagues::${colleagueDedupeKey(g.name) || g.name.toLowerCase()}`
      : `${g.categoryId}::${g.name.toLowerCase()}`;
  const merged = [...mergeGroupsByKey(
    [...preserved, ...familyGroup, ...helpersGroup, ...normalised],
    dedupKey,
  ).values()];

  // No size-threshold filter. Previously we dropped any non-unknown group
  // with < 10% of the categorised pool to suppress noise, but now the user
  // sees and confirms (or removes) every proposed group in the modal before
  // anything is committed. The user is the threshold. Small spurious groups
  // can be removed with one tap.
  return merged;
};

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

  // ---- Trace ----
  // Populated as the pipeline runs and returned to the UI so the proposal
  // modal can show what local heuristics decided, what was sent to the LLM,
  // and what the LLM returned. Side-effect free; small enough to hold in
  // memory for a personal-scale address book.
  const phoneToFullName = new Map(list.map((c) => [c.normalized, c.name]));
  const resolveNames = (phones) =>
    (phones || []).map((p) => phoneToFullName.get(p) || p);
  const trace = {
    mode: constrained ? 'constrained' : useLocal ? 'local' : 'hybrid',
    local: {
      totalContacts: list.length,
      manualLocked: manualLockedCount,
      llmBatchSize: constrained ? list.length : partition.llmBatch.length,
      locallyAssigned: constrained ? 0 : partition.assigned.size,
      groups: partition.localGroups.map((g) => ({
        name: g.name,
        categoryId: g.categoryId,
        memberNames: resolveNames(g.members),
      })),
      legacyClusters: Object.values(clusters).map((c) => ({
        name: c.name,
        categoryId: c.categoryId,
        count: c.members.length,
      })),
    },
    llm: {
      skipped: false,
      constrained,
      batchCount: 0,
      batches: [],
      totalTokens: 0,
    },
  };

  // phone → normalised company key, used by enforceConstraints to verify
  // that LLM-proposed colleague groups have at least one member whose
  // company hint actually matches the cue (kills hallucinated workplaces).
  const phoneToCompanyKey = new Map();
  // phone → lower-cased rollup of every text field the LLM saw for that
  // contact. Used by enforceConstraints to verify LLM-emitted cueTokens
  // (e.g. ["fm", "finmech"]) actually appear in the data, even when the
  // canonical company string was never typed into the contact's company
  // field — the FM-vs-Finmech case.
  const phoneToHintText = new Map();
  list.forEach((c) => {
    const key = normaliseCompanyKey(c.company);
    if (key) phoneToCompanyKey.set(c.normalized, key);
    const blob = [
      c.name,
      c.jobTitle,
      c.department,
      c.company,
      c.note,
      c.postalAddresses?.[0]?.city,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (blob) phoneToHintText.set(c.normalized, blob);
  });

  // User's current groups — passed to enforceConstraints so any LLM
  // proposal whose (categoryId, name) matches a curated group keeps its
  // name verbatim (no collapse to "Family", no downgrade to "Office").
  // In constrained mode we already filter against this exact set before
  // finalise runs, so it's redundant there but harmless.
  const userGroups = getGroups()
    .filter((g) => g && g.name && g.categoryId)
    .map((g) => ({ name: g.name, categoryId: g.categoryId }));

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
      // we only drop empty member arrays and keep names as-is.
      return (groupsIn || []).filter(
        (g) => g && Array.isArray(g.members) && g.members.length,
      );
    }
    return enforceConstraints(groupsIn, {
      phoneToCompanyKey,
      phoneToHintText,
      existingGroups: userGroups,
      userWorkplaceAliases,
    });
  };

  // Local-only path (useLocal=true OR fallback when LLM batch is empty).
  // Includes the partition's authoritative locals plus the legacy
  // label/surname clusters so the user isn't left empty-handed.
  const buildLocalProposal = () =>
    finalise([
      ...partition.localGroups,
      ...Object.values(clusters).map((c) => ({
        name: c.name,
        categoryId: c.categoryId,
        members: c.members,
      })),
    ]);

  if (useLocal) {
    trace.llm.skipped = true;
    trace.llm.skipReason = 'useLocal';
    return { source: 'local', groups: buildLocalProposal(), tokens: 0, trace };
  }

  const { provider, key } = getLlmConfig();
  if (!provider || !key) {
    return { source: 'no_key', groups: [], tokens: 0, error: 'No LLM key configured' };
  }

  // Nothing left for the LLM after partitioning (rare: an address book
  // where every contact has a strong company hint). Skip the API call.
  if (!constrained && partition.llmBatch.length === 0) {
    trace.llm.skipped = true;
    trace.llm.skipReason = 'empty_batch';
    const groups = finalise(partition.localGroups);
    return { source: 'llm', groups, tokens: 0, trace };
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
      const contactCards = buildContactCards(batch);
      let seedClustersByName = null;
      let prompt;
      if (constrained) {
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
        // but translate phone members to names so the prompt only ever sees
        // names — same convention as the contactCards above.
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
        seedClustersByName = [...legacySeeds, ...partitionSeeds];
        prompt = buildPrompt({ contactCards, seedClustersByName, userProfile });
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
      const parsed = parseModelResponse(raw);
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
              // Surfaced as-is (pre-sanitise) so the LLM reply tab shows
              // exactly what the model returned, including any tokens that
              // would later be dropped by the denylist / length filter.
              cueTokens: Array.isArray(g?.cueTokens) ? g.cueTokens : undefined,
            }))
          : null,
        parseFailed: !parsed,
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

  // Merge local partition groups (helpers + office clusters) with the LLM
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
  const groups = finalise([...partition.localGroups, ...llmGroups]);
  return { source: 'llm', groups, tokens, trace };
};

// ---- Applying a proposal to MMKV ------------------------------------------

const slugify = (s) =>
  (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

/**
 * Persists a proposal into the user's groups & contactGroups, without
 * destroying existing manual edits:
 *
 *   - For each proposed group, if a group with the same (categoryId, name)
 *     already exists, reuse its id. Otherwise create one — unless
 *     `allowNewGroups` is false, in which case the proposed group (and its
 *     contact tags) is dropped.
 *   - For each contact, *merge* the proposed group ids into their existing
 *     contactGroups list — never replace, so manual corrections survive.
 *
 * Returns a summary { groupsCreated, contactsTagged, groupsSkipped }.
 */
export const applyProposal = (proposal, { allowNewGroups = true } = {}) => {
  const existing = getGroups();
  // Contacts the user has hand-edited — categorisation must leave them
  // alone, otherwise a re-run silently overwrites the user's manual call.
  const manual = getManualContactsSet();
  const byKey = new Map(existing.map((g) => [`${g.categoryId}::${g.name.toLowerCase()}`, g]));
  const nextGroups = [...existing];
  const propGroupIds = [];
  let groupsSkipped = 0;

  (proposal.groups || []).forEach((g) => {
    const key = `${g.categoryId}::${g.name.toLowerCase()}`;
    let group = byKey.get(key);
    if (!group) {
      if (!allowNewGroups) {
        groupsSkipped += 1;
        return;
      }
      const cat = getCategoryById(g.categoryId);
      group = {
        id: `g_${slugify(g.name) || 'auto'}_${Math.random().toString(36).slice(2, 6)}`,
        name: g.name,
        color: cat.color,
        categoryId: g.categoryId,
      };
      nextGroups.push(group);
      byKey.set(key, group);
    }
    propGroupIds.push({ group, members: g.members || [] });
  });

  setGroups(nextGroups);

  const map = getContactGroupMap();
  let contactsTagged = 0;
  const skippedManualSet = new Set();
  propGroupIds.forEach(({ group, members }) => {
    members.forEach((phone) => {
      if (manual.has(phone)) {
        skippedManualSet.add(phone);
        return;
      }
      const cur = new Set(map[phone] || []);
      if (cur.has(group.id)) return;
      cur.add(group.id);
      map[phone] = [...cur];
      contactsTagged += 1;
    });
  });
  writeJson('connect.contactGroups', map);

  const created = nextGroups.length - existing.length;
  return {
    groupsCreated: created,
    contactsTagged,
    groupsSkipped,
    contactsSkippedManual: skippedManualSet.size,
  };
};

