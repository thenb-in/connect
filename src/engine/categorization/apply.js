import {
  getCategoryById,
  getContactGroupMap,
  getGroups,
  getManualContactsSet,
  setGroups,
} from '../../storage';
import { writeJson } from '../../utils/syncStoreMmkv';

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
