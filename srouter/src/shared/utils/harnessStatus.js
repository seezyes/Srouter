export function getHarnessStatus(status, tool) {
  if (tool?.statusMode === "installation") {
    if (!status || typeof status.installed !== "boolean") {
      return { label: "Unknown", cls: "bg-gray-500/10 text-gray-500" };
    }
    return status.installed
      ? { label: "Installed", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400" }
      : { label: "Not installed", cls: "bg-gray-500/10 text-gray-500" };
  }
  if (tool?.configType === "guide") return { label: "Guide", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400" };
  if (!status) return { label: "Unknown", cls: "bg-gray-500/10 text-gray-500" };
  if (!status.installed) return { label: "Not installed", cls: "bg-gray-500/10 text-gray-500" };
  if (status.hasSrouter) return { label: "Connected", cls: "bg-green-500/10 text-green-600 dark:text-green-400" };
  return { label: "Not configured", cls: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" };
}
