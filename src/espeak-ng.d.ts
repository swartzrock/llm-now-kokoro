declare module "espeak-ng" {
  interface ESpeakFileSystem {
    readFile(path: string, options: { encoding: "utf8" }): string;
  }

  interface ESpeakModule {
    FS: ESpeakFileSystem;
  }

  export default function createESpeak(options: {
    arguments: string[];
    wasmBinary: Uint8Array;
  }): Promise<ESpeakModule>;
}
