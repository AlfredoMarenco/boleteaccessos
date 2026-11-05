import { NativeModules, DeviceEventEmitter, Platform } from 'react-native';

const { NfcReader } = NativeModules;

export type NfcStatus = 'unsupported' | 'disabled' | 'enabled';

export interface NfcScanEvent {
  code: string;
  uid: string;
  format: 'ndef' | 'uid';
  candidates: string[];
}

export const getNfcStatus = async (): Promise<NfcStatus> => {
  if (Platform.OS !== 'android' || !NfcReader || typeof NfcReader.getStatus !== 'function') {
    return 'unsupported';
  }
  try {
    const status = await NfcReader.getStatus();
    if (status === 'enabled' || status === 'disabled') {
      return status;
    }
    return 'unsupported';
  } catch (e) {
    return 'unsupported';
  }
};

export const startNfcReader = async (): Promise<NfcStatus> => {
  if (Platform.OS !== 'android' || !NfcReader || typeof NfcReader.startReader !== 'function') {
    return 'unsupported';
  }
  try {
    const status = await NfcReader.startReader();
    if (status === 'enabled' || status === 'disabled') {
      return status;
    }
    return 'unsupported';
  } catch (e) {
    return 'disabled';
  }
};

export const stopNfcReader = async (): Promise<void> => {
  if (Platform.OS !== 'android' || !NfcReader || typeof NfcReader.stopReader !== 'function') {
    return;
  }
  try {
    await NfcReader.stopReader();
  } catch (e) {
    // Ignore stop errors
  }
};

export const openNfcSettings = (): void => {
  if (Platform.OS === 'android' && NfcReader && typeof NfcReader.openNfcSettings === 'function') {
    NfcReader.openNfcSettings();
  }
};

export const subscribeNfcTagScanned = (callback: (event: NfcScanEvent) => void) => {
  return DeviceEventEmitter.addListener('nfc_tag_scanned', (raw: any) => {
    if (!raw || !raw.code) return;
    callback({
      code: String(raw.code),
      uid: String(raw.uid || ''),
      format: raw.format === 'ndef' ? 'ndef' : 'uid',
      candidates: Array.isArray(raw.candidates) ? raw.candidates.map(String) : [String(raw.code)],
    });
  });
};

export const subscribeNfcStatusChanged = (callback: (status: NfcStatus) => void) => {
  return DeviceEventEmitter.addListener('nfc_status_changed', (raw: any) => {
    const st = raw?.status;
    if (st === 'enabled' || st === 'disabled' || st === 'unsupported') {
      callback(st);
    }
  });
};
