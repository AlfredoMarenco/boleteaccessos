import * as SQLite from 'expo-sqlite';

let db: SQLite.SQLiteDatabase | null = null;
let dbInitPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export const getOrOpenDb = async (): Promise<SQLite.SQLiteDatabase> => {
  if (db) return db;
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const opened = await SQLite.openDatabaseAsync('boletea.db');
      db = opened;
      return opened;
    })();
  }
  return await dbInitPromise;
};

/**
 * Extrae el código base si es un QR dinámico con formato BLT1.{code}.{window}.{sig12}
 * Idéntico a SignedTicketQrService en Laravel.
 */
export const extractNormalizedCode = (rawScannedString: string): string => {
  const trimmed = (rawScannedString || '').trim();
  if (!trimmed.startsWith('BLT1.')) {
    return trimmed;
  }

  const parts = trimmed.split('.');
  if (parts.length >= 4) {
    parts.pop(); // sig12
    parts.pop(); // window
    parts.shift(); // BLT1
    const extracted = parts.join('.');
    if (extracted) {
      return extracted;
    }
  } else if (parts.length >= 2 && parts[1]) {
    return parts[1];
  }

  return trimmed;
};

/**
 * Resuelve la etiqueta legible de zona/sección idéntico a AccessControlController::resolveCodeZoneDisplay
 */
export const resolveCodeZoneDisplay = (metadata: any, type?: string | null): string => {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  for (const key of ['section', 'details', 'category']) {
    const val = String(meta[key] ?? '').trim();
    if (val !== '') {
      return val;
    }
  }
  const typeVal = String(type ?? '').trim();
  return typeVal !== '' ? typeVal : 'Desconocida';
};

/**
 * Comparador de zona/sección insensible a mayúsculas/minúsculas idéntico a AccessControlController::isCodeAllowedInSections
 */
export const isCodeAllowedInSections = (
  metadata: any,
  type: string | null | undefined,
  allowedSections: string[] | null | undefined,
  currentGroupName: string | null | undefined
): boolean => {
  if (!allowedSections || !Array.isArray(allowedSections) || allowedSections.length === 0) {
    return true;
  }

  const normalizedAllowed = allowedSections
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter((s) => s !== '');

  if (normalizedAllowed.length === 0) {
    return true;
  }

  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const candidates: string[] = [
    meta.section,
    meta.details,
    meta.category,
    type,
    meta.group_name,
  ]
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .map((v) => String(v).trim());

  if (Array.isArray(meta.allowed_sections)) {
    for (const extraSec of meta.allowed_sections) {
      if (typeof extraSec === 'string' && extraSec.trim() !== '') {
        candidates.push(extraSec.trim());
      }
    }
  }

  for (const candidate of candidates) {
    if (normalizedAllowed.includes(candidate.toLowerCase())) {
      return true;
    }
  }

  const metaGroup = typeof meta.group_name === 'string' ? meta.group_name.trim().toLowerCase() : '';
  const groupNameNorm = typeof currentGroupName === 'string' ? currentGroupName.trim().toLowerCase() : '';

  if (metaGroup !== '' && groupNameNorm !== '' && metaGroup === groupNameNorm) {
    return true;
  }

  return false;
};

