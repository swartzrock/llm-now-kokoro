import type { ReleaseManifest, ReleaseManifestFile } from "./release-manifest";

export const RELEASE_COMPLIANCE_BLOCKERS = Object.freeze([
  "phonemizer-espeak-source-relink-unresolved",
  "bun-jsc-redistribution-unresolved",
  "model-training-attribution-unresolved",
  "windows-app-local-runtime-unresolved",
] as const);

export interface ComplianceFileRecord {
  assetClass: ReleaseManifest["assetClass"] | "release-metadata";
  license: string | null;
  logicalDestination: string;
  obligations: string[];
  releaseFilename: string;
  sourceRevision: string | null;
  target: ReleaseManifest["target"];
}

export interface ComplianceReport {
  blockers: string[];
  files: ComplianceFileRecord[];
  formatVersion: 1;
  publicationEligible: boolean;
}

export interface AdditionalComplianceFile {
  assetClass: "release-metadata";
  license: string;
  logicalDestination: string;
  obligations: string[];
  releaseFilename: string;
  sourceRevision: string;
  target: null;
}

export function createComplianceReport(
  manifests: readonly ReleaseManifest[],
  blockers: readonly string[] = RELEASE_COMPLIANCE_BLOCKERS,
  additionalFiles: readonly AdditionalComplianceFile[] = [],
): ComplianceReport {
  const files: ComplianceFileRecord[] = manifests.flatMap((manifest) =>
    manifest.files.map((file) => complianceRecord(manifest, file)),
  );
  files.push(...additionalFiles.map((file) => ({
    ...file,
    obligations: [...file.obligations],
  })));
  files.sort((left, right) =>
    left.releaseFilename.localeCompare(right.releaseFilename, "en"),
  );
  return {
    blockers: [...blockers],
    files,
    formatVersion: 1,
    publicationEligible:
      blockers.length === 0 &&
      files.every((file) => file.license && file.sourceRevision),
  };
}

export function assertComplianceComplete(report: ComplianceReport): void {
  if (
    report.files.some(
      (file) =>
        !file.license || !file.sourceRevision || file.obligations.length === 0,
    )
  ) {
    throw new Error("release-file-compliance-unmapped");
  }
  if (report.blockers.length > 0 || !report.publicationEligible) {
    throw new Error(`release-compliance-blocked:${report.blockers.join(",")}`);
  }
}

function complianceRecord(
  manifest: ReleaseManifest,
  file: ReleaseManifestFile,
): ComplianceFileRecord {
  const provenance = file.provenance;
  return {
    assetClass: manifest.assetClass,
    license: provenance?.license ?? null,
    logicalDestination: file.logicalDestination,
    obligations: provenance?.obligations ? [...provenance.obligations] : [],
    releaseFilename: file.releaseFilename,
    sourceRevision: provenance?.sourceRevision ?? null,
    target: manifest.target,
  };
}
