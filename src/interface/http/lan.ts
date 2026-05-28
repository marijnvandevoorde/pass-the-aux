import os from "node:os";

/** Non-internal IPv4 addresses, for the "share this on the VLAN" banner. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}
