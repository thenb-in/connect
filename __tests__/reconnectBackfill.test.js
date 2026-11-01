jest.mock('@notifee/react-native', () => ({}));
jest.mock('../src/mmkv', () => {
  const data = new Map();
  return {
    storage: {
      getString: (k) => data.get(k),
      getBoolean: (k) => data.get(k),
      getNumber: (k) => data.get(k),
      set: (k, v) => data.set(k, v),
      delete: (k) => data.delete(k),
      contains: (k) => data.has(k),
    },
  };
});

import { addCallLog, getCallLogs, getReconnectEvents, getReconnects } from '../src/storage';
import { analyzeRelationships } from '../src/engine/relationshipEngine';

const DAY_MS = 24 * 60 * 60 * 1000;
const people = [
  ['Asha Rao', '9876500001', 400],
  ['Bilal Khan', '9876500002', 180],
  ['Chitra Iyer', '9876500003', 60],
];

test('onboarding estimates fill Reconnect without earning reconnect credit', () => {
  people.forEach(([, phone, daysAgo]) => {
    addCallLog({
      phoneNumber: phone,
      type: 'OUTGOING',
      timestamp: Date.now() - daysAgo * DAY_MS,
      connected: true,
      source: 'backfill',
    });
  });

  const analysis = analyzeRelationships({
    contacts: people.map(([name, phone]) => ({ name, phone, normalized: phone })),
    callLogs: getCallLogs(),
    reconnects: getReconnects(),
    contactGroups: {},
    groups: [],
    dontSuggest: {},
  });

  // HomeScreen hides the Reconnect card below 3 connected people.
  expect(analysis.counts.connectedPeople).toBe(3);
  expect(analysis.reconnectToday.length).toBeGreaterThan(0);
  expect(analysis.reconnectToday[0].contact.name).toBe('Asha Rao');
  expect(getReconnectEvents()).toEqual([]);
  expect(getReconnects()).toEqual({});
});
