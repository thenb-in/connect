import { CATEGORY_ID } from '../../storage';
import { declaredOffices, mergeGroupsByKey, normaliseCompanyKey } from './shared';


// Post-LLM constraint pass. Applied to the merged (local + LLM) proposal so
// the user always sees the same shape regardless of source:
//   - Exactly one "Family" group in the relatives category (only fires if
//     a relatives group sneaks in from somewhere — the LLM is told not to
//     produce one).
//   - Colleagues / offices:
//       * Every user-declared "Office – <name>" survives verbatim and is
//         never downgraded or dropped — even with zero members (compulsory).
//       * Any colleague cue matching a declared workplace alias is UPGRADED:
//         renamed to the canonical declared name so it merges into that one
//         group.
//       * Every other LLM-inferred "Office – <X>" is kept as its own named
//         group — we trust the model and the user prunes in the modal. Only
//         a generic / empty colleague name collapses to plain "Office".
//   - Group names are deduped after stripping company suffixes so
//     "Office – Acme Inc" + "Office – Acme" + "Office – ACME Pvt Ltd"
//     collapse into one group.
//
// @param {Array}   groups
// @param {Object}  [opts]
// @param {Map<string,{canonicalKey,canonicalDisplay}>} [opts.userWorkplaceAliases]
//   alias → canonical map. Drives both the upgrade-to-canonical rename and
//   the "this is a declared office, never drop it" recognition.
// Strips a leading GENERIC office word ("Office" / "Work" / "Team" /
// "Colleagues") plus any trailing separator, leaving the specific workplace
// cue. The result distinguishes the two cases that matter:
//   "Office"            → ""        (a bare generic bucket)
//   "Office – Acme"     → "Acme"    (a real workplace — NOT generic)
//   "Acme"             → "Acme"
// The old check `/^office\b/.test(name)` matched ANYTHING starting with
// "Office", so every "Office – <name>" was wrongly classified generic and
// downgraded. Reducing to the cue and asking "is it empty?" fixes that.
const GENERIC_OFFICE_PREFIX = /^\s*(?:colleagues?|office|work|team)\b[\s:–-]*/i;
const officeCue = (name) => (name || '').replace(GENERIC_OFFICE_PREFIX, '').trim();

const OFFICE_PREFIX_RE = /^\s*office\s*[–\-]\s*/i;

const colleagueDedupeKey = (name) => {
  const stripped = (name || '').replace(OFFICE_PREFIX_RE, '');
  return normaliseCompanyKey(stripped);
};

