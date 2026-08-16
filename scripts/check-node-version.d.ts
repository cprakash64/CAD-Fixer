/**
 * Types for `check-node-version.js`.
 *
 * The guard itself is plain JavaScript because it must run under whatever Node
 * the user has, before any build step — but its consumers are TypeScript, so
 * the contract is declared here rather than left implicit.
 */

export interface NodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export type VersionCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

export function parseVersion(text: string): NodeVersion | undefined;
export function parseMinimum(range: string): NodeVersion | undefined;
export function meetsMinimum(actual: NodeVersion, minimum: NodeVersion): boolean;
export function readEnginesRange(): string;
export function checkVersion(actualText: string, range: string): VersionCheck;
