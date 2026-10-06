// Adapted from VansRouter ad591d72. No-auth providers are grantable even
// without connections; custom node names and routing prefixes stay visible.
export function buildProviderList(connections, nodes, registered = []) {
  const nodeMap = new Map((nodes || []).map((node) => [node.id, node]));
  const registry = new Map(registered.map((entry) => [entry.id, entry]));
  const providers = new Map();
  for (const connection of connections || []) {
    const entry = providers.get(connection.provider) || { id: connection.provider, count: 0, alias: connection.alias || null };
    entry.count++;
    providers.set(connection.provider, entry);
  }
  for (const entry of registered) {
    if (entry.noAuth && !providers.has(entry.id)) {
      providers.set(entry.id, { id: entry.id, count: 0, alias: entry.alias || null });
    }
  }
  // Custom web search nodes are routable targets without registry entries and
  // may have no connections (keyless or linked mode), yet runtime ACL expects
  // an explicit node-id grant — so they must be grantable here.
  for (const node of nodes || []) {
    if (node?.type === "custom-websearch" && !providers.has(node.id)) {
      providers.set(node.id, { id: node.id, count: 0, alias: null });
    }
  }
  return [...providers.values()].map((entry) => {
    const node = nodeMap.get(entry.id);
    const provider = registry.get(entry.id);
    return { ...entry, displayName: node?.name || provider?.displayName || entry.id,
      prefix: node?.prefix || null,
      serviceKinds: provider?.serviceKinds || (node?.type === "custom-websearch" ? ["webSearch"] : ["llm"]) };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
