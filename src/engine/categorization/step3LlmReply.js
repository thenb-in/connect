import { CATEGORY_IDS, normaliseNameKey } from './shared';

// Parses the model's JSON reply. Returns { parsed, reason }: on success
// `parsed` is the object and `reason` is null; on failure `parsed` is null
// and `reason` is a short human-readable explanation of WHY it couldn't be
// parsed — surfaced in the "LLM reply" trace tab so a failed batch isn't just
// an opaque "parse failed". Three distinct failure modes:
//   - empty reply (often a safety block or an output-budget cutoff with no text)
//   - not valid JSON (truncation mid-stream, or stray prose around the JSON)
//   - valid JSON but missing the expected "groups" array (wrong shape)
export const parseModelResponse = (raw) => {
  if (!raw || !raw.trim()) {
    return { parsed: null, reason: 'Model returned an empty response.' };
  }
  let text = raw.trim();
  // Models occasionally wrap JSON in a fenced code block despite instructions.
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      parsed: null,
      reason: `Response was not valid JSON (${err?.message || 'parse error'}). Likely truncated mid-reply or wrapped in prose.`,
    };
  }
  if (!parsed || !Array.isArray(parsed.groups)) {
    return {
      parsed: null,
      reason: 'Parsed as JSON but had no "groups" array (unexpected shape).',
    };
  }
  return { parsed, reason: null };
};

// Translate the model's response (which only knows contact NAMES) back into
// phone-keyed group members via the per-batch name → phone map. Anything
// that isn't a known name is dropped — guards against hallucinated members.
export const sanitiseGroups = (parsed, nameToPhone) => {
  const groups = [];
  (parsed.groups || []).forEach((g) => {
    const name = (g?.name || '').toString().trim();
    if (!name) return;
    const categoryId = CATEGORY_IDS.includes(g?.categoryId) ? g.categoryId : 'unknown';
    const members = (g?.members || [])
      .map((m) => nameToPhone.get(normaliseNameKey(m)))
      .filter(Boolean);
    if (!members.length) return;
    groups.push({ name, categoryId, members });
  });
  return groups;
};