export const initDatabase = async () => {
  const database = await getOrOpenDb();

  // Tabla para almacenar los códigos del evento actual
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      type TEXT,
      status TEXT NOT NULL,
      metadata TEXT,
      max_uses INTEGER DEFAULT 1,
      scans_count INTEGER DEFAULT 0,
      inside_count INTEGER DEFAULT 0,
      is_external INTEGER DEFAULT 0
    );
  `);

  // Migraciones seguras para bases de datos ya existentes
  try {
    await database.execAsync(`ALTER TABLE codes ADD COLUMN max_uses INTEGER DEFAULT 1;`);
  } catch (e) {}
  try {
    await database.execAsync(`ALTER TABLE codes ADD COLUMN scans_count INTEGER DEFAULT 0;`);
  } catch (e) {}
  try {
    await database.execAsync(`ALTER TABLE codes ADD COLUMN inside_count INTEGER DEFAULT 0;`);
  } catch (e) {}
  try {
    await database.execAsync(`ALTER TABLE codes ADD COLUMN is_external INTEGER DEFAULT 0;`);
  } catch (e) {}

  // Tabla para registrar cada escaneo localmente antes de sincronizar
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      result TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      synced INTEGER DEFAULT 0,
      direction TEXT DEFAULT 'in',
      override_reason TEXT,
      scan_method TEXT DEFAULT 'barcode',
      is_external INTEGER DEFAULT 0
    );
  `);

  try {
    await database.execAsync(`ALTER TABLE logs ADD COLUMN direction TEXT DEFAULT 'in';`);
  } catch (e) {}
  try {
    await database.execAsync(`ALTER TABLE logs ADD COLUMN override_reason TEXT;`);
  } catch (e) {}
  try {
    await database.execAsync(`ALTER TABLE logs ADD COLUMN scan_method TEXT DEFAULT 'barcode';`);
  } catch (e) {}
  try {
    await database.execAsync(`ALTER TABLE logs ADD COLUMN is_external INTEGER DEFAULT 0;`);
  } catch (e) {}
};

export const getDb = () => db;

// Funciones Helper para manejo rápido
export const insertCodesBatch = async (
  codes: any[],
  onProgress?: (processed: number, total: number) => void
) => {
  const database = await getOrOpenDb();
  if (!database) return;

  // 1. Conservar códigos externos creados localmente que aún no se hayan sincronizado
  const unsyncedExternalLogs = await database.getAllAsync<{ code: string }>(
    'SELECT DISTINCT code FROM logs WHERE synced = 0 AND is_external = 1'
  );
  const unsyncedExternalCodesSet = new Set(unsyncedExternalLogs.map((r) => r.code));

  let preservedExternals: any[] = [];
  if (unsyncedExternalCodesSet.size > 0) {
    const allExternals = await database.getAllAsync<any>(
      'SELECT code, type, status, metadata, max_uses, scans_count, inside_count, is_external FROM codes WHERE is_external = 1'
    );
    preservedExternals = allExternals.filter((row) => unsyncedExternalCodesSet.has(row.code));
  }

  // 2. Borrar códigos previos de manera segura
  await database.runAsync('DELETE FROM codes');

  // 3. Insertar en lotes (chunks) usando INSERT OR REPLACE para evitar fallos por códigos duplicados o status nulo
  const CHUNK_SIZE = 500;
  let processed = 0;

  for (let i = 0; i < codes.length; i += CHUNK_SIZE) {
    const chunk = codes.slice(i, i + CHUNK_SIZE);

    await database.withTransactionAsync(async () => {
      const statement = await database.prepareAsync(
        'INSERT OR REPLACE INTO codes (code, type, status, metadata, max_uses, scans_count, inside_count, is_external) VALUES ($code, $type, $status, $metadata, $max_uses, $scans_count, $inside_count, $is_external)'
      );

      try {
        for (const c of chunk) {
          if (!c || !c.code) continue;
          const cleanCode = String(c.code).trim();
          if (!cleanCode) continue;

          const serializedMetadata =
            typeof c.metadata === 'string'
              ? c.metadata
              : JSON.stringify(c.metadata || {});

          await statement.executeAsync({
            $code: cleanCode,
            $type: c.type || 'General',
            $status: c.status || 'pending',
            $metadata: serializedMetadata,
            $max_uses: Math.max(1, Number(c.max_uses ?? 1)),
            $scans_count: Math.max(0, Number(c.scans_count ?? 0)),
            $inside_count: Math.max(0, Number(c.inside_count ?? 0)),
            $is_external: c.is_external ? 1 : 0,
          });
        }
      } finally {
        await statement.finalizeAsync();
      }
    });

    processed += chunk.length;
    if (onProgress) {
      onProgress(processed, codes.length);
    }
  }

  // 4. Re-insertar códigos externos locales aún no sincronizados si no venían ya del servidor
  for (const ext of preservedExternals) {
    await database.runAsync(
      'INSERT OR IGNORE INTO codes (code, type, status, metadata, max_uses, scans_count, inside_count, is_external) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        ext.code,
        ext.type || 'Sistema Externo',
        ext.status || 'used',
        typeof ext.metadata === 'string' ? ext.metadata : JSON.stringify(ext.metadata || {}),
        ext.max_uses ?? 1,
        ext.scans_count ?? 1,
        ext.inside_count ?? 1,
        1,
      ]
    );
  }

  // 5. Aplicar ÚNICAMENTE escaneos locales NO sincronizados (synced = 0 y no externos ya contados) sobre los contadores del servidor
  const pendingLogs = await database.getAllAsync<{
    code: string;
    direction: string | null;
    is_external: number | null;
  }>(
    "SELECT code, direction, is_external FROM logs WHERE synced = 0 AND result = 'success' ORDER BY id ASC"
  );

  for (const log of pendingLogs) {
    if (log.is_external === 1) continue; // Ya tiene su estado reflejado al crearse
    const row = await database.getFirstAsync<{
      id: number;
      scans_count: number;
      inside_count: number;
      max_uses: number;
      status: string;
    }>('SELECT id, scans_count, inside_count, max_uses, status FROM codes WHERE code = ?', [log.code]);

    if (!row) continue;

    const maxUses = Math.max(1, row.max_uses ?? 1);
    if (log.direction === 'out') {
      const newInside = Math.max(0, (row.inside_count ?? 0) - 1);
      const newScans = Math.max(0, (row.scans_count ?? 0) - 1);
      const newStatus = row.status === 'used' ? 'pending' : row.status;
      await database.runAsync(
        'UPDATE codes SET inside_count = ?, scans_count = ?, status = ? WHERE id = ?',
        [newInside, newScans, newStatus, row.id]
      );
    } else {
      const newScans = (row.scans_count ?? 0) + 1;
      const newInside = (row.inside_count ?? 0) + 1;
      const newStatus = newScans >= maxUses ? 'used' : 'pending';
      await database.runAsync(
        'UPDATE codes SET inside_count = ?, scans_count = ?, status = ? WHERE id = ?',
        [newInside, newScans, newStatus, row.id]
      );
    }
  }
};

