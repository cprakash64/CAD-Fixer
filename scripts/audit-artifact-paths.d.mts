export interface PathAuditOptions {
  roots?: string[];
  username?: string;
}
export interface PathFinding {
  kind: string;
  encoding: string;
  offset: number;
}
export function scanArtifactPaths(bytes: Uint8Array, options?: PathAuditOptions): PathFinding[];
export function auditArtifactDirectory(
  directory: string,
  options?: PathAuditOptions,
): (PathFinding & { path: string })[];
