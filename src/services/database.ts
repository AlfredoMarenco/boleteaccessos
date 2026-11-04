import * as SQLite from 'expo-sqlite';

let db: SQLite.SQLiteDatabase | null = null;

export const initDatabase = async () => {
  db = await SQLite.openDatabaseAsync('boletea.db');

  // Tabla para almacenar los códigos del evento actual
  await db.execAsync(`
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
    await db.execAsync(`ALTER TABLE codes ADD COLUMN max_uses INTEGER DEFAULT 1;`);
  } catch (e) {
    // Columna ya existe
  }
  try {
    await db.execAsync(`ALTER TABLE codes ADD COLUMN scans_count INTEGER DEFAULT 0;`);
  } catch (e) {
    // Columna ya existe
  }
  try {
    await db.execAsync(`ALTER TABLE codes ADD COLUMN inside_count INTEGER DEFAULT 0;`);
  } catch (e) {
    // Columna ya existe
  }
  try {
    await db.execAsync(`ALTER TABLE codes ADD COLUMN is_external INTEGER DEFAULT 0;`);
  } catch (e) {
    // Columna ya existe
  }

  // Tabla para registrar cada escaneo localmente antes de sincronizar
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      result TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      synced INTEGER DEFAULT 0,
      direction TEXT DEFAULT 'in',
      override_reason TEXT
    );
  `);

  try {
    await db.execAsync(`ALTER TABLE logs ADD COLUMN direction TEXT DEFAULT 'in';`);
  } catch (e) {
    // Columna ya existe
  }
  try {
    await db.execAsync(`ALTER TABLE logs ADD COLUMN override_reason TEXT;`);
  } catch (e) {
    // Columna ya existe
  }
};

export const getDb = () => db;

// Funciones Helper para manejo rápido
export const insertCodesBatch = async (codes: any[]) => {
  if (!db) return;
  // Use transactions for fast bulk inserts
  await db.withTransactionAsync(async () => {
    // Para simplificar, borramos los anteriores y metemos los nuevos
    await db?.runAsync('DELETE FROM codes');
    // NO borramos logs aquí para preservar escaneos locales si se re-descargan los códigos del mismo evento

    const statement = await db?.prepareAsync(
      'INSERT INTO codes (code, type, status, metadata, max_uses, scans_count, inside_count, is_external) VALUES ($code, $type, $status, $metadata, $max_uses, $scans_count, $inside_count, $is_external)'
    );

    if (statement) {
      for (const c of codes) {
        await statement.executeAsync({
          $code: c.code,
          $type: c.type || 'General',
          $status: c.status,
          $metadata: JSON.stringify(c.metadata || {}),
          $max_uses: c.max_uses ?? 1,
          $scans_count: c.scans_count ?? 0,
          $inside_count: c.inside_count ?? 0,
          $is_external: c.is_external ? 1 : 0,
        });
      }
      await statement.finalizeAsync();
    }
    
    // Restaurar escaneos locales y estado de los códigos ya escaneados localmente
    await db?.runAsync(`
      UPDATE codes 
      SET scans_count = (SELECT COUNT(*) FROM logs WHERE logs.code = codes.code AND logs.result = 'success' AND (logs.direction IS NULL OR logs.direction = 'in'))
      WHERE code IN (SELECT code FROM logs WHERE result = 'success')
    `);
    await db?.runAsync(`
      UPDATE codes 
      SET status = 'used' 
      WHERE scans_count >= max_uses
    `);
  });
};

export const clearDatabaseForNewEvent = async () => {
  if (!db) return;
  await db.execAsync(`
    DELETE FROM codes;
    DELETE FROM logs;
  `);
};

