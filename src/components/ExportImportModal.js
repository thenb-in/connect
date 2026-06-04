import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import {
  EXPORT_SCOPES,
  getExportScopeCount,
  getImportScopeCount,
  listImportableScopes,
} from '../storage';
import {
  pickAndParseImport,
  runImport,
  writeAndShareExport,
} from '../utils/exportImport';

const STEP_PICK = 'pick';
const STEP_SELECT = 'select';
const STEP_BUSY = 'busy';
const STEP_DONE = 'done';
const STEP_ERROR = 'error';

const countLabel = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

/**
 * Shared modal for both Connect data export and import. The `mode` prop picks
 * between the two flows:
 *
 *   - 'export' starts at STEP_SELECT, listing every scope with the current
 *     on-device count. User ticks what they want, hits Share, file goes
 *     through the system share sheet.
 *   - 'import' starts at STEP_PICK; the user picks a JSON file, then the modal
 *     transitions to STEP_SELECT showing only scopes the file actually
 *     contains (with their counts from the file). Confirming applies them.
 */
const ExportImportModal = ({ visible, mode, onClose, onImported }) => {
  const initialStep = mode === 'import' ? STEP_PICK : STEP_SELECT;
  const [step, setStep] = useState(initialStep);
  const [error, setError] = useState(null);
  const [payload, setPayload] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [resultApplied, setResultApplied] = useState([]);

  useEffect(() => {
    if (!visible) return;
    setStep(mode === 'import' ? STEP_PICK : STEP_SELECT);
    setError(null);
    setPayload(null);
    setFileName(null);
    setResultApplied([]);
    if (mode === 'export') {
      // Default-select every scope that actually has data on device.
      const next = new Set();
      EXPORT_SCOPES.forEach((s) => {
        if (getExportScopeCount(s.id) > 0) next.add(s.id);
      });
      setSelected(next);
    } else {
      setSelected(new Set());
    }
  }, [visible, mode]);

  const availableScopes = useMemo(() => {
    if (mode === 'export') {
      return EXPORT_SCOPES.map((s) => ({
        ...s,
        count: getExportScopeCount(s.id),
      }));
    }
    if (!payload) return [];
    const present = new Set(listImportableScopes(payload));
    return EXPORT_SCOPES.filter((s) => present.has(s.id)).map((s) => ({
      ...s,
      count: getImportScopeCount(payload, s.id),
    }));
  }, [mode, payload]);

  const toggle = useCallback((id) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onPickFile = useCallback(async () => {
    setError(null);
    setStep(STEP_BUSY);
    try {
      const res = await pickAndParseImport();
      if (!res) {
        // User cancelled — stay on the pick step.
        setStep(STEP_PICK);
        return;
      }
      setPayload(res.payload);
      setFileName(res.fileName);
      // Default-select every scope present in the file.
      const next = new Set(listImportableScopes(res.payload));
      setSelected(next);
      setStep(STEP_SELECT);
    } catch (err) {
      setError(err?.message || 'Could not read that file.');
      setStep(STEP_ERROR);
    }
  }, []);

  const onConfirm = useCallback(async () => {
    setError(null);
    setStep(STEP_BUSY);
    try {
      if (mode === 'export') {
        await writeAndShareExport([...selected]);
        // Share sheet handles the "where to send" UX. We close immediately
        // after — the system sheet stays up if it was already shown.
        onClose?.();
        return;
      }
      const { applied } = runImport(payload, [...selected]);
      setResultApplied(applied);
      setStep(STEP_DONE);
      onImported?.(applied);
    } catch (err) {
      setError(err?.message || 'Something went wrong.');
      setStep(STEP_ERROR);
    }
  }, [mode, selected, payload, onClose, onImported]);

  const title = mode === 'export' ? 'Export your data' : 'Import from a file';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {step === STEP_PICK ? (
            <PickFileStep
              onCancel={onClose}
              onPick={onPickFile}
            />
          ) : null}

          {step === STEP_SELECT ? (
            <SelectStep
              mode={mode}
              title={title}
              fileName={fileName}
              scopes={availableScopes}
              selected={selected}
              onToggle={toggle}
              onCancel={onClose}
              onConfirm={onConfirm}
            />
          ) : null}

          {step === STEP_BUSY ? <BusyStep mode={mode} /> : null}

          {step === STEP_DONE ? (
            <DoneStep applied={resultApplied} onClose={onClose} />
          ) : null}

          {step === STEP_ERROR ? (
            <ErrorStep
              message={error}
              onClose={onClose}
              onRetry={mode === 'import' ? () => setStep(STEP_PICK) : null}
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
};

const PickFileStep = ({ onCancel, onPick }) => (
  <View>
    <View style={styles.iconRow}>
      <View style={[styles.iconWrap, styles.iconWrapNeutral]}>
        <Icon
          name="file-upload-outline"
          size={28}
          color={theme.colors.primary}
        />
      </View>
    </View>
    <Text style={styles.title}>Import from a file</Text>
    <Text style={styles.body}>
      Pick a Connect export JSON file. We'll show you what's inside before
      anything is written to this device.
    </Text>
    <View style={styles.btnRow}>
      <TouchableOpacity
        onPress={onCancel}
        style={[styles.btn, styles.btnSecondary]}
      >
        <Text style={styles.btnSecondaryText}>Cancel</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onPick}
        style={[styles.btn, styles.btnPrimary]}
      >
        <Text style={styles.btnPrimaryText}>Choose file</Text>
      </TouchableOpacity>
    </View>
  </View>
);

const SelectStep = ({
  mode,
  title,
  fileName,
  scopes,
  selected,
  onToggle,
  onCancel,
  onConfirm,
}) => {
  const isExport = mode === 'export';
  const empty = scopes.length === 0;
  const hasNothingSelected = selected.size === 0;
  const ctaLabel = isExport
    ? hasNothingSelected
      ? 'Nothing selected'
      : `Export ${selected.size} item${selected.size === 1 ? '' : 's'}`
    : hasNothingSelected
    ? 'Nothing selected'
    : `Import ${selected.size} item${selected.size === 1 ? '' : 's'}`;
  return (
    <View>
      <View style={styles.iconRow}>
        <View
          style={[
            styles.iconWrap,
            isExport ? styles.iconWrapNeutral : styles.iconWrapAccent,
          ]}
        >
          <Icon
            name={isExport ? 'file-download-outline' : 'file-import-outline'}
            size={28}
            color={isExport ? theme.colors.primary : theme.colors.accent}
          />
        </View>
      </View>
      <Text style={styles.title}>{title}</Text>
      {!isExport && fileName ? (
        <Text style={styles.fileLine} numberOfLines={1}>
          {fileName}
        </Text>
      ) : null}
      <Text style={styles.body}>
        {isExport
          ? 'Pick what to include. The file is a portable JSON — keep it safe.'
          : 'Pick what to restore. Each scope replaces what\'s on this device.'}
      </Text>

      {empty ? (
        <Text style={styles.empty}>
          {isExport
            ? 'Nothing to export yet. Add some data first.'
            : "This file doesn't contain anything we can import."}
        </Text>
      ) : (
        <ScrollView
          style={styles.scopeList}
          contentContainerStyle={{ paddingBottom: theme.spacing.sm }}
        >
          {scopes.map((scope) => {
            const checked = selected.has(scope.id);
            const disabled = scope.count === 0;
            return (
              <TouchableOpacity
                key={scope.id}
                style={[styles.scopeRow, disabled && styles.scopeRowDisabled]}
                onPress={() => !disabled && onToggle(scope.id)}
                activeOpacity={disabled ? 1 : 0.7}
              >
                <View
                  style={[
                    styles.checkbox,
                    checked && styles.checkboxChecked,
                    disabled && styles.checkboxDisabled,
                  ]}
                >
                  {checked ? (
                    <Icon name="check" size={14} color={theme.colors.surface} />
                  ) : null}
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.scopeTitleRow}>
                    <Text style={styles.scopeTitle}>{scope.title}</Text>
                    <Text style={styles.scopeCount}>
                      {disabled ? 'empty' : countLabel(scope.count)}
                    </Text>
                  </View>
                  <Text style={styles.scopeSubtitle}>{scope.description}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {!isExport ? (
        <Text style={styles.footnote}>
          Importing a scope overwrites what's currently on this device for that
          scope. Anything not ticked is left alone.
        </Text>
      ) : null}

      <View style={styles.btnRow}>
        <TouchableOpacity
          onPress={onCancel}
          style={[styles.btn, styles.btnSecondary]}
        >
          <Text style={styles.btnSecondaryText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onConfirm}
          disabled={hasNothingSelected || empty}
          style={[
            styles.btn,
            styles.btnPrimary,
            (hasNothingSelected || empty) && styles.btnDisabled,
          ]}
        >
          <Text style={styles.btnPrimaryText}>{ctaLabel}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const BusyStep = ({ mode }) => (
  <View style={styles.busyWrap}>
    <ActivityIndicator size="large" color={theme.colors.primary} />
    <Text style={[styles.body, { marginTop: theme.spacing.md }]}>
      {mode === 'export' ? 'Preparing your file…' : 'Working…'}
    </Text>
  </View>
);

const DoneStep = ({ applied, onClose }) => (
  <View>
    <View style={styles.iconRow}>
      <View style={[styles.iconWrap, styles.iconWrapSuccess]}>
        <Icon
          name="check-circle-outline"
          size={28}
          color={theme.colors.success}
        />
      </View>
    </View>
    <Text style={styles.title}>Imported</Text>
    <Text style={styles.body}>
      Restored {applied.length} {applied.length === 1 ? 'scope' : 'scopes'} to
      this device. Open Home or Groups to see the changes.
    </Text>
    <View style={styles.btnRow}>
      <TouchableOpacity
        onPress={onClose}
        style={[styles.btn, styles.btnPrimary]}
      >
        <Text style={styles.btnPrimaryText}>Done</Text>
      </TouchableOpacity>
    </View>
  </View>
);

const ErrorStep = ({ message, onClose, onRetry }) => (
  <View>
    <View style={styles.iconRow}>
      <View style={[styles.iconWrap, styles.iconWrapDanger]}>
        <Icon
          name="alert-octagon-outline"
          size={28}
          color={theme.colors.danger}
        />
      </View>
    </View>
    <Text style={styles.title}>Something went wrong</Text>
    <Text style={styles.body}>{message}</Text>
    <View style={styles.btnRow}>
      <TouchableOpacity
        onPress={onClose}
        style={[styles.btn, styles.btnSecondary]}
      >
        <Text style={styles.btnSecondaryText}>Close</Text>
      </TouchableOpacity>
      {onRetry ? (
        <TouchableOpacity
          onPress={onRetry}
          style={[styles.btn, styles.btnPrimary]}
        >
          <Text style={styles.btnPrimaryText}>Try again</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  </View>
);

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.xl,
  },
  iconRow: {
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapNeutral: { backgroundColor: theme.colors.chipBg },
  iconWrapAccent: { backgroundColor: 'rgba(224, 120, 86, 0.12)' },
  iconWrapDanger: { backgroundColor: 'rgba(176, 70, 60, 0.12)' },
  iconWrapSuccess: { backgroundColor: 'rgba(60, 157, 106, 0.12)' },
  title: {
    fontSize: theme.font.h2,
    fontWeight: '700',
    color: theme.colors.text,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
  },
  fileLine: {
    fontSize: theme.font.small,
    color: theme.colors.textSubtle,
    textAlign: 'center',
    marginTop: -theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    fontStyle: 'italic',
  },
  body: {
    fontSize: theme.font.body,
    color: theme.colors.textMuted,
    lineHeight: 21,
    marginBottom: theme.spacing.md,
  },
  empty: {
    fontSize: theme.font.body,
    color: theme.colors.textSubtle,
    lineHeight: 21,
    marginVertical: theme.spacing.md,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  footnote: {
    fontSize: theme.font.small,
    color: theme.colors.textSubtle,
    lineHeight: 18,
    marginBottom: theme.spacing.md,
    fontStyle: 'italic',
  },
  scopeList: {
    maxHeight: 320,
    marginBottom: theme.spacing.sm,
  },
  scopeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: theme.spacing.sm,
    paddingRight: theme.spacing.xs,
  },
  scopeRowDisabled: { opacity: 0.5 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    marginRight: theme.spacing.md,
  },
  checkboxChecked: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  checkboxDisabled: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
  },
  scopeTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  scopeTitle: {
    flex: 1,
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
  },
  scopeCount: {
    fontSize: theme.font.small,
    color: theme.colors.textSubtle,
    marginLeft: theme.spacing.sm,
  },
  scopeSubtitle: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    lineHeight: 18,
    marginTop: 2,
  },
  busyWrap: {
    alignItems: 'center',
    paddingVertical: theme.spacing.lg,
  },
  btnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: theme.spacing.sm,
  },
  btn: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm + 2,
    borderRadius: theme.radius.pill,
    marginLeft: theme.spacing.sm,
  },
  btnPrimary: { backgroundColor: theme.colors.primary },
  btnPrimaryText: { color: theme.colors.surface, fontWeight: '700' },
  btnSecondary: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  btnSecondaryText: { color: theme.colors.textMuted, fontWeight: '600' },
  btnDisabled: { opacity: 0.6 },
});

export default ExportImportModal;
