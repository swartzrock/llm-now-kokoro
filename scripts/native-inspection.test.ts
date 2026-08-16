import { describe, expect, test } from "bun:test";

import {
  assessLinuxFloor,
  assessWindowsFloor,
  classifyUndeclaredLinuxDependencies,
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
    const output = `\tlibonnxruntime.so.1 => /installed pack ユニコード/runtime/onnx/libonnxruntime.so.1 (0x1)\n\t/lib64/ld-linux-x86-64.so.2 (0x2)\n\tlibmissing.so => not found\n`;
    expect(parseLddResolved(output)).toEqual([
      {
        name: "libonnxruntime.so.1",
        path: "/installed pack ユニコード/runtime/onnx/libonnxruntime.so.1",
      },
      {
        name: "ld-linux-x86-64.so.2",
        path: "/lib64/ld-linux-x86-64.so.2",
      },
    ]);
    expect(parseLddMissing(output)).toEqual(["libmissing.so"]);
  });

  test("allows only reviewed system libraries and sidecars at declared package paths", () => {
    const dependencies = [
      { name: "libc.so.6", path: "/lib/x86_64-linux-gnu/libc.so.6" },
      {
        name: "libonnxruntime.so.1",
        path: "/pack/runtime/onnx/libonnxruntime.so.1",
      },
      { name: "libcurl.so.4", path: "/usr/lib/libcurl.so.4" },
      { name: "libc.so.6", path: "/tmp/libc.so.6" },
      { name: "libonnxruntime.so.1", path: "/usr/lib/libonnxruntime.so.1" },
    ];
    expect(
      classifyUndeclaredLinuxDependencies(
        dependencies,
        new Map([
          [
            "libonnxruntime.so.1",
            "/pack/runtime/onnx/libonnxruntime.so.1",
          ],
        ]),
      ),
    ).toEqual([
      "libcurl.so.4 => /usr/lib/libcurl.so.4",
      "libc.so.6 => /tmp/libc.so.6",
      "libonnxruntime.so.1 => /usr/lib/libonnxruntime.so.1",
    ]);
  });

  test("parses Windows DLL dependency names", () => {
    expect(
      parseDumpbinDependencies(`Image has the following dependencies:\r\n\r\n    onnxruntime.dll\r\n    VCRUNTIME140_1.dll\r\n`),
    ).toEqual(["onnxruntime.dll", "VCRUNTIME140_1.dll"]);
  });

  test("does not use a newer Linux runner kernel as minimum-host evidence", () => {
    expect(assessLinuxFloor("linux-x64", "2.27", "6.8", false)).toEqual({
      details: [
        "maximum-glibc=2.27",
        "glibc-floor=2.27;symbol-compatible=true",
        "runner-kernel=6.8;minimum-host-kernel=5.1;minimum-host-execution=unverified",
      ],
      verified: false,
    });
  });

  test("does not infer Windows build 17763 support from PE subsystem 10.0", () => {
    expect(assessWindowsFloor(["10.0"], true, false)).toEqual({
      details: [
        "pe-subsystem-compatible=true",
        "minimum-windows-build=10.0.17763;minimum-host-execution=unverified",
      ],
      verified: false,
    });
  });
});