export const validateCodeLocally = async (
  codeStr: string,
  allowedSections: string[] | null = null,
  direction: 'in' | 'out' = 'in',
  overrideReason: string | null = null
) => {
  if (!db) return { status: 'error', message: 'DB not initialized' };

  // Soporte para QR Dinamico BLT1.{code}.{window}.{sig} cuando opera 100% offline
  let normalizedCode = codeStr.trim();
  if (normalizedCode.startsWith('BLT1.')) {
    const parts = normalizedCode.split('.');
    if (parts.length >= 2 && parts[1]) {
      normalizedCode = parts[1];
    }
  }

  const codeRow = await db.getFirstAsync<{
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
    'SELECT id, code, type, status, metadata, max_uses, scans_count, inside_count, is_external FROM codes WHERE code = ?',
    [normalizedCode]
  );

  const scannedAt = new Date().toISOString();

  if (!codeRow) {
    await db.runAsync(
      'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
      [codeStr, 'invalid', scannedAt, direction, overrideReason]
    );
    return { status: 'invalid', message: 'Código no encontrado en el evento.' };
  }

  const maxUses = codeRow.max_uses ?? 1;
  const currentScans = codeRow.scans_count ?? 0;
  const currentInside = codeRow.inside_count ?? (currentScans > 0 ? 1 : 0);
  const metadata = JSON.parse(codeRow.metadata || '{}');

  // ----------------------------------------------------
  // MANEJO DE SALIDA (DIRECTION === 'out')
  // ----------------------------------------------------
  if (direction === 'out') {
    if (currentInside <= 0) {
      await db.runAsync(
        'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
        [codeStr, 'cannot_exit_not_inside', scannedAt, 'out', overrideReason]
      );
      return {
        status: 'cannot_exit_not_inside',
        message: 'No se puede dar salida: este boleto no ha registrado entrada previa.',
        scans_count: currentScans,
        inside_count: currentInside,
        max_uses: maxUses,
        type: codeRow.type,
        metadata,
      };
    }

    // Validar zona permitida a menos que haya override
    const codeSection = metadata?.details ?? '';
    const hasZoneOverride = overrideReason === 'wheelchair' || overrideReason === 'wheelchair_assisted_access';
    if (!hasZoneOverride && allowedSections && allowedSections.length > 0 && codeSection && !allowedSections.includes(codeSection)) {
      await db.runAsync(
        'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
        [codeStr, 'invalid_zone', scannedAt, 'out', overrideReason]
      );
      return {
        status: 'invalid_zone',
        message: `Salida denegada. Este código pertenece a la zona '${codeSection}', la cual no está habilitada para esta puerta.`,
        type: codeRow.type,
        metadata,
      };
    }

    const newInside = Math.max(0, currentInside - 1);
    const newScans = Math.max(0, currentScans - 1);
    // Si estaba used, se reactiva a pending para permitir reingreso
    const newStatus = 'pending';

    await db.runAsync(
      'UPDATE codes SET inside_count = ?, scans_count = ?, status = ? WHERE id = ?',
      [newInside, newScans, newStatus, codeRow.id]
    );

    await db.runAsync(
      'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
      [codeStr, 'success', scannedAt, 'out', overrideReason]
    );

    const remaining = Math.max(0, maxUses - newScans);

    return {
      status: 'success',
      direction: 'out',
      message: 'Salida registrada. Puede reingresar.',
      type: codeRow.type,
      metadata,
      scans_count: newScans,
      inside_count: newInside,
      max_uses: maxUses,
      remaining_scans: remaining,
      override_reason: overrideReason,
    };
  }

  // ----------------------------------------------------
  // MANEJO DE ENTRADA (DIRECTION === 'in')
  // ----------------------------------------------------
  if (currentScans >= maxUses || codeRow.status === 'used') {
    await db.runAsync(
      'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
      [codeStr, 'duplicate', scannedAt, 'in', overrideReason]
    );
    const duplicateMsg = maxUses > 1
      ? `Límite de accesos alcanzado (${currentScans} de ${maxUses}).`
      : 'Código ya utilizado.';
    return {
      status: 'duplicate',
      message: duplicateMsg,
      scans_count: currentScans,
      inside_count: currentInside,
      max_uses: maxUses,
      type: codeRow.type,
      metadata,
    };
  }

  if (codeRow.status === 'cancelled') {
    return { status: 'cancelled', message: 'Código cancelado.', type: codeRow.type, metadata };
  }

  // Validación offline de zona (si el dispositivo tiene secciones restringidas)
  const isAssistedWheelchair = overrideReason === 'wheelchair' || overrideReason === 'wheelchair_assisted_access';
  if (!isAssistedWheelchair && allowedSections && allowedSections.length > 0) {
    const codeSection = metadata?.details ?? '';
    if (codeSection && !allowedSections.includes(codeSection)) {
      await db.runAsync(
        'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
        [codeStr, 'invalid_zone', scannedAt, 'in', overrideReason]
      );
      return {
        status: 'invalid_zone',
        message: `Acceso denegado. Este código pertenece a la zona '${codeSection}', la cual no está habilitada para esta puerta.`,
        type: codeRow.type,
        metadata,
      };
    }
  }

  // Éxito: Incrementar contador y marcar como 'used' si llegó al límite
  const newScans = currentScans + 1;
  const newInside = currentInside + 1;
  const isUsed = newScans >= maxUses;
  const newStatus = isUsed ? 'used' : 'pending';

  await db.runAsync(
    'UPDATE codes SET scans_count = ?, inside_count = ?, status = ? WHERE id = ?',
    [newScans, newInside, newStatus, codeRow.id]
  );
  await db.runAsync(
    'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
    [codeStr, 'success', scannedAt, 'in', overrideReason]
  );

  const remaining = Math.max(0, maxUses - newScans);
  const successMsg = isAssistedWheelchair
    ? 'Acceso concedido (Bypass Asistido / Silla de Ruedas).'
    : maxUses > 1
      ? `Acceso ${newScans} de ${maxUses} concedido.`
      : 'Acceso concedido.';

  return {
    status: 'success',
    direction: 'in',
    message: successMsg,
    type: codeRow.type,
    metadata,
    scans_count: newScans,
    inside_count: newInside,
    max_uses: maxUses,
    remaining_scans: remaining,
    override_reason: overrideReason,
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
}) => {
  if (!db) return { status: 'error', message: 'DB not initialized' };

  const normalizedCode = codeData.code.trim();
  const maxUses = codeData.max_uses ?? 1;
  const codeType = codeData.type || 'Externo / Cortesía';
  const metadata = { details: codeData.details || 'General' };

  // Verificar si ya existe en la base SQLite local
  const existing = await db.getFirstAsync<{ id: number; code: string }>(
    'SELECT id, code FROM codes WHERE code = ?',
    [normalizedCode]
  );

  if (!existing) {
    await db.runAsync(
      'INSERT INTO codes (code, type, status, metadata, max_uses, scans_count, inside_count, is_external) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        normalizedCode,
        codeType,
        'pending',
        JSON.stringify(metadata),
        maxUses,
        0,
        0,
        codeData.is_external !== false ? 1 : 0,
      ]
    );
  }

  if (codeData.auto_checkin) {
    return await validateCodeLocally(
      normalizedCode,
      codeData.allowedSections ?? null,
      'in',
      'external_manual'
    );
  }

  return {
    status: 'success',
    message: 'Código registrado localmente con éxito.',
    code: normalizedCode,
    type: codeType,
    metadata,
    max_uses: maxUses,
  };
};