export const enforceConstraints = (groups, {
  existingGroups = [],
  userWorkplaceAliases = new Map(),
  transforms = null,
} = {}) => {
  // Optional transform log. When `transforms` is supplied, every input group
  // pushes one entry describing what happened to it on the way to the
  // proposal: kept / collapsed / renamed / downgraded / merged / dropped.
  // Powers the "Transform" tab in the review modal so the user can see how
  // each LLM-reply group became a proposed group. Pure book-keeping — never
  // affects the returned groups. `origin` distinguishes model output ('llm')
  // from locally-partitioned groups ('local'), tagged via `__origin` on the
  // inputs by the caller.
  const logTransform = (g, action, toName, toCategoryId) => {
    if (!transforms) return;
    transforms.push({
      fromName: g?.name || '(unnamed)',
      fromCategoryId: g?.categoryId || 'unknown',
      fromCount: (g?.members || []).length,
      origin: g?.__origin || 'llm',
      action,
      toName: toName ?? null,
      toCategoryId: toName == null ? null : toCategoryId ?? g?.categoryId,
    });
  };

  // Declared workplaces, recognised by their canonical key, so a colleague
  // group naming one is never dropped (even empty) or downgraded.
  const canonicalKeys = new Set([...declaredOffices(userWorkplaceAliases).keys()]);
  const isDeclaredOffice = (g) =>
    g?.categoryId === CATEGORY_ID.COLLEAGUES &&
    canonicalKeys.has(colleagueDedupeKey(g?.name || ''));
  const hasMembers = (g) => g && Array.isArray(g.members) && g.members.length;

  // "Family" and "Helpers" are RESERVED, single-instance group names tied to
  // exactly one category. The model sometimes returns the right name but the
  // wrong categoryId (e.g. a "Family" group tagged `friends`, or "Helpers"
  // tagged `colleagues`), which would strand it in the wrong section and dodge
  // the singleton collapse below. Coerce the categoryId from the name so the
  // collapse + sectioning are driven by the canonical identity, not the
  // model's label.
  const RESERVED_CATEGORY_BY_NAME = {
    family: CATEGORY_ID.RELATIVES,
    helpers: CATEGORY_ID.HELPERS,
  };
  const coerceReserved = (g) => {
    const want = RESERVED_CATEGORY_BY_NAME[(g?.name || '').trim().toLowerCase()];
    return want && g.categoryId !== want ? { ...g, categoryId: want } : g;
  };

  // Keep groups with members, PLUS declared-office groups even when empty
  // (compulsory). Everything else with no resolvable members is dropped and
  // logged so the Transform tab accounts for every input.
  const cleaned = (groups || [])
    .filter((g) => hasMembers(g) || isDeclaredOffice(g))
    .map(coerceReserved);
  (groups || [])
    .filter((g) => !(hasMembers(g) || isDeclaredOffice(g)))
    .forEach((g) =>
      logTransform(g, 'Dropped — no members resolved to real contacts.', null),
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

  preserved.forEach((g) =>
    logTransform(
      g,
      `Kept unchanged — matches your existing "${g.name}" group.`,
      g.name,
      g.categoryId,
    ),
  );

  // Stage 1: collapse non-preserved relatives into one "Family" group,
  // and non-preserved helpers into one "Helpers" group. Preserved
  // relatives/helpers (e.g. user's manual "Cousins") keep their own
  // names — they're folded back in at Stage 3.
  const collapseToSingleton = (categoryId, name) => {
    const candidates = toNormalise.filter((g) => g.categoryId === categoryId);
    if (!candidates.length) return [];
    candidates.forEach((g) =>
      logTransform(
        g,
        g.name === name
          ? `Merged into the single "${name}" group.`
          : `Renamed to "${name}" and merged in — all ${categoryId} collapse into one group.`,
        name,
        categoryId,
      ),
    );
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

  // Stage 2: normalise colleagues group names. We DON'T verify or reject
  // workplaces any more — every inferred office is trusted and kept as its
  // own named group (the user prunes in the modal). The only transforms are:
  //   (a) generic / empty colleague label → the single shared "Office".
  //   (b) cue matches a user-declared workplace alias → UPGRADE: rename to
  //       the canonical declared name so it merges into that compulsory group.
  //   (c) anything else → keep the model's "Office – <X>" name verbatim.
  // Preserved colleague groups skip this — we trust the user's chosen name.
  const normalised = rest.map((g) => {
    if (g.categoryId !== CATEGORY_ID.COLLEAGUES) {
      logTransform(g, 'Kept as-is.', g.name, g.categoryId);
      return g;
    }
    const n = (g.name || '').trim();
    // Strip the caller's __origin transform-log tag so it doesn't leak into
    // the proposal handed back to the UI / apply step.
    const { __origin, ...gOut } = g;
    // Reduce to the specific workplace cue. ONLY a name that reduces to an
    // empty cue (bare "Office" / "Work" / "Team" / "Colleagues") is generic
    // and collapses to the shared "Office" bucket. A named office is never
    // downgraded.
    const cue = officeCue(n);
    if (!cue) {
      logTransform(g, 'Generic colleagues label — grouped under "Office".', 'Office', 'colleagues');
      return { ...gOut, name: 'Office' };
    }
    // Upgrade: cue matches a declared workplace alias → rename to the
    // canonical declared name so it merges into that compulsory group.
    // Otherwise keep the workplace name verbatim (no downgrade ever).
    const cueKey = normaliseCompanyKey(cue);
    const aliasHit = cueKey ? userWorkplaceAliases.get(cueKey) : null;
    const toName = `Office – ${aliasHit ? aliasHit.canonicalDisplay : cue}`;
    logTransform(
      g,
      aliasHit
        ? toName === n
          ? 'Matched a workplace you declared — kept.'
          : `Renamed to "${toName}" to match a workplace you declared.`
        : toName === n
          ? 'Kept the proposed workplace name.'
          : `Normalised to "${toName}".`,
      toName,
      'colleagues',
    );
    return { ...gOut, name: toName };
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
  ).values()]
    // Strip the caller's transform-log tag so it never reaches the proposal.
    // (Colleagues already drop it in the normalise map; preserved / non-
    // colleague groups carry it through mergeGroupsByKey's spread.) Base-group
    // tagging (declared-context protection) happens in step5, which has the
    // full user profile — not just the workplace aliases available here.
    .map(({ __origin, ...g }) => g);

  // No size-threshold filter. Previously we dropped any non-unknown group
  // with < 10% of the categorised pool to suppress noise, but now the user
  // sees and confirms (or removes) every proposed group in the modal before
  // anything is committed. The user is the threshold. Small spurious groups
  // can be removed with one tap.
  return merged;
};
