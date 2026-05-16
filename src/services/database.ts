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
      metadata TEXT
    );
  `);

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
    await db?.runAsync('DELETE FROM logs'); // Reseteamos logs al cambiar de evento

    const statement = await db?.prepareAsync(
      'INSERT INTO codes (code, type, status, metadata) VALUES ($code, $type, $status, $metadata)'
    );

    if (statement) {
        for (const c of codes) {
        await statement.executeAsync({
            $code: c.code,
            $type: c.type || 'General',
            $status: c.status,
            $metadata: JSON.stringify(c.metadata || {}),
        });
        }
        await statement.finalizeAsync();
    }
  });
};

export const validateCodeLocally = async (codeStr: string, allowedSections: string[] | null = null) => {
  if (!db) return { status: 'error', message: 'DB not initialized' };

  const codeRow = await db.getFirstAsync<{ id: number, code: string, type: string, status: string, metadata: string }>(
    'SELECT * FROM codes WHERE code = ?',
    [codeStr]
  );

  const scannedAt = new Date().toISOString();

  if (!codeRow) {
    await db.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [codeStr, 'invalid', scannedAt]);
    return { status: 'invalid', message: 'Código no encontrado en el evento.' };
  }

  if (codeRow.status === 'used') {
    await db.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [codeStr, 'duplicate', scannedAt]);
    return { status: 'duplicate', message: 'Código ya utilizado.' };
  }

  if (codeRow.status === 'cancelled') {
    return { status: 'cancelled', message: 'Código cancelado.' };
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

  // Éxito: Marcar como usado y registrar
  await db.runAsync('UPDATE codes SET status = ? WHERE id = ?', ['used', codeRow.id]);
  await db.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [codeStr, 'success', scannedAt]);

  return { status: 'success', message: 'Acceso concedido.', type: codeRow.type, metadata: JSON.parse(codeRow.metadata || '{}') };
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

export const updateCodesStatus = async (deltas: { code: string; status: string }[]) => {
  if (!db || deltas.length === 0) return;
  try {
    for (const d of deltas) {
      await db.runAsync('UPDATE codes SET status = ? WHERE code = ?', [d.status, d.code]);
    }
  } catch (error) {
    console.log("Error en updateCodesStatus:", error);
  }
};
