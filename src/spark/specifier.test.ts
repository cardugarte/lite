import { expect } from "jsr:@std/expect";
import { BREEZ_SDK_SPARK_NODE_SPECIFIER } from "./minter.ts";

Deno.test("breez-sdk-spark specifier is the package's exported ./nodejs subpath", () => {
  expect(BREEZ_SDK_SPARK_NODE_SPECIFIER).toEqual("npm:@breeztech/breez-sdk-spark@0.25.0/nodejs");
});

Deno.test("Fly image compile includes the exported Breez Node entry and not a deep wasm path", () => {
  const docker = Deno.readTextFileSync(new URL("../../Dockerfile", import.meta.url));
  expect(docker.includes("--allow-write")).toEqual(true);
  expect(docker.includes("--include npm:@breeztech/breez-sdk-spark@0.25.0/nodejs ")).toEqual(true);
  expect(docker.includes("breez-sdk-spark@0.25.0/deno")).toEqual(false);
  expect(docker.includes("breez_sdk_spark_wasm")).toEqual(false);
});
