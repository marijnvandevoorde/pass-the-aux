// Pure (DOM-free) audio-output device selection. The browser
// MediaDevices/setSinkId glue stays in app.ts; this is the testable seam:
// given the current output devices and a saved id, decide what to use.

export interface OutDevice {
  deviceId: string;
  label: string;
}

/** A saved device id is honoured only if it's still present; else null
 *  ("" / null = the browser default sink). */
export function pickOutputDevice(
  devices: readonly OutDevice[],
  savedId: string | null | undefined,
): string | null {
  if (!savedId) return null;
  return devices.some((d) => d.deviceId === savedId) ? savedId : null;
}

/** Display label, falling back to a stable placeholder when the browser
 *  withholds labels (no permission yet). */
export function deviceLabel(d: OutDevice, index: number): string {
  const l = d.label.trim();
  if (l) return l;
  return d.deviceId === "default" ? "Default output" : `Output ${index + 1}`;
}