export const clearDatabaseForNewEvent = async () => {
  const database = await getOrOpenDb();
  if (!database) return;
  await database.runAsync('DELETE FROM codes');
  await database.runAsync('DELETE FROM logs');
};

export const validateCodeLocally = async (
  codeStr: string,
  allowedSections: string[] | null = null,
  direction: 'in' | 'out' = 'in',
  overrideReason: string | null = null,
  nfcCandidates: string[] = [],
  currentGroupName: string | null = null,
  allowZoneOverride: boolean = false,
  scanMethod: 'barcode' | 'nfc' | 'camera' = 'barcode',
  allowAssistedZoneOverrideFeature: boolean = true
) => {
  const database = await getOrOpenDb();
  if (!database) return { status: 'error', message: 'DB not initialized' };

  const normalizedCode = extractNormalizedCode(codeStr);

  let codeRow = await database.getFirstAsync<{
    id: number;
    code: string;
    type: string;
    status: string;
    metadata: string;
    max_uses: number;
    scans_count: number;
    inside_count: number;
    is_external: number;
  }>(
    'SELECT id, code, type, status, metadata, max_uses, scans_count, inside_count, is_external FROM codes WHERE code = ? OR LOWER(code) = LOWER(?) LIMIT 1',
    [normalizedCode, normalizedCode]
  );

  if (!codeRow && scanMethod === 'nfc' && nfcCandidates && nfcCandidates.length > 0) {
    const placeholders = nfcCandidates.map(() => '?').join(',');
    codeRow = await database.getFirstAsync<{
      id: number;
      code: string;
      type: string;
      status: string;
      metadata: string;
      max_uses: number;
      scans_count: number;
      inside_count: number;
      is_external: number;
    }>(
      `SELECT id, code, type, status, metadata, max_uses, scans_count, inside_count, is_external FROM codes WHERE code IN (${placeholders}) LIMIT 1`,
      nfcCandidates
    );
  }

  const scannedAt = new Date().toISOString();

  if (!codeRow) {
    await database.runAsync(
      'INSERT INTO logs (code, result, scanned_at, direction, override_reason, scan_method) VALUES (?, ?, ?, ?, ?, ?)',
      [normalizedCode, 'invalid', scannedAt, direction, overrideReason, scanMethod]
    );
    return { status: 'invalid', message: 'Código no encontrado.' };
  }

  const effectiveCode = codeRow.code || normalizedCode;
  let metadata: any = {};
  try {
    metadata = JSON.parse(codeRow.metadata || '{}');
  } catch (e) {
    metadata = {};
  }

  // Regla estricta idéntica al servidor: si el status es vacío, cancelled, denied, sin_acceso o inactive -> rechazar
  if (!codeRow.status || ['cancelled', 'denied', 'sin_acceso', 'inactive'].includes(codeRow.status.toLowerCase())) {
    await database.runAsync(
      'INSERT INTO logs (code, result, scanned_at, direction, override_reason, scan_method) VALUES (?, ?, ?, ?, ?, ?)',
      [effectiveCode, 'cancelled', scannedAt, direction, overrideReason, scanMethod]
    );
    return {
      status: 'cancelled',
      matched_code: effectiveCode,
      message: 'Boleto cancelado o sin acceso.',
      type: codeRow.type,
      metadata,
      seat_flag: metadata?.seat_flag ?? null,
    };
  }

  const maxUses = Math.max(1, Number(codeRow.max_uses ?? 1));
  const currentScans = Math.max(0, Number(codeRow.scans_count ?? 0));
  const currentInside = Math.max(0, Number(codeRow.inside_count ?? 0));

  // Validación de zona idéntica al backend
  const codeSectionDisplay = resolveCodeZoneDisplay(metadata, codeRow.type);
  const isAllowedZone = isCodeAllowedInSections(
    metadata,
    codeRow.type,
    allowedSections,
    currentGroupName
  );

  const hasPriorAssistedAuth = Boolean(metadata?.assisted_zone_authorized);
  const canOverrideZone =
    (allowZoneOverride ||
      hasPriorAssistedAuth ||
      overrideReason === 'wheelchair' ||
      overrideReason === 'wheelchair_assisted_access') &&
    allowAssistedZoneOverrideFeature;

  // ----------------------------------------------------
  // MANEJO DE SALIDA (DIRECTION === 'out')
  // ----------------------------------------------------
  if (direction === 'out') {
    if (currentInside <= 0) {
      await database.runAsync(
        'INSERT INTO logs (code, result, scanned_at, direction, override_reason, scan_method) VALUES (?, ?, ?, ?, ?, ?)',
        [effectiveCode, 'cannot_exit_not_inside', scannedAt, 'out', overrideReason, scanMethod]
      );
      return {
        status: 'cannot_exit_not_inside',
        direction: 'out',
        matched_code: effectiveCode,
        message: 'No se puede dar salida: este boleto no ha registrado entrada previa.',
        scans_count: currentScans,
        inside_count: currentInside,
        max_uses: maxUses,
        type: codeRow.type,
        metadata,
        seat_flag: metadata?.seat_flag ?? null,
      };
    }

    if (!isAllowedZone && !canOverrideZone) {
      await database.runAsync(
        'INSERT INTO logs (code, result, scanned_at, direction, override_reason, scan_method) VALUES (?, ?, ?, ?, ?, ?)',
        [effectiveCode, 'invalid_zone', scannedAt, 'out', overrideReason, scanMethod]
      );
      return {
        status: 'invalid_zone',
        matched_code: effectiveCode,
        direction: 'out',
        message: `Salida denegada. Este código pertenece a la zona '${codeSectionDisplay}', la cual no está habilitada para esta puerta.`,
        type: codeRow.type,
        metadata,
        seat_flag: metadata?.seat_flag ?? null,
      };
    }

    const newInside = Math.max(0, currentInside - 1);
    const newScans = Math.max(0, currentScans - 1);
    const newStatus = codeRow.status === 'used' ? 'pending' : codeRow.status;
    const effectiveOverride =
      !isAllowedZone && canOverrideZone
        ? overrideReason || 'wheelchair_assisted_access'
        : overrideReason;

    await database.runAsync(
      'UPDATE codes SET inside_count = ?, scans_count = ?, status = ? WHERE id = ?',
      [newInside, newScans, newStatus, codeRow.id]
    );

    await database.runAsync(
      'INSERT INTO logs (code, result, scanned_at, direction, override_reason, scan_method) VALUES (?, ?, ?, ?, ?, ?)',
      [effectiveCode, 'success', scannedAt, 'out', effectiveOverride, scanMethod]
    );

    const remaining = Math.max(0, maxUses - newScans);

    return {
      status: 'success',
      direction: 'out',
      matched_code: effectiveCode,
      message: 'Salida registrada. Puede reingresar.',
      type: codeRow.type,
      metadata,
      seat_flag: metadata?.seat_flag ?? null,
      scans_count: newScans,
      inside_count: newInside,
      max_uses: maxUses,
      remaining_scans: remaining,
      override_reason: effectiveOverride,
    };
  }

  // ----------------------------------------------------
  // MANEJO DE ENTRADA (DIRECTION === 'in')
  // ----------------------------------------------------
  if (currentScans >= maxUses || codeRow.status === 'used') {
    const lastSuccessLog = await database.getFirstAsync<{ scanned_at: string }>(
      "SELECT scanned_at FROM logs WHERE code = ? AND result = 'success' AND (direction IS NULL OR direction = 'in') ORDER BY id DESC LIMIT 1",
      [effectiveCode]
    );

    await database.runAsync(
      'INSERT INTO logs (code, result, scanned_at, direction, override_reason, scan_method) VALUES (?, ?, ?, ?, ?, ?)',
      [effectiveCode, 'duplicate', scannedAt, 'in', overrideReason, scanMethod]
    );
    const duplicateMsg =
      maxUses > 1
        ? `Límite de accesos alcanzado (${currentScans} de ${maxUses}).`
        : 'Código ya utilizado.';
    return {
      status: 'duplicate',
      direction: 'in',
      matched_code: effectiveCode,
      message: duplicateMsg,
      scans_count: currentScans,
      inside_count: currentInside,
      max_uses: maxUses,
      type: codeRow.type,
      metadata,
      seat_flag: metadata?.seat_flag ?? null,
      duplicate_info: lastSuccessLog
        ? {
            scanned_at: lastSuccessLog.scanned_at,
            device_name: 'Este Dispositivo',
          }
        : undefined,
    };
  }

  // Validación offline de zona
  if (!isAllowedZone && !canOverrideZone) {
    await database.runAsync(
      'INSERT INTO logs (code, result, scanned_at, direction, override_reason, scan_method) VALUES (?, ?, ?, ?, ?, ?)',
      [effectiveCode, 'invalid_zone', scannedAt, 'in', overrideReason, scanMethod]
    );
    return {
      status: 'invalid_zone',
      matched_code: effectiveCode,
      direction: 'in',
      message: `Acceso denegado. Este código pertenece a la zona '${codeSectionDisplay}', la cual no está habilitada para esta puerta.`,
      type: codeRow.type,
      metadata,
      seat_flag: metadata?.seat_flag ?? null,
    };
  }

  const effectiveOverride =
    !isAllowedZone && canOverrideZone
      ? overrideReason || 'wheelchair_assisted_access'
      : overrideReason;

  // Éxito: Incrementar contador y marcar como 'used' si llegó al límite
  const newScans = currentScans + 1;
  const newInside = currentInside + 1;
  const isUsed = newScans >= maxUses;
  const newStatus = isUsed ? 'used' : 'pending';

  if (effectiveOverride) {
    metadata.assisted_zone_authorized = true;
  }

  await database.runAsync(
    'UPDATE codes SET scans_count = ?, inside_count = ?, status = ?, metadata = ? WHERE id = ?',
    [newScans, newInside, newStatus, JSON.stringify(metadata), codeRow.id]
  );
  await database.runAsync(
    'INSERT INTO logs (code, result, scanned_at, direction, override_reason, scan_method) VALUES (?, ?, ?, ?, ?, ?)',
    [effectiveCode, 'success', scannedAt, 'in', effectiveOverride, scanMethod]
  );

  const remaining = Math.max(0, maxUses - newScans);
  const successMsg = effectiveOverride
    ? 'Acceso concedido (Bypass Asistido / Silla de Ruedas).'
    : maxUses > 1
      ? `Acceso ${newScans} de ${maxUses} concedido.`
      : 'Acceso concedido.';

  return {
    status: 'success',
    direction: 'in',
    matched_code: effectiveCode,
    message: successMsg,
    type: codeRow.type,
    metadata,
    seat_flag: metadata?.seat_flag ?? null,
    scans_count: newScans,
    inside_count: newInside,
    max_uses: maxUses,
    remaining_scans: remaining,
    override_reason: effectiveOverride,
  };
};

