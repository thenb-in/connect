import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

// 00:00:00.000 of a given y/m/d, used for whole-day comparisons against the
// maximum-allowed date so future days can be greyed out.
const dayStart = (year, month, day) => new Date(year, month, day, 0, 0, 0, 0).getTime();

/**
 * A self-contained, JS-only date & time picker — no native dependency, so it
 * works on iOS without a pod install / rebuild. Presented as a slide-up modal
 * with a month calendar for the date and 12-hour steppers for the time.
 *
 * Props:
 *   visible      — show/hide.
 *   value        — ms timestamp to seed the picker (defaults to now).
 *   maximumDate  — ms timestamp; days after this are disabled (e.g. no future
 *                  calls). Omit to allow any date.
 *   onCancel     — () => void, dismiss without applying.
 *   onConfirm    — (ms) => void, apply the chosen date-time.
 */
const DateTimePickerModal = ({ visible, value, maximumDate, onCancel, onConfirm }) => {
  const insets = useSafeAreaInsets();

  // Working draft, seeded from `value` each time the modal opens so reopening
  // never inherits a half-edited state from a previous session.
  const [draft, setDraft] = useState(() => new Date(value || Date.now()));
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setWasVisible(true);
    setDraft(new Date(value || Date.now()));
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }

  const year = draft.getFullYear();
  const month = draft.getMonth();
  const selectedDay = draft.getDate();
  const hour24 = draft.getHours();
  const minute = draft.getMinutes();

  const displayHour = ((hour24 + 11) % 12) + 1;
  const isPM = hour24 >= 12;

  // Mutate a clone so React sees a new reference and re-renders.
  const patch = (mutate) => {
    setDraft((prev) => {
      const next = new Date(prev);
      mutate(next);
      return next;
    });
  };

  const shiftMonth = (delta) => {
    patch((d) => {
      const targetDays = daysInMonth(d.getFullYear(), d.getMonth() + delta);
      // Clamp the day so e.g. 31 Jan → Feb lands on the last valid day.
      d.setDate(Math.min(d.getDate(), targetDays));
      d.setMonth(d.getMonth() + delta);
    });
  };

  const setDay = (day) => patch((d) => d.setDate(day));
  const stepHour = (delta) => patch((d) => d.setHours((d.getHours() + delta + 24) % 24));
  const stepMinute = (delta) => patch((d) => d.setMinutes((d.getMinutes() + delta + 60) % 60));
  const toggleAmPm = () => patch((d) => d.setHours((d.getHours() + 12) % 24));

  // Build the calendar grid: leading blanks for the first week, then the days.
  const firstWeekday = new Date(year, month, 1).getDay();
  const totalDays = daysInMonth(year, month);
  const cells = [];
  for (let i = 0; i < firstWeekday; i += 1) {
    cells.push(null);
  }
  for (let d = 1; d <= totalDays; d += 1) {
    cells.push(d);
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  const maxDayStart = Number.isFinite(maximumDate)
    ? new Date(maximumDate).setHours(0, 0, 0, 0)
    : null;
  const isDayDisabled = (day) =>
    maxDayStart != null && dayStart(year, month, day) > maxDayStart;
  const nextMonthDisabled =
    maxDayStart != null && dayStart(year, month + 1, 1) > maxDayStart;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={() => onCancel?.()}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + theme.spacing.lg }]}>
          <View style={styles.handle} />
          <Text style={styles.heading}>Date &amp; time of call</Text>

          {/* Month navigation */}
          <View style={styles.monthRow}>
            <TouchableOpacity
              onPress={() => shiftMonth(-1)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Icon name="chevron-left" size={26} color={theme.colors.textMuted} />
            </TouchableOpacity>
            <Text style={styles.monthLabel}>{`${MONTHS[month]} ${year}`}</Text>
            <TouchableOpacity
              onPress={() => !nextMonthDisabled && shiftMonth(1)}
              disabled={nextMonthDisabled}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Icon
                name="chevron-right"
                size={26}
                color={nextMonthDisabled ? theme.colors.border : theme.colors.textMuted}
              />
            </TouchableOpacity>
          </View>

          {/* Weekday header */}
          <View style={styles.weekRow}>
            {WEEKDAYS.map((w) => (
              <Text key={w} style={styles.weekday}>{w}</Text>
            ))}
          </View>

          {/* Day grid */}
          {weeks.map((week, wi) => (
            <View key={`w${wi}`} style={styles.weekRow}>
              {week.map((day, di) => {
                if (day == null) {
                  return <View key={`b${di}`} style={styles.dayCell} />;
                }
                const selected = day === selectedDay;
                const disabled = isDayDisabled(day);
                return (
                  <TouchableOpacity
                    key={day}
                    style={styles.dayCell}
                    disabled={disabled}
                    onPress={() => setDay(day)}
                  >
                    <View style={[styles.dayInner, selected && styles.daySelected]}>
                      <Text
                        style={[
                          styles.dayText,
                          selected && styles.dayTextSelected,
                          disabled && styles.dayTextDisabled,
                        ]}
                      >
                        {day}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}

          {/* Time steppers */}
          <View style={styles.timeRow}>
            <Stepper
              value={displayHour.toString().padStart(2, '0')}
              onUp={() => stepHour(1)}
              onDown={() => stepHour(-1)}
            />
            <Text style={styles.colon}>:</Text>
            <Stepper
              value={minute.toString().padStart(2, '0')}
              onUp={() => stepMinute(1)}
              onDown={() => stepMinute(-1)}
            />
            <TouchableOpacity style={styles.ampm} onPress={toggleAmPm}>
              <Text style={styles.ampmText}>{isPM ? 'PM' : 'AM'}</Text>
            </TouchableOpacity>
          </View>

          {/* Actions */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.btnSecondary]}
              onPress={() => onCancel?.()}
            >
              <Text style={styles.btnSecondaryText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.btnPrimary]}
              onPress={() => onConfirm?.(draft.getTime())}
            >
              <Text style={styles.btnPrimaryText}>Set date &amp; time</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

// A small vertical +/- stepper for hour or minute.
const Stepper = ({ value, onUp, onDown }) => (
  <View style={styles.stepper}>
    <TouchableOpacity onPress={onUp} hitSlop={{ top: 6, bottom: 6, left: 12, right: 12 }}>
      <Icon name="chevron-up" size={24} color={theme.colors.textMuted} />
    </TouchableOpacity>
    <Text style={styles.stepperValue}>{value}</Text>
    <TouchableOpacity onPress={onDown} hitSlop={{ top: 6, bottom: 6, left: 12, right: 12 }}>
      <Icon name="chevron-down" size={24} color={theme.colors.textMuted} />
    </TouchableOpacity>
  </View>
);

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(31, 42, 51, 0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.border,
    marginBottom: theme.spacing.md,
  },
  heading: {
    fontSize: theme.font.h3,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.md,
  },
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  monthLabel: {
    fontSize: theme.font.body,
    fontWeight: '700',
    color: theme.colors.text,
  },
  weekRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontSize: theme.font.tiny,
    fontWeight: '700',
    color: theme.colors.textSubtle,
    paddingVertical: theme.spacing.xs,
  },
  dayCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 3,
  },
  dayInner: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  daySelected: {
    backgroundColor: theme.colors.primary,
  },
  dayText: {
    fontSize: theme.font.small,
    color: theme.colors.text,
  },
  dayTextSelected: {
    color: theme.colors.surface,
    fontWeight: '700',
  },
  dayTextDisabled: {
    color: theme.colors.border,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: theme.spacing.lg,
    marginBottom: theme.spacing.md,
  },
  stepper: {
    alignItems: 'center',
    paddingHorizontal: theme.spacing.sm,
  },
  stepperValue: {
    fontSize: theme.font.h2,
    fontWeight: '700',
    color: theme.colors.text,
    paddingVertical: 2,
    minWidth: 40,
    textAlign: 'center',
  },
  colon: {
    fontSize: theme.font.h2,
    fontWeight: '700',
    color: theme.colors.text,
    marginHorizontal: theme.spacing.xs,
  },
  ampm: {
    marginLeft: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  ampmText: {
    fontSize: theme.font.body,
    fontWeight: '700',
    color: theme.colors.primary,
  },
  actions: {
    flexDirection: 'row',
    marginTop: theme.spacing.sm,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.pill,
  },
  btnPrimary: {
    backgroundColor: theme.colors.primary,
    marginLeft: theme.spacing.sm,
    flex: 2,
  },
  btnPrimaryText: {
    color: theme.colors.surface,
    fontWeight: '700',
    fontSize: theme.font.body,
  },
  btnSecondary: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  btnSecondaryText: {
    color: theme.colors.textMuted,
    fontWeight: '600',
    fontSize: theme.font.body,
  },
});

export default DateTimePickerModal;
