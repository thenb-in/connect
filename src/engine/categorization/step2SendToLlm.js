import { CATEGORIES, getCachedGeminiModel, setCachedGeminiModel } from '../../storage';
import { normaliseNameKey } from './shared';



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
export const batchSizeForProvider = (p) => PROVIDER_BATCH_SIZE[p] || DEFAULT_BATCH_SIZE;

// Returns true when the LLM HTTP error looks like an authentication problem
// (bad key, expired key, missing key). Both Gemini ("API_KEY_INVALID",
// "API key not valid") and OpenAI ("Incorrect API key", 401) end up here.
export const isAuthError = (msg) => {
  if (!msg) return false;
  const s = String(msg).toLowerCase();
  if (/\b(401|403)\b/.test(s)) return true;
  return /(api[_ ]?key (not valid|invalid)|api_key_invalid|incorrect api key|invalid api key|unauthorized|invalid_argument)/i.test(
    s,
  );
};

export const indexBatchByName = (batch) => {
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

export const buildContactCards = (batch) =>
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

export const buildPrompt = ({ seedClustersByName, userProfile }) => {
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
    'Your input is a set of SEED CLUSTERS computed locally from the address',
    'book. Each cluster is a JSON object:',
    '  { "name": "<seed label, e.g. \\"Cluster: Rao\\", \\"Office – Acme\\">",',
    '    "categoryId": "<one of the closed list, or \\"unknown\\">",',
    '    "members": ["<contact display name>", ...] }',
    'The member names are the ONLY contact data you receive — there is no',
    'separate contact list and no side-channel hints (no company / note /',
    'city). Work entirely from the cluster labels and the member names.',
    '',
    'Process:',
    '1. Read each seed cluster and its members carefully.',
    '2. Decide what each cluster really represents from its label and the',
    '   member names — workplace, school/college cohort, hometown crew,',
    '   common surname (possibly family), honorific pattern, club, or pure',
    '   coincidence.',
    '3. ONLY THEN propose final groups. Do not invent groups that no member',
    '   fits into. You may merge members across clusters, split a cluster, or',
    '   leave members out.',
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
    '    * a college / school / club / batch marker visible in member names',
    '    * "Friends – General" seed → reuse exactly',
    '  Don\'t manufacture a generic "Friends" bucket from contacts with no',
    '  shared context — leave them out.',
    '- For categoryId "colleagues": ONLY assign when there is a real',
    '  workplace signal. PREFER multiple distinct "Office – <cue>" groups',
    '  over a single generic "Office". Acceptable signals:',
    '    * an existing "Office – <company>" seed (strongest — already a',
    '      confirmed workplace; route matching members to it)',
    '    * shared institution markers in the member names (e.g. "Rohit Acme",',
    '      "Anika @ Stripe", "Aman FM") that match a workplace pattern',
    '  A "Cluster: <X>" seed BY ITSELF is NOT a workplace signal — it could',
    '  just as easily be a college, hometown, or coincidence. Inspect the',
    '  member names; if none carries a workplace marker, the cluster belongs',
    '  in FRIENDS (or stays unassigned), not colleagues.',
    '  Examples of valid colleague names: "Office – Acme", "Office – Stripe",',
    '  "Office – Marketing". Prefer the canonical company name when you can',
    '  infer it from the markers in the member names.',
    '  Only fall back to a single plain "Office" group when NO member in the',
    '  batch carries any workplace marker at all.',
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
    '- Refer to a contact by its EXACT name as it appears in a cluster\'s',
    '  "members". Do not paraphrase, truncate, or invent names.',
    '',
    'Seed clusters (computed locally from the address book — each entry tells',
    'you WHAT was detected, not which category to use):',
    '  * "Friends – General" / "Office – General" — catch-all label buckets',
    '    for their category. "Family" / "Helpers" — the single standard group',
    '    for those categories. All are direct keyword matches on the contact',
    '    label or name.',
    '    The seed name itself names the category; reuse the exact group name',
    '    when appropriate.',
    '  * "Cluster: <token>" — multiple contacts share this token in their',
    '    name. The token could be a workplace, school/college, hometown,',
    '    club, common surname, or coincidence. The categoryId is "unknown"',
    '    on purpose — YOU decide what it means by inspecting the member',
    '    names. Specifically: do NOT default a "Cluster: <token>" to',
    '    colleagues. If none of its members carries a workplace marker, the',
    '    cluster is more likely a college/hometown/club (→ friends) or a',
    '    coincidence (→ leave out) than an office.',
    '  * Existing "Office – <company>" seeds came from the user\'s "company"',
    '    field — these are real workplaces. Do not duplicate; route matching',
    '    members to the existing seed by exact name.',
    JSON.stringify(seedClustersByName),
    '',
    'Respond with JSON in this exact shape:',
    '{"groups":[{"name":"<string>","categoryId":"<one of the closed list>","members":["<contact name>", ...]}]}',
  ].join('\n');
};

// Constrained-reassignment prompt. Used when the caller has supplied a
// fixed list of target groups (the "user already curated their groups, now
// just slot contacts in" path). The LLM may only assign each name to one of
// the listed groups or omit it — it may NOT propose new groups.
export const buildConstrainedPrompt = ({
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

export const callGemini = async (apiKey, prompt) => {
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
    // MAX_TOKENS here means the reply outgrew the output budget and the JSON
    // was cut off — the dominant cause of "parse failed" on big batches.
    finishReason: json?.candidates?.[0]?.finishReason || null,
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

export const callOpenAi = async (apiKey, prompt) => {
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
    // 'length' means the reply was truncated at max_tokens — JSON cut off.
    finishReason: json?.choices?.[0]?.finish_reason || null,
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

export const callOpenRouter = async (apiKey, prompt) => {
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
    finishReason: json?.choices?.[0]?.finish_reason || null,
  };
};
