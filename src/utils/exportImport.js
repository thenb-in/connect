import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import Share from 'react-native-share';
import DocumentPicker from 'react-native-document-picker';

import {
  applyConnectImport,
  buildConnectExport,
  isValidImportPayload,
} from '../storage';

const timestampStamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
};

/**
 * Builds the export payload for the selected scopes, writes it to the app's
 * cache directory, then hands the file to the system share sheet so the user
 * can save it wherever they like (Drive, email to self, AirDrop, etc).
 */
export const writeAndShareExport = async (scopes) => {
  const payload = buildConnectExport(scopes);
  const fileName = `callbuddy-connect-${timestampStamp()}.json`;
  const path = `${RNFS.CachesDirectoryPath}/${fileName}`;
  const json = JSON.stringify(payload, null, 2);
  await RNFS.writeFile(path, json, 'utf8');
  const url = Platform.OS === 'android' ? `file://${path}` : path;
  try {
    await Share.open({
      url,
      filename: fileName,
      type: 'application/json',
      failOnCancel: false,
    });
  } catch (err) {
    // react-native-share throws on user-cancel; ignore that, surface real
    // errors to the caller.
    const msg = (err?.message || '').toLowerCase();
    if (!msg.includes('user did not share') && !msg.includes('cancel')) {
      throw err;
    }
  }
  return { payload, path, fileName };
};

/**
 * Opens the system document picker, reads the chosen file as UTF-8, and
 * validates it as a Connect export. Throws a user-friendly error when the
 * file isn't picked, isn't JSON, or isn't a Connect export.
 */
export const pickAndParseImport = async () => {
  let picked;
  try {
    const result = await DocumentPicker.pick({
      type: [DocumentPicker.types.allFiles],
      copyTo: 'cachesDirectory',
    });
    picked = Array.isArray(result) ? result[0] : result;
  } catch (err) {
    if (DocumentPicker.isCancel?.(err)) return null;
    throw err;
  }
  if (!picked) return null;
  // Prefer the cached copy (always a normal file path) over the raw URI,
  // which can be a content:// on Android.
  const readPath = picked.fileCopyUri || picked.uri;
  let text;
  try {
    text = await RNFS.readFile(readPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read that file: ${err?.message || err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!isValidImportPayload(parsed)) {
    throw new Error("That doesn't look like a Connect export file.");
  }
  return { payload: parsed, fileName: picked.name || 'import.json' };
};

export const runImport = (payload, scopes) =>
  applyConnectImport(payload, scopes);