export const registerCodeLocally = async (codeData: {
  code: string;
  type?: string;
  details?: string;
  max_uses?: number;
  is_external?: boolean;
  auto_checkin?: boolean;
  allowedSections?: string[] | null;
  group_name?: string | null;
  sync_only?: boolean;
}) => {
  const database = await getOrOpenDb();
  if (!database) return { status: 'error', message: 'DB not initialized' };

  const normalizedCode = extractNormalizedCode(codeData.code);
  const maxUses = Math.max(1, Number(codeData.max_uses ?? 1));
  const codeType = codeData.type || 'Sistema Externo';
  const inheritedZone =
    codeData.details ||
    codeData.group_name ||
    (codeData.allowedSections && codeData.allowedSections[0]) ||
    'General';
  const metadata = {
    details: inheritedZone,
    group_name: codeData.group_name || null,
    allowed_sections: codeData.allowedSections || [],
    source: 'external_quick_registration',
  };

  const scannedAt = new Date().toISOString();

  // Verificar si ya existe en la base SQLite local (insensible a mayúsculas/minúsculas)
  const existing = await database.getFirstAsync<{
    id: number;
    code: string;
    type: string;
    status: string;
    scans_count: number;
    inside_count: number;
    max_uses: number;
    metadata: string;
  }>(
    'SELECT id, code, type, status, scans_count, inside_count, max_uses, metadata FROM codes WHERE code = ? OR LOWER(code) = LOWER(?) LIMIT 1',
    [normalizedCode, normalizedCode]
  );

  // Si solo estamos sincronizando en SQLite un código recién creado exitosamente en el servidor
  if (codeData.sync_only) {
    const isUsed = Boolean(codeData.auto_checkin) && maxUses <= 1;
    await database.runAsync(
      'INSERT OR REPLACE INTO codes (code, type, status, metadata, max_uses, scans_count, inside_count, is_external) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        normalizedCode,
        codeType,
        isUsed ? 'used' : 'pending',
        JSON.stringify(metadata),
        maxUses,
        codeData.auto_checkin ? 1 : 0,
        codeData.auto_checkin ? 1 : 0,
        codeData.is_external !== false ? 1 : 0,
      ]
    );
    return { status: 'success', code: normalizedCode };
  }

  // Regla estricta: NUNCA permitir guardar un código más de 1 vez (aunque esté pending o used)
  if (existing) {
    let existingMeta: any = {};
    try {
      existingMeta = JSON.parse(existing.metadata || '{}');
    } catch (e) {
      existingMeta = {};
    }

    if (!existing.status || ['cancelled', 'denied', 'sin_acceso', 'inactive'].includes(existing.status.toLowerCase())) {
      await database.runAsync(
        'INSERT INTO logs (code, result, scanned_at, direction, override_reason, is_external) VALUES (?, ?, ?, ?, ?, ?)',
        [existing.code, 'cancelled', scannedAt, 'in', 'external_registration_attempt', 1]
      );
      return {
        status: 'cancelled',
        matched_code: existing.code,
        message: 'Código cancelado o sin acceso.',
        type: existing.type || codeType,
        metadata: existingMeta,
      };
    }

    const currentScans = existing.scans_count ?? 0;
    const currentInside = existing.inside_count ?? 0;
    const maxExisting = existing.max_uses ?? 1;

    await database.runAsync(
      'INSERT INTO logs (code, result, scanned_at, direction, override_reason, is_external) VALUES (?, ?, ?, ?, ?, ?)',
      [existing.code, 'duplicate', scannedAt, 'in', 'external_registration_duplicate', 1]
    );

    return {
      status: 'duplicate',
      direction: 'in',
      matched_code: existing.code,
      message: 'Este código ya fue guardado o registrado previamente.',
      scans_count: currentScans,
      inside_count: currentInside,
      max_uses: maxExisting,
      type: existing.type || codeType,
      metadata: existingMeta,
    };
  }

  const autoCheckin = Boolean(codeData.auto_checkin);
  const initialScans = autoCheckin ? 1 : 0;
  const initialInside = autoCheckin ? 1 : 0;
  const initialStatus = autoCheckin && maxUses <= 1 ? 'used' : 'pending';

  // Insertar nuevo registro y (si auto_checkin) su log en una sola operación
  await database.runAsync(
    'INSERT INTO codes (code, type, status, metadata, max_uses, scans_count, inside_count, is_external) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      normalizedCode,
      codeType,
      initialStatus,
      JSON.stringify(metadata),
      maxUses,
      initialScans,
      initialInside,
      codeData.is_external !== false ? 1 : 0,
    ]
  );

  if (autoCheckin) {
    await database.runAsync(
      'INSERT INTO logs (code, result, scanned_at, direction, override_reason, scan_method, is_external) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [normalizedCode, 'success', scannedAt, 'in', 'external_registration_auto_checkin', 'barcode', 1]
    );
  }

  return {
    status: 'success',
    direction: 'in',
    matched_code: normalizedCode,
    message: autoCheckin
      ? 'Código externo registrado y acceso concedido exitosamente.'
      : 'Código registrado localmente con éxito.',
    code: normalizedCode,
    type: codeType,
    metadata,
    scans_count: initialScans,
    inside_count: initialInside,
    max_uses: maxUses,
    remaining_scans: Math.max(0, maxUses - initialScans),
  };
};

