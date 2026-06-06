import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Provider as PaperProvider } from 'react-native-paper';
import { Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import ConnectStack from './src/navigation/ConnectStack';
import theme from './src/theme';
import { testMMKV } from './src/mmkv';

testMMKV();

const paperTheme = {
  colors: {
    primary: theme.colors.primary,
    accent: theme.colors.accent,
    background: theme.colors.background,
    surface: theme.colors.surface,
    text: theme.colors.text,
  },
};

const HEADER_HEIGHT = Platform.OS === 'ios' ? 44 : 56;
const ToastOverlay = () => {
  const insets = useSafeAreaInsets();
  return <Toast topOffset={insets.top + HEADER_HEIGHT + 8} />;
};

const App = () => (
  <SafeAreaProvider>
    <PaperProvider theme={paperTheme}>
      <NavigationContainer>
        <SafeAreaView edges={[]} style={{ flex: 1, backgroundColor: theme.colors.background }}>
          <ConnectStack />
          <ToastOverlay />
        </SafeAreaView>
      </NavigationContainer>
    </PaperProvider>
  </SafeAreaProvider>
);

export default App;
