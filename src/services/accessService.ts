import { api } from './api';

export const loginDevice = async (device_identifier: string, api_token: string) => {
  const response = await api.post('/access/login-device', {
    device_identifier,
    api_token,
  });
  return response.data;
};

export const getEvents = async () => {
  const response = await api.get('/access/events');
  return response.data;
};

export const syncCodes = async (eventId: number, onProgress?: (progressEvent: any) => void) => {
  const response = await api.get(`/access/sync/${eventId}`, {
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
  }[]
) => {
  const response = await api.post('/access/sync-logs', {
    event_id: eventId,
    logs,
  });
  return response.data;
};

export const getDeltas = async (eventId: number, since: string | null) => {
  const response = await api.get(`/access/sync-deltas/${eventId}`, {
    params: { since },
  });
  return response.data;
};

export const validateCodeOnline = async (
  eventId: number,
  code: string,
  scannedAt: string,
  direction: 'in' | 'out' = 'in',
  allowZoneOverride: boolean = false,
  overrideReason: string | null = null
) => {
  const response = await api.post('/access/validate', {
    event_id: eventId,
    code: code,
    scanned_at: scannedAt,
    direction,
    allow_zone_override: allowZoneOverride,
    override_reason: overrideReason,
  });
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
  const response = await api.post('/access/register-code', payload);
  return response.data;
};