export const getUnsyncedLogs = async () => {
  const database = await getOrOpenDb();
  if (!database) return [];
  return await database.getAllAsync<{
    id: number;
    code: string;
    result: string;
    scanned_at: string;
    direction?: string;
    override_reason?: string | null;
    scan_method?: string;
    is_external?: number;
  }>('SELECT id, code, result, scanned_at, direction, override_reason, scan_method, is_external FROM logs WHERE synced = 0');
};

export const markLogsAsSynced = async (ids: number[]) => {
  const database = await getOrOpenDb();
  if (!database || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await database.runAsync(`UPDATE logs SET synced = 1 WHERE id IN (${placeholders})`, ids);
};

export const updateCodesStatus = async (
  deltas: {
    code: string;
    status: string;
    max_uses?: number;
    scans_count?: number;
    inside_count?: number;
    metadata?: any;
  }[]
) => {
  const database = await getOrOpenDb();
  if (!database || deltas.length === 0) return;
  try {
    for (const d of deltas) {
      if (d.metadata !== undefined && d.scans_count !== undefined && d.inside_count !== undefined) {
        await database.runAsync(
          'UPDATE codes SET status = ?, scans_count = ?, inside_count = ?, max_uses = COALESCE(?, max_uses), metadata = ? WHERE code = ?',
          [d.status, d.scans_count, d.inside_count, d.max_uses ?? null, JSON.stringify(d.metadata), d.code]
        );
      } else if (d.scans_count !== undefined && d.inside_count !== undefined) {
        await database.runAsync(
          'UPDATE codes SET status = ?, scans_count = ?, inside_count = ?, max_uses = COALESCE(?, max_uses) WHERE code = ?',
          [d.status, d.scans_count, d.inside_count, d.max_uses ?? null, d.code]
        );
      } else if (d.scans_count !== undefined) {
        await database.runAsync(
          'UPDATE codes SET status = ?, scans_count = ?, max_uses = COALESCE(?, max_uses) WHERE code = ?',
          [d.status, d.scans_count, d.max_uses ?? null, d.code]
        );
      } else if (d.inside_count !== undefined) {
        await database.runAsync(
          'UPDATE codes SET status = ?, inside_count = ? WHERE code = ?',
          [d.status, d.inside_count, d.code]
        );
      } else {
        await database.runAsync('UPDATE codes SET status = ? WHERE code = ?', [d.status, d.code]);
      }
    }
  } catch (error) {
    console.log('Error en updateCodesStatus:', error);
  }
};
