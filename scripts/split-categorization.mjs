import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SRC = 'src/engine/categorization.js';
const OUT = 'src/engine/categorization';
const lines = readFileSync(SRC, 'utf8').split('\n');

// Five big pipeline steps (mirroring the proposal-modal tabs), plus a shared
// helpers module, the orchestrator, the apply step, and a barrel.
const MAP = {
  // shared string / group helpers used by multiple steps
  CATEGORY_IDS: 'shared',
  mergeGroupsByKey: 'shared',
  COMPANY_SUFFIX_TOKENS: 'shared',
  normaliseCompanyKey: 'shared',
  STOP_TOKENS: 'shared',
  tokens: 'shared',
  normaliseNameKey: 'shared',

  // Step 1 — local categorisation (clustering + partition + workplace aliases)
  LABEL_HINTS: 'step1Local',
  LAST_NAME_MIN_MEMBERS: 'step1Local',
  clusterByLabels: 'step1Local',
  NAME_TOKEN_SOURCES: 'step1Local',
  clusterByNameTokens: 'step1Local',
  buildCandidateClusters: 'step1Local',
  HELPER_KEYWORD_RE: 'step1Local',
  isHelperContact: 'step1Local',
  partitionByUserWorkplaces: 'step1Local',
  partitionContactsForLlm: 'step1Local',
  ALIAS_STOP_WORDS: 'step1Local',
  deriveWorkplaceAliases: 'step1Local',
  buildUserWorkplaceMap: 'step1Local',

  // Step 2 — send to LLM (prompt construction + provider calls)
  buildContactHint: 'step2SendToLlm',
  buildContactCards: 'step2SendToLlm',
  buildUserProfileBlock: 'step2SendToLlm',
  buildPrompt: 'step2SendToLlm',
  buildConstrainedPrompt: 'step2SendToLlm',
  indexBatchByName: 'step2SendToLlm',
  PROVIDER_BATCH_SIZE: 'step2SendToLlm',
  DEFAULT_BATCH_SIZE: 'step2SendToLlm',
  batchSizeForProvider: 'step2SendToLlm',
  isAuthError: 'step2SendToLlm',
  GEMINI_FALLBACK_MODELS: 'step2SendToLlm',
  GEMINI_PREFERRED_PATTERNS: 'step2SendToLlm',
  listGeminiModels: 'step2SendToLlm',
  pickGeminiModel: 'step2SendToLlm',
  resolveGeminiModel: 'step2SendToLlm',
  callGeminiOnce: 'step2SendToLlm',
  TRANSIENT_STATUSES: 'step2SendToLlm',
  TRANSIENT_RETRY_MS: 'step2SendToLlm',
  sleep: 'step2SendToLlm',
  callGemini: 'step2SendToLlm',
  callOpenAiOnce: 'step2SendToLlm',
  callOpenAi: 'step2SendToLlm',
  callOpenRouterOnce: 'step2SendToLlm',
  callOpenRouter: 'step2SendToLlm',

  // Step 3 — LLM reply (parse + sanitise)
  parseModelResponse: 'step3LlmReply',
  CUE_TOKEN_DENYLIST: 'step3LlmReply',
  sanitiseGroups: 'step3LlmReply',

  // Step 4 — transform (constraint pass that reshapes groups)
  OFFICE_GENERIC: 'step4Transform',
  OFFICE_PREFIX_RE: 'step4Transform',
  colleagueDedupeKey: 'step4Transform',
  escapeRegex: 'step4Transform',
  verifyCueTokens: 'step4Transform',
  enforceConstraints: 'step4Transform',

  // Step 5 — propose (orchestrator)
  proposeContactGroups: 'step5Propose',

  // Apply a confirmed proposal to storage
  slugify: 'apply',
  applyProposal: 'apply',
};

// Symbols referenced from a different file than where they live.
const EXPORTS = new Set([
  'CATEGORY_IDS', 'mergeGroupsByKey', 'normaliseCompanyKey', 'tokens', 'normaliseNameKey',
  'buildCandidateClusters', 'partitionContactsForLlm', 'buildUserWorkplaceMap',
  'buildContactCards', 'buildPrompt', 'buildConstrainedPrompt', 'indexBatchByName',
  'batchSizeForProvider', 'isAuthError', 'callGemini', 'callOpenAi', 'callOpenRouter',
  'parseModelResponse', 'sanitiseGroups', 'enforceConstraints', 'proposeContactGroups',
  'applyProposal',
]);