export const getUnsyncedLogs = async () => {
  if (!db) return [];
  return await db.getAllAsync<{
    id: number;
    code: string;
    result: string;
    scanned_at: string;
    direction?: string;
    override_reason?: string | null;
  }>('SELECT id, code, result, scanned_at, direction, override_reason FROM logs WHERE synced = 0');
};

export const markLogsAsSynced = async (ids: number[]) => {
  if (!db || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await db.runAsync(`UPDATE logs SET synced = 1 WHERE id IN (${placeholders})`, ids);
};

export const updateCodesStatus = async (
  deltas: {
    code: string;
    status: string;
    max_uses?: number;
    scans_count?: number;
    inside_count?: number;
  }[]
) => {
  if (!db || deltas.length === 0) return;
  try {
    for (const d of deltas) {
      if (d.scans_count !== undefined && d.inside_count !== undefined) {
        await db.runAsync(
          'UPDATE codes SET status = ?, scans_count = ?, inside_count = ?, max_uses = COALESCE(?, max_uses) WHERE code = ?',
          [d.status, d.scans_count, d.inside_count, d.max_uses ?? null, d.code]
        );
      } else if (d.scans_count !== undefined) {
        await db.runAsync(
          'UPDATE codes SET status = ?, scans_count = ?, max_uses = COALESCE(?, max_uses) WHERE code = ?',
          [d.status, d.scans_count, d.max_uses ?? null, d.code]
        );
      } else if (d.inside_count !== undefined) {
        await db.runAsync(
          'UPDATE codes SET status = ?, inside_count = ? WHERE code = ?',
          [d.status, d.inside_count, d.code]
        );
      } else {
        await db.runAsync('UPDATE codes SET status = ? WHERE code = ?', [d.status, d.code]);
      }
    }
  } catch (error) {
    console.log('Error en updateCodesStatus:', error);
  }
};
