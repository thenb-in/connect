import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';

/**
 * Section header used on the relationship dashboard. Title + optional caption
 * on the left, an optional "See all" affordance on the right.
 */
const SectionHeader = ({ title, caption, actionLabel, onActionPress }) => (
  <View style={styles.row}>
    <View style={styles.left}>
      <Text style={styles.title}>{title}</Text>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </View>
    {actionLabel ? (
      <TouchableOpacity onPress={onActionPress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <View style={styles.actionRow}>
          <Text style={styles.action}>{actionLabel}</Text>
          <Icon name="chevron-right" size={18} color={theme.colors.primary} />
        </View>
      </TouchableOpacity>
    ) : null}
  </View>
);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xl,
    paddingBottom: theme.spacing.sm,
  },
  left: { flexShrink: 1, paddingRight: theme.spacing.md },
  title: {
    fontSize: theme.font.h3,
    fontWeight: '700',
    color: theme.colors.text,
  },
  caption: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  actionRow: { flexDirection: 'row', alignItems: 'center' },
  action: {
    color: theme.colors.primary,
    fontSize: theme.font.small,
    fontWeight: '600',
  },
});

export default SectionHeader;
