export default {
  version: 4,
  name: "add-api-key-access",
  up(db) {
    const columns = new Set(db.all("PRAGMA table_info(apiKeys)").map((column) => column.name));
    for (const name of ["allowedProviders", "allowedCombos", "allowedKinds"]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE apiKeys ADD COLUMN ${name} TEXT`);
    }
    // Existing keys get NULL. Do not reinterpret [] written by another router
    // or a previous explicit restriction as unrestricted.
  },
};
