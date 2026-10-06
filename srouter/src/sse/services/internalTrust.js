import { timingSafeEqual } from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";

// Same machine-bound capability as the dashboard guard, never a Host/Origin,
// session cookie, API key or publicly reproducible probe marker.
export async function isTrustedInternalRequest(request) {
  try {
    const token = request?.headers?.get?.("x-9r-cli-token");
    if (typeof token !== "string" || !/^[0-9a-f]{16}$/.test(token)) return false;
    const expected = await getConsistentMachineId("9r-cli-auth");
    if (typeof expected !== "string" || !/^[0-9a-f]{16}$/.test(expected)) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}
