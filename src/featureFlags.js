import { Platform } from 'react-native';

/**
 * Build-time feature gates.
 *
 * AI_GROUPING_ENABLED — the optional "smart grouping" path that sends contact
 * *names* (plus whatever profile context the user typed) to a third-party LLM
 * using the user's own API key.
 *
 * Disabled on iOS for the 1.0 App Store release. Transmitting contact names off
 * the device — even to a provider the user chose, under the user's own key —
 * counts as data collection under Apple's App Privacy rules, which would force
 * the listing to declare collected data and contradict the "nothing leaves your
 * phone" promise the store copy makes. Shipping 1.0 without it keeps the
 * nutrition label at a truthful "Data Not Collected". Re-enable once the
 * disclosure is in place (see store/appstore-listing.md §8).
 *
 * When false: the LLM key UI is hidden and the categorisation engine is pinned
 * to the on-device heuristic path, so no network call can be reached at all.
 * Grouping itself still works — it just uses local heuristics only.
 */
export const AI_GROUPING_ENABLED = Platform.OS !== 'ios';