const HEADERS = {
  shared: "import { CATEGORIES } from '../storage';\n",
  step1Local: "import { normaliseCompanyKey, tokens } from './shared';\n",
  step2SendToLlm:
    "import { CATEGORIES, getCachedGeminiModel, setCachedGeminiModel } from '../storage';\n" +
    "import { normaliseNameKey } from './shared';\n",
  step3LlmReply: "import { CATEGORY_IDS, normaliseNameKey } from './shared';\n",
  step4Transform:
    "import { CATEGORY_ID } from '../storage';\n" +
    "import { mergeGroupsByKey, normaliseCompanyKey } from './shared';\n",
  step5Propose:
    "import {\n" +
    "  getGroups,\n" +
    "  getLlmConfig,\n" +
    "  getManualContactsSet,\n" +
    "  getUserProfile,\n" +
    "} from '../storage';\n" +
    "import { mergeGroupsByKey, normaliseCompanyKey } from './shared';\n" +
    "import {\n" +
    "  buildCandidateClusters,\n" +
    "  buildUserWorkplaceMap,\n" +
    "  partitionContactsForLlm,\n" +
    "} from './step1Local';\n" +
    "import {\n" +
    "  batchSizeForProvider,\n" +
    "  buildConstrainedPrompt,\n" +
    "  buildContactCards,\n" +
    "  buildPrompt,\n" +
    "  callGemini,\n" +
    "  callOpenAi,\n" +
    "  callOpenRouter,\n" +
    "  indexBatchByName,\n" +
    "  isAuthError,\n" +
    "} from './step2SendToLlm';\n" +
    "import { parseModelResponse, sanitiseGroups } from './step3LlmReply';\n" +
    "import { enforceConstraints } from './step4Transform';\n",
  apply:
    "import {\n" +
    "  getCategoryById,\n" +
    "  getContactGroupMap,\n" +
    "  getGroups,\n" +
    "  getManualContactsSet,\n" +
    "  setGroups,\n" +
    "} from '../storage';\n" +
    "import { writeJson } from '../utils/syncStoreMmkv';\n",
};

const declIdx = {};
for (const name of Object.keys(MAP)) {
  const re = new RegExp(`^(export\\s+)?const ${name}\\b`);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx === -1) throw new Error(`symbol not found: ${name}`);
  declIdx[name] = idx;
}

// Attach each symbol's contiguous leading comment block (walk up to blank line).
const blockStart = {};
for (const [name, idx] of Object.entries(declIdx)) {
  let s = idx;
  while (s > 0 && lines[s - 1].trim() !== '') s -= 1;
  blockStart[name] = s;
}

const ordered = Object.keys(MAP).sort((a, b) => blockStart[a] - blockStart[b]);
const ranges = {};
for (let i = 0; i < ordered.length; i += 1) {
  const name = ordered[i];
  ranges[name] = [
    blockStart[name],
    i + 1 < ordered.length ? blockStart[ordered[i + 1]] - 1 : lines.length - 1,
  ];
}

const addExport = (block, name) =>
  EXPORTS.has(name)
    ? block.replace(new RegExp(`^const ${name}\\b`, 'm'), `export const ${name}`)
    : block;

const trimTail = (arr) => {
  const out = [...arr];
  while (out.length && (out[out.length - 1].trim() === '' || /^\s*\/\/\s*-{2,}/.test(out[out.length - 1]))) {
    out.pop();
  }
  return out;
};

const byFile = {};
for (const name of ordered) {
  const [s, e] = ranges[name];
  (byFile[MAP[name]] ||= []).push(addExport(lines.slice(s, e + 1).join('\n'), name));
}

mkdirSync(OUT, { recursive: true });
for (const [file, blocks] of Object.entries(byFile)) {
  const bodyLines = trimTail(blocks.join('\n').split('\n'));
  const header = HEADERS[file] || '';
  writeFileSync(`${OUT}/${file}.js`, (header ? header + '\n' : '') + bodyLines.join('\n') + '\n');
  console.log(`wrote ${OUT}/${file}.js (${bodyLines.length} lines)`);
}

const indexDoc = `// ---------------------------------------------------------------------------
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
export { buildCandidateClusters, partitionContactsForLlm } from './step1Local';
`;
writeFileSync(`${OUT}/index.js`, indexDoc);
console.log('wrote index.js');
