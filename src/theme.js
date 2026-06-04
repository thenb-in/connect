// Connect Mode palette: warm, calm, human-feeling. Intentionally distinct
// from the deep purple corporate CRM tone so users feel they've stepped into
// a quieter, relationship-oriented space.
const connectTheme = {
  colors: {
    primary: '#2F6F8F',        // soft teal-navy
    primaryDark: '#1F4F6B',
    accent: '#E07856',         // warm terracotta
    background: '#F6F3EE',     // off-white parchment
    surface: '#FFFFFF',
    surfaceAlt: '#FBF7F1',
    text: '#1F2A33',
    textMuted: '#5E6A73',
    textSubtle: '#8C949B',
    border: '#E5DED3',
    divider: '#ECE7DE',
    success: '#3C9D6A',
    warning: '#C98A2E',
    danger: '#B0463C',
    chipBg: '#EDE6DA',
    cardShadow: 'rgba(31, 79, 107, 0.08)',
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
  font: {
    h1: 24,
    h2: 20,
    h3: 17,
    body: 15,
    small: 13,
    tiny: 11,
  },
};

export default connectTheme;
