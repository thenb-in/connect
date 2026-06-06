import React, { useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, TextInput } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';


const matchProfile = (p, q) => {
  const name = (p?.contact?.name || '').toLowerCase();
  const phone = (p?.contact?.phone || '').toLowerCase();
  const normalized = (p?.contact?.normalized || '').toLowerCase();
  return name.includes(q) || phone.includes(q) || normalized.includes(q);
};

const ContactSearchBar = ({
  data = [],
  onResults,
  match = matchProfile,
  placeholder = 'Search by name or number',
}) => {
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter((item) => match(item, q));
  }, [data, query, match]);

  useEffect(() => {
    onResults?.(results);
  }, [results, onResults]);

  return (
    <View style={styles.searchWrap}>
      <Icon name="magnify" size={18} color={theme.colors.textSubtle} />
      <TextInput
        style={styles.searchInput}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textSubtle}
        value={query}
        onChangeText={setQuery}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.pill,
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing.sm,
    paddingLeft: theme.spacing.sm,
    fontSize: theme.font.body,
    color: theme.colors.text,
  },
});

export default ContactSearchBar;
