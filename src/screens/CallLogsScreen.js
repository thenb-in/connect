import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Platform, ToastAndroid } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import ConnectSetupGate from '../components/ConnectSetupGate';
import AddCallLogModal from '../components/AddCallLogModal';
import { addCallLog, getCallLogs, getContacts } from '../storage';
import { normalizeLast10 } from '../utils/phone';
import { formatTimestamp, formatDuration, getLogTimestamp } from '../utils/dateUtils';

// Collapse the raw call-log type (INCOMING/OUTGOING/MISSED/REJECTED/…) into a
// small presentation set. Mirrors the engine's getLogType so the labels here
// match how the relationship engine reasons about the same rows.
const typeMeta = (raw) => {
  const t = (raw || '').toString().toUpperCase();
  if (t.includes('OUT')) {
    return { icon: 'phone-outgoing', color: theme.colors.primary, label: 'Outgoing', connected: true };
  }
  if (t.includes('MISS')) {
    return { icon: 'phone-missed', color: theme.colors.accent, label: 'Missed', connected: false };
  }
  if (t.includes('REJ')) {
    return { icon: 'phone-cancel', color: theme.colors.accent, label: 'Rejected', connected: false };
  }
  if (t.includes('IN')) {
    return { icon: 'phone-incoming', color: theme.colors.success, label: 'Incoming', connected: true };
  }
  return { icon: 'phone', color: theme.colors.textMuted, label: 'Call', connected: true };
};

/**
 * Read-only viewer for the call-log snapshot Connect has saved to the device
 * (the `connect.callLogs` MMKV key). Shows exactly what we store for each
 * call — number (resolved to a contact name when we have one), date & time it
 * was initiated, and duration. Reached from Settings → Data & Privacy so the
 * user can audit the data the app keeps.
 */
const CallLogsScreen = ({ navigation }) => {
  const [addOpen, setAddOpen] = useState(false);

  const contacts = useMemo(() => getContacts(), []);

  // Reads the saved call-log snapshot from MMKV and shapes it for the list.
  // Held in state (not a plain memo) so a manual add can re-pull it.
  const buildRows = useCallback(() => {
    const nameByPhone = new Map();
    contacts.forEach((c) => {
      if (c.normalized && !nameByPhone.has(c.normalized)) {
        nameByPhone.set(c.normalized, c.name);
      }
    });
    return (getCallLogs() || [])
      .map((log, idx) => {
        const ts = getLogTimestamp(log);
        const key = normalizeLast10(log?.phoneNumber);
        return {
          id: `${log?.phoneNumber || ''}_${ts}_${idx}`,
          phoneNumber: log?.phoneNumber || 'Unknown number',
          name: (key && nameByPhone.get(key)) || null,
          ts,
          durationSec: Math.max(0, parseInt(log?.duration, 10) || 0),
          meta: typeMeta(log?.type),
        };
      })
      .sort((a, b) => b.ts - a.ts);
  }, [contacts]);

  const [rows, setRows] = useState(buildRows);

  const handleAdd = useCallback((entry) => {
    const saved = addCallLog(entry);
    setAddOpen(false);
    if (!saved) return;
    setRows(buildRows());
    if (Platform.OS === 'android') {
      ToastAndroid.show('Call log added', ToastAndroid.SHORT);
    }
  }, [buildRows]);

  return (
    <View style={styles.container}>
      <AppHeader
        title="Saved call logs"
        subtitle={rows.length ? `${rows.length} entries on this device` : undefined}
        onBack={() => navigation.goBack()}
        rightIcon="plus"
        onRightPress={() => setAddOpen(true)}
      />
      <ConnectSetupGate>
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Icon name={item.meta.icon} size={20} color={item.meta.color} />
              <View style={styles.body}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.name || item.phoneNumber}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {item.meta.label}
                  {item.name ? ` · ${item.phoneNumber}` : ''}
                </Text>
                <Text style={styles.when}>
                  {item.ts ? formatTimestamp(item.ts) : 'Unknown time'}
                </Text>
              </View>
              <Text style={styles.duration}>
                {item.meta.connected ? formatDuration(item.durationSec) : item.meta.label}
              </Text>
            </View>
          )}
          ListEmptyComponent={
            <EmptyState
              icon="phone-log"
              title="No saved call logs"
              body="Connect hasn't stored any call history yet. On Android, grant call-log access and pull to refresh on Home; iOS doesn't expose call history."
            />
          }
          contentContainerStyle={{
            paddingTop: theme.spacing.md,
            paddingBottom: theme.spacing.xxl,
          }}
        />
      </ConnectSetupGate>

      <AddCallLogModal
        visible={addOpen}
        contacts={contacts}
        onClose={() => setAddOpen(false)}
        onAdd={handleAdd}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
  },
  body: { flex: 1, marginLeft: theme.spacing.md },
  title: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
  },
  sub: {
    fontSize: theme.font.tiny,
    color: theme.colors.textMuted,
    marginTop: 1,
  },
  when: {
    fontSize: theme.font.tiny,
    color: theme.colors.textSubtle,
    marginTop: 1,
  },
  duration: {
    fontSize: theme.font.small,
    fontWeight: '600',
    color: theme.colors.textMuted,
    marginLeft: theme.spacing.sm,
  },
});

export default CallLogsScreen;
