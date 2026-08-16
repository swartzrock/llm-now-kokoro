# Third-party notices and Phase 1 audit

This inventory records components that are used by the source tree or are
expected in the optional speech pack. It is not a declaration that binary
redistribution has been cleared. Release is blocked until every shipped byte
maps to a reviewed license, attribution, and corresponding-source or relink
obligation.

| Component | Pin / identity | Declared license | Phase 1 disposition |
| --- | --- | --- | --- |
| Bun | 1.3.14 | MIT plus licenses for bundled components | Build/runtime notice and JavaScriptCore obligations require final payload review. |
| Transformers.js | 3.5.1 | Apache-2.0 | Exact source pin; ship its notice if included. |
| Kokoro.js | 1.2.1, upstream commit `664c76a704021239ba59c84dcbaa4d3dece01fe9` | Apache-2.0 | Exact source pin and local patch must be included in corresponding source. |
| ONNX Runtime | 1.21.0 | MIT | CPU native files only. Per-target DLL/dylib/SO inventory is a later release gate. |
| Kokoro q8 model and `af_heart` | revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` | Apache-2.0 model card | Model/training-data attribution review remains open. |
| phonemizer | 1.2.1, upstream commit `6835144b7ee9043129222549c1ed2f6a27216278` | npm metadata says Apache-2.0 | Bundle contains eSpeak-derived compiled code/data; the metadata is not sufficient for release. See below. |
| eSpeak NG material in phonemizer | actual packaged payload described below | GPL-3.0-or-later | Establishes the repository's GPL-3.0-or-later posture. Exact provenance, preferred source, build scripts, and relink path remain release blockers. |
| miniaudio architecture spike | commit `350784a9467a79d0fa65802132668e5afbcf3777` | public domain or MIT-0 | Final player source and license must ship together; the spike header SHA-256 is `9019743287e443c55e5737a7297f38e5e358561701d6db2d905afb114390c410`. |
| Microsoft Visual C++ runtime | exact files not yet approved | Microsoft redistributable terms | Clean-host need and redistribution rights remain a Windows release blocker. |

## Phonemizer/eSpeak payload audit

The installed `phonemizer@1.2.1` artifact was inspected rather than relying on
its package metadata:

- `node_modules/phonemizer/dist/phonemizer.js`: 1,322,380 bytes, SHA-256
  `193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec`.
- Largest embedded gzip data literal after base64 decoding: 452,273 bytes,
  SHA-256
  `4b4454422468c6195d70a3f50eaed157293d6a7af3e509a0612c2abcdb7defa5`.
- That literal after gzip decompression: 890,802 bytes, SHA-256
  `6262621f3f8267fb61ef41fe7af75b8fe7e2315d6c9092afd29d7629bb21a60b`.

The bundle definitely carries eSpeak-derived compiled JavaScript/data. No raw WebAssembly module was identified: the installed bundle has no `WebAssembly`
token, `AGFzbQ` base64 prefix, or decompressed `\0asm` magic. This conflicts
with the plan's description of a pinned eSpeak phonemizer WASM resource and
must be resolved against upstream source before release. The actual bundle and
data hashes above are the Phase 1 inventory; they do not resolve GPL source,
relink, attribution, or license-notice obligations.

## Model asset identities

- q8 ONNX: 92,361,116 bytes, SHA-256
  `fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478`.
- `af_heart.bin`: 522,240 bytes, SHA-256
  `d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b`.

These hashes identify the fixed Phase 1 inputs. They are not a substitute for
the immutable release manifest, source offer, or license review required in a
later phase.
