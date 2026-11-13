import { api } from './api';

export const loginDevice = async (device_identifier: string, api_token: string) => {
  const response = await api.post(
    '/access/login-device',
    {
      device_identifier,
      api_token,
    },
    { timeout: 15000 }
  );
  return response.data;
};

export const loginDeviceWithCredentials = async (username: string, password: string) => {
  const response = await api.post(
    '/access/login-device',
    {
      username,
      password,
    },
    { timeout: 15000 }
  );
  return response.data;
};

export const getEvents = async () => {
  const response = await api.get('/access/events', { timeout: 15000 });
  return response.data;
};

export const syncCodes = async (eventId: number, onProgress?: (progressEvent: any) => void) => {
  const response = await api.get(`/access/sync/${eventId}`, {
    timeout: 120000,
    onDownloadProgress: onProgress,
  });
  return response.data;
};

export const syncLogs = async (
  eventId: number,
  logs: {
    code: string;
    scanned_at: string;
    direction?: string;
    override_reason?: string | null;
    scan_method?: string;
    is_external?: boolean;
  }[]
) => {
  const response = await api.post(
    '/access/sync-logs',
    {
      event_id: eventId,
      logs,
    },
    { timeout: 60000 }
  );
  return response.data;
};

export const getDeltas = async (eventId: number, since: string | null) => {
  const response = await api.get(`/access/sync-deltas/${eventId}`, {
    params: { since },
    timeout: 15000,
  });
  return response.data;
};

export const validateCodeOnline = async (
  eventId: number,
  code: string,
  scannedAt: string,
  direction: 'in' | 'out' = 'in',
  allowZoneOverride: boolean = false,
  overrideReason: string | null = null,
  scanMethod: 'barcode' | 'nfc' | 'camera' = 'barcode',
  nfcCandidates: string[] = []
) => {
  const response = await api.post(
    '/access/validate',
    {
      event_id: eventId,
      code: code,
      scanned_at: scannedAt,
      direction,
      allow_zone_override: allowZoneOverride,
      override_reason: overrideReason,
      scan_method: scanMethod,
      nfc_candidates: scanMethod === 'nfc' ? nfcCandidates : undefined,
    },
    { timeout: 3500 }
  );
  return response.data;
};

export const registerExternalCode = async (payload: {
  event_id: number;
  code: string;
  type?: string;
  details?: string;
  max_uses?: number;
  auto_checkin?: boolean;
}) => {
  const response = await api.post('/access/register-code', payload, {
    timeout: 8000,
  });
  return response.data;
};
