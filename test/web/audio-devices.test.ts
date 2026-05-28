import test from "node:test";
import assert from "node:assert/strict";
import {
  deviceLabel,
  pickOutputDevice,
} from "../../src/web/audio-devices.ts";

const devs = [
  { deviceId: "default", label: "" },
  { deviceId: "abc", label: "Bluetooth Headphones" },
];

test("saved device is used only if still present", () => {
  assert.equal(pickOutputDevice(devs, "abc"), "abc");
  assert.equal(pickOutputDevice(devs, "gone"), null);
  assert.equal(pickOutputDevice(devs, null), null);
  assert.equal(pickOutputDevice(devs, ""), null);
});

test("deviceLabel falls back when the browser withholds labels", () => {
  assert.equal(deviceLabel(devs[1]!, 1), "Bluetooth Headphones");
  assert.equal(deviceLabel(devs[0]!, 0), "Default output");
  assert.equal(deviceLabel({ deviceId: "x", label: "" }, 2), "Output 3");
});
