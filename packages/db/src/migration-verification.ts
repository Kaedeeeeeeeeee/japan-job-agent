export function missingKnownMigrations(knownFiles: readonly string[], appliedFiles: readonly string[]): string[] {
  const applied = new Set(appliedFiles);
  return [...new Set(knownFiles)].filter((filename) => !applied.has(filename)).sort();
}

export function assertKnownMigrationsApplied(knownFiles: readonly string[], appliedFiles: readonly string[]): void {
  const missing = missingKnownMigrations(knownFiles, appliedFiles);
  if (missing.length > 0) throw new Error(`missing known migrations: ${missing.join(", ")}`);
}
