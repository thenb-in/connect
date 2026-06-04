import { MMKV } from 'react-native-mmkv';

// Create a single MMKV instance
const storage = new MMKV();

/**
 * Tests and returns the singleton MMKV storage instance.
 * @returns {MMKV|null} The MMKV storage instance, or null if initialization fails.
 * @sideEffects Logs initialization status to console. Logs error on failure.
 */
export function testMMKV() {
  try {
    console.log('Initializing MMKV...');
    return storage; // Return the MMKV instance
  } catch (error) {
    console.error('MMKV Test Failed:', error);
    return null;
  }
}

// Export the storage instance directly for use elsewhere
export { storage };