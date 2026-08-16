import { describe, expect, test } from "bun:test";

import {
  parseDumpbinDependencies,
  parseLddMissing,
  parseLddResolved,
  parseOtoolDependencies,
} from "./native-inspection";

describe("native dependency inspection parsers", () => {
  test("parses macOS loader-relative and system dependencies", () => {
    expect(
      parseOtoolDependencies(`addon.node:\n\t@rpath/libonnxruntime.1.21.0.dylib (compatibility version 0.0.0)\n\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0)\n`),
    ).toEqual(["@rpath/libonnxruntime.1.21.0.dylib", "/usr/lib/libc++.1.dylib"]);
  });

  test("separates resolved and missing ELF dependencies", () => {
    const output = `\tlibonnxruntime.so.1 => /pack/runtime/onnx/libonnxruntime.so.1 (0x1)\n\tlibmissing.so => not found\n`;
    expect(parseLddResolved(output)).toEqual([
      {
        name: "libonnxruntime.so.1",
        path: "/pack/runtime/onnx/libonnxruntime.so.1",
      },
    ]);
    expect(parseLddMissing(output)).toEqual(["libmissing.so"]);
  });

  test("parses Windows DLL dependency names", () => {
    expect(
      parseDumpbinDependencies(`Image has the following dependencies:\r\n\r\n    onnxruntime.dll\r\n    VCRUNTIME140_1.dll\r\n`),
    ).toEqual(["onnxruntime.dll", "VCRUNTIME140_1.dll"]);
  });
});
