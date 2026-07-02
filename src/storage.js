export const BACKUP_VERSION = 1;

export function buildBackupPayload(state) {
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      tasks: state.tasks || [],
      snapshots: state.snapshots || [],
      alerts: state.alerts || [],
      settings: state.settings || {},
      profiles: state.profiles || [],
      activeProfileId: state.activeProfileId || null,
      customHolidays: state.customHolidays || [],
      customDestinations: state.customDestinations || []
    }
  };
}

export function serializeBackup(state) {
  return JSON.stringify(buildBackupPayload(state), null, 2);
}

export function serializeCsv(rows, headers) {
  return [
    headers.map((header) => escapeCsvCell(header.label)).join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header.key] ?? "")).join(","))
  ].join("\n");
}

export function parseBackup(text, defaultSettings) {
  const parsed = JSON.parse(text);
  const data = parsed && parsed.data ? parsed.data : parsed;

  return {
    tasks: asArray(data.tasks),
    snapshots: asArray(data.snapshots),
    alerts: asArray(data.alerts),
    settings: { ...defaultSettings, ...(data.settings || {}) },
    profiles: asArray(data.profiles),
    activeProfileId: data.activeProfileId || null,
    customHolidays: asArray(data.customHolidays),
    customDestinations: asArray(data.customDestinations)
  };
}

export function removeTaskData({ tasks, snapshots, alerts }, taskId) {
  const removedSnapshotIds = asArray(snapshots)
    .filter((snapshot) => snapshot.watchTaskId === taskId)
    .map((snapshot) => snapshot.id);
  return {
    tasks: asArray(tasks).filter((task) => task.id !== taskId),
    snapshots: asArray(snapshots).filter((snapshot) => snapshot.watchTaskId !== taskId),
    alerts: asArray(alerts).filter(
      (alert) => alert.watchTaskId !== taskId && !removedSnapshotIds.includes(alert.flightPriceSnapshotId)
    )
  };
}

export function pruneSnapshotsByTask({ snapshots, alerts }, maxSnapshotsPerTask) {
  const limit = Number(maxSnapshotsPerTask);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { snapshots: asArray(snapshots), alerts: asArray(alerts), removedSnapshotIds: [] };
  }

  const keptIds = new Set();
  const grouped = new Map();
  asArray(snapshots).forEach((snapshot) => {
    const key = snapshot.watchTaskId || "unknown";
    grouped.set(key, [...(grouped.get(key) || []), snapshot]);
  });

  grouped.forEach((items) => {
    items
      .slice()
      .sort((a, b) => new Date(b.searchedAt || 0) - new Date(a.searchedAt || 0))
      .slice(0, limit)
      .forEach((snapshot) => keptIds.add(snapshot.id));
  });

  const prunedSnapshots = asArray(snapshots).filter((snapshot) => keptIds.has(snapshot.id));
  const removedSnapshotIds = asArray(snapshots)
    .filter((snapshot) => !keptIds.has(snapshot.id))
    .map((snapshot) => snapshot.id);
  return {
    snapshots: prunedSnapshots,
    alerts: asArray(alerts).filter((alert) => !removedSnapshotIds.includes(alert.flightPriceSnapshotId)),
    removedSnapshotIds
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeCsvCell(value) {
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
