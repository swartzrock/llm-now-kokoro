export function firstLine(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

export function errorMessage(error: unknown): string {
  return (
    firstLine(error instanceof Error ? error.message : String(error)) ||
    "unknown error"
  );
}
