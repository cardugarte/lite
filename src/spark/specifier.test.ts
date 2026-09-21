import { expect } from "jsr:@std/expect";
import { BREEZ_SDK_SPARK_DENO_SPECIFIER } from "./minter.ts";

Deno.test("breez-sdk-spark Deno export specifier is the 0.25.0 wasm path", () => {
  expect(BREEZ_SDK_SPARK_DENO_SPECIFIER).toEqual(
    "npm:@breeztech/breez-sdk-spark@0.25.0/deno/breez_sdk_spark_wasm.js",
  );
});

Deno.test("Fly image compile allows minter write and includes the Breez WASM", () => {
  const docker = Deno.readTextFileSync(new URL("../../Dockerfile", import.meta.url));
  expect(docker.includes("--allow-write")).toEqual(true);
  expect(docker.includes("breez_sdk_spark_wasm")).toEqual(true);
});
