import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import theme from '../theme';

/**
 * Pill-shaped chip for relationship groups (Family, Investors, Mentors, ...).
 * When `selected` is true the chip fills with the group's color; otherwise it
 * stays outlined for low visual weight on dashboards.
 */
const GroupPill = ({ group, selected = false, onPress, count }) => {
  const color = group?.color || theme.colors.primary;
  return (
    <TouchableOpacity
      activeOpacity={onPress ? 0.85 : 1}
      onPress={onPress}
      style={[
        styles.pill,
        { borderColor: color },
        selected && { backgroundColor: color },
      ]}
    >
      <Text
        style={[
          styles.text,
          { color: selected ? theme.colors.surface : color },
        ]}
      >
        {group?.name}
        {typeof count === 'number' ? `  ·  ${count}` : ''}
      </Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs + 2,
    borderRadius: theme.radius.pill,
    borderWidth: 1.2,
    marginRight: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
  },
  text: {
    fontSize: theme.font.small,
    fontWeight: '600',
  },
});

export default GroupPill;
