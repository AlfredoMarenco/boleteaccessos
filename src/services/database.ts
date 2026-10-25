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
      scans_count INTEGER DEFAULT 0
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

  // Tabla para registrar cada escaneo localmente antes de sincronizar
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      result TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      synced INTEGER DEFAULT 0
    );
  `);
};

export const getDb = () => db;

// Funciones Helper para manejo rápido
export const insertCodesBatch = async (codes: any[]) => {
  if (!db) return;
  // TODO: Use transactions for fast bulk inserts
  await db.withTransactionAsync(async () => {
    // Para simplificar, borramos los anteriores y metemos los nuevos
    await db?.runAsync('DELETE FROM codes');
    // NO borramos logs aquí para preservar escaneos locales si se re-descargan los códigos del mismo evento

    const statement = await db?.prepareAsync(
      'INSERT INTO codes (code, type, status, metadata, max_uses, scans_count) VALUES ($code, $type, $status, $metadata, $max_uses, $scans_count)'
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
        });
        }
        await statement.finalizeAsync();
    }
    
    // Restaurar escaneos locales y estado de los códigos ya escaneados localmente
    await db?.runAsync(`
      UPDATE codes 
      SET scans_count = (SELECT COUNT(*) FROM logs WHERE logs.code = codes.code AND logs.result = 'success')
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

export const validateCodeLocally = async (codeStr: string, allowedSections: string[] | null = null) => {
  if (!db) return { status: 'error', message: 'DB not initialized' };

  // Soporte para QR Dinamico BLT1.{code}.{window}.{sig} cuando opera 100% offline
  let normalizedCode = codeStr.trim();
  if (normalizedCode.startsWith('BLT1.')) {
    const parts = normalizedCode.split('.');
    if (parts.length >= 2 && parts[1]) {
      normalizedCode = parts[1];
    }
  }

  const codeRow = await db.getFirstAsync<{ id: number, code: string, type: string, status: string, metadata: string, max_uses: number, scans_count: number }>(
    'SELECT id, code, type, status, metadata, max_uses, scans_count FROM codes WHERE code = ?',
    [normalizedCode]
  );

  const scannedAt = new Date().toISOString();

  if (!codeRow) {
    await db.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [codeStr, 'invalid', scannedAt]);
    return { status: 'invalid', message: 'Código no encontrado en el evento.' };
  }

  const maxUses = codeRow.max_uses ?? 1;
  const currentScans = codeRow.scans_count ?? 0;

  if (currentScans >= maxUses || codeRow.status === 'used') {
    await db.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [codeStr, 'duplicate', scannedAt]);
    const duplicateMsg = maxUses > 1
      ? `Límite de accesos alcanzado (${currentScans} de ${maxUses}).`
      : 'Código ya utilizado.';
    return {
      status: 'duplicate',
      message: duplicateMsg,
      scans_count: currentScans,
      max_uses: maxUses,
      type: codeRow.type,
      metadata: JSON.parse(codeRow.metadata || '{}')
    };
  }

  if (codeRow.status === 'cancelled') {
    return { status: 'cancelled', message: 'Código cancelado.', type: codeRow.type, metadata: JSON.parse(codeRow.metadata || '{}') };
  }

  // Validación offline de zona (si el dispositivo tiene secciones restringidas)
  if (allowedSections && allowedSections.length > 0) {
    const metadata = JSON.parse(codeRow.metadata || '{}');
    const codeSection = metadata?.details ?? '';
    if (!allowedSections.includes(codeSection)) {
      await db.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [codeStr, 'invalid_zone', scannedAt]);
      return {
        status: 'invalid_zone',
        message: `Acceso denegado. Este código pertenece a la zona '${codeSection}', la cual no está habilitada para esta puerta.`,
      };
    }
  }

  // Éxito: Incrementar contador y marcar como 'used' si llegó al límite
  const newScans = currentScans + 1;
  const isUsed = newScans >= maxUses;
  const newStatus = isUsed ? 'used' : 'pending';

  await db.runAsync('UPDATE codes SET scans_count = ?, status = ? WHERE id = ?', [newScans, newStatus, codeRow.id]);
  await db.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [codeStr, 'success', scannedAt]);

  const remaining = Math.max(0, maxUses - newScans);
  const successMsg = maxUses > 1
    ? `Acceso ${newScans} de ${maxUses} concedido.`
    : 'Acceso concedido.';

  return {
    status: 'success',
    message: successMsg,
    type: codeRow.type,
    metadata: JSON.parse(codeRow.metadata || '{}'),
    scans_count: newScans,
    max_uses: maxUses,
    remaining_scans: remaining,
  };
};

export const getUnsyncedLogs = async () => {
  if (!db) return [];
  return await db.getAllAsync<{ id: number, code: string, result: string, scanned_at: string }>('SELECT * FROM logs WHERE synced = 0');
};

export const markLogsAsSynced = async (ids: number[]) => {
  if (!db || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await db.runAsync(`UPDATE logs SET synced = 1 WHERE id IN (${placeholders})`, ids);
};

export const updateCodesStatus = async (deltas: { code: string; status: string; max_uses?: number; scans_count?: number }[]) => {
  if (!db || deltas.length === 0) return;
  try {
    for (const d of deltas) {
      if (d.scans_count !== undefined) {
        await db.runAsync(
          'UPDATE codes SET status = ?, scans_count = ?, max_uses = COALESCE(?, max_uses) WHERE code = ?',
          [d.status, d.scans_count, d.max_uses ?? null, d.code]
        );
      } else {
        await db.runAsync('UPDATE codes SET status = ? WHERE code = ?', [d.status, d.code]);
      }
    }
  } catch (error) {
    console.log("Error en updateCodesStatus:", error);
  }
};
