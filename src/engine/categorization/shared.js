import { CATEGORIES } from '../../storage';

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

// Merge a list of groups into a Map keyed by `keyFn(group)`. When two groups
// share a key, their members are concatenated (deduplicated by phone). Used
// in both the per-batch LLM accumulator and the final constraint pass so the
// "two groups with the same name get folded into one" behaviour can't drift.
export const mergeGroupsByKey = (groups, keyFn) => {
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

// Tokens that look like company-name suffixes — stripped before we use the
// company string as a group key. Keeps "Acme Inc" / "Acme Inc." / "ACME
// Pvt. Ltd." / "Acme (India)" from generating three separate Office groups.
const COMPANY_SUFFIX_TOKENS =
  /\b(inc|inc\.|incorporated|llc|llp|ltd|ltd\.|limited|pvt|pvt\.|private|co|co\.|corp|corp\.|corporation|company|gmbh|sa|ag|pte|plc|holdings|group|technologies|tech|labs|systems|solutions|software|services|enterprises)\b/gi;

// Normalised company key used for grouping. Strips suffixes, punctuation,
// parenthesised qualifiers ("(India)", "(NYC)"), and casefolds.
export const normaliseCompanyKey = (s) =>
  (s || '')
    .toString()
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[.,&]/g, ' ')
    .replace(COMPANY_SUFFIX_TOKENS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Ordered, de-duplicated list of the workplaces the user actually declared,
// extracted from the alias→canonical map produced by buildUserWorkplaceMap.
// Many aliases point at one workplace, so we collapse by canonicalKey
// (first-seen wins, preserving the user's declared order). Returns a
// Map<canonicalKey, canonicalDisplay>. Consumed by the office logic to (a)
// emit a compulsory "Office – <name>" group for every declared workplace and
// (b) recognise a colleague group as a declared office so it's never dropped
// or downgraded.
export const declaredOffices = (userWorkplaceAliases) => {
  const out = new Map();
  (userWorkplaceAliases ? [...userWorkplaceAliases.values()] : []).forEach(
    ({ canonicalKey, canonicalDisplay }) => {
      if (canonicalKey && !out.has(canonicalKey)) {
        out.set(canonicalKey, canonicalDisplay);
      }
    },
  );
  return out;
};

const STOP_TOKENS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'jr', 'sr', 'sir', 'madam', 'uncle', 'aunty', 'aunt', 'auntie',
  'bhai', 'bhaiya', 'didi', 'sahab', 'ji', 'the', 'of', 'and'
]);

export const tokens = (s) =>
  (s || '')
    .toString()
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1 && !STOP_TOKENS.has(t));

// Like tokens(), but preserves each token's original casing instead of
// casefolding. Identical splitting / filtering rules, so a raw token lines up
// index-for-index with the lowercased tokens() output for the same string.
// The clusterer uses this to recover the on-screen spelling of a name token
// (e.g. an all-caps "IITB") after matching case-insensitively.
export const rawTokens = (s) =>
  (s || '')
    .toString()
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP_TOKENS.has(t.toLowerCase()));

// ---- Stage 1: local clustering -------------------------------------------

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
export const normaliseNameKey = (s) =>
  (s || '')
    .toString()
    .normalize('NFD')                  // decompose accented characters
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritic marks
    .replace(/[^a-zA-Z0-9\s]/g, ' ')   // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
