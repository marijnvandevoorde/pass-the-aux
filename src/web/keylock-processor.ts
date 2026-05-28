// AudioWorklet shell around the pure GrainShifter. Untestable headlessly
// (same caveat as the rest of src/web) — kept deliberately thin so all
// real logic lives in the unit-tested grain-shifter module.

import { GrainShifter } from "./grain-shifter.js";

// AudioWorklet global scope is not in lib.dom — declare the minimal surface
// we use (erased at compile time; real at worklet runtime).
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor,
): void;
interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: "a-rate" | "k-rate";
}

class KeylockProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: "shift",
        defaultValue: 1,
        minValue: 0.25,
        maxValue: 4,
        automationRate: "k-rate",
      },
    ];
  }

  #shifters: GrainShifter[] = [];

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || output.length === 0) return true;
    const shift = parameters["shift"]?.[0] ?? 1;

    for (let ch = 0; ch < output.length; ch++) {
      const outCh = output[ch]!;
      const inCh = input[ch] ?? input[0] ?? new Float32Array(outCh.length);
      let sh = this.#shifters[ch];
      if (!sh) {
        sh = new GrainShifter(shift);
        this.#shifters[ch] = sh;
      }
      sh.setShift(shift);
      outCh.set(sh.process(inCh));
    }
    return true;
  }
}

registerProcessor("keylock", KeylockProcessor);
