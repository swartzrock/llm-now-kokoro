import {
  MAX_REQUEST_BYTES,
  MAX_TEXT_SCALARS,
} from "./limits";
import { protocolFailure } from "./result";
import {
  DEFAULT_VOICE,
  SUPPORTED_VOICES,
  isSupportedVoice,
  type SupportedVoiceName,
} from "./voices";

export { MAX_REQUEST_BYTES, MAX_TEXT_SCALARS } from "./limits";

export const HELPER_VERSION = "0.1.0";
export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_CAPABILITIES = Object.freeze([
  "stdin-json-v1",
  "silent-self-test",
  "native-onnx-cpu",
  "local-q8",
  "voice-af-heart",
  "selectable-voices",
  "multilingual-voices",
  "speed-1.0",
  "bundled-player-stdin",
] as const);

export type ProtocolCapability = (typeof PROTOCOL_CAPABILITIES)[number];
export type HelperOperation = "info" | "self-test" | "speak";

export interface HelperCommand {
  operation: HelperOperation;
}

export interface SpeakRequest {
  text: string;
  voice: SupportedVoiceName;
}

const OPERATIONS = new Set<HelperOperation>(["info", "self-test", "speak"]);
const CAPABILITIES = new Set<string>(PROTOCOL_CAPABILITIES);

export function parseHelperArguments(arguments_: string[]): HelperCommand {
  const operation = arguments_[0];
  if (
    !isOperation(operation) ||
    arguments_[1] !== "--protocol-major" ||
    arguments_[2] === undefined
  ) {
    throw protocolFailure("protocol-usage");
  }

  if (!/^(0|[1-9]\d*)$/.test(arguments_[2])) {
    throw protocolFailure("protocol-usage");
  }
  if (Number(arguments_[2]) !== PROTOCOL_MAJOR) {
    throw protocolFailure("protocol-major-mismatch");
  }

  const seen = new Set<string>();
  for (let index = 3; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const capability = arguments_[index + 1];
    if (flag !== "--require-capability" || capability === undefined) {
      throw protocolFailure("protocol-usage");
    }
    if (!CAPABILITIES.has(capability)) {
      throw protocolFailure("unsupported-capability");
    }
    if (seen.has(capability)) {
      throw protocolFailure("protocol-usage");
    }
    seen.add(capability);
  }

  return { operation };
}

export function decodeSpeakRequest(bytes: Uint8Array): SpeakRequest {
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw protocolFailure("request-too-large");
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw protocolFailure("invalid-utf8");
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw protocolFailure("malformed-request");
  }

  if (!isExactSpeakObject(value)) {
    throw protocolFailure("invalid-request");
  }
  if (value.voice !== undefined && !isSupportedVoice(value.voice)) {
    throw protocolFailure("unsupported-voice");
  }
  if (value.text.includes("\0")) {
    throw protocolFailure("nul-text");
  }
  if (value.text.trim().length === 0) {
    throw protocolFailure("blank-text");
  }
  if (!hasOnlyUnicodeScalars(value.text)) {
    throw protocolFailure("invalid-unicode-scalar");
  }
  if (Array.from(value.text).length > MAX_TEXT_SCALARS) {
    throw protocolFailure("text-too-long");
  }

  return { text: value.text, voice: value.voice ?? DEFAULT_VOICE };
}

export function encodeInfoResponse(): string {
  return `${JSON.stringify({
    helperVersion: HELPER_VERSION,
    protocolMajor: PROTOCOL_MAJOR,
    capabilities: PROTOCOL_CAPABILITIES,
    engine: {
      inference: "onnxruntime-node-cpu",
      model: "q8",
      voice: DEFAULT_VOICE,
      voices: SUPPORTED_VOICES,
      speed: 1,
    },
  })}\n`;
}

function isOperation(value: string | undefined): value is HelperOperation {
  return value !== undefined && OPERATIONS.has(value as HelperOperation);
}

function isExactSpeakObject(
  value: unknown,
): value is { text: string; voice?: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    (keys.join(",") === "text" || keys.join(",") === "text,voice") &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0xd800 || codeUnit > 0xdfff) {
      continue;
    }
    if (codeUnit > 0xdbff) {
      return false;
    }
    if (index + 1 >= value.length) {
      return false;
    }
    const trailing = value.charCodeAt(index + 1);
    if (trailing < 0xdc00 || trailing > 0xdfff) {
      return false;
    }
    index += 1;
  }
  return true;
}
