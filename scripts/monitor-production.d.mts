/**
 * Types for `monitor-production.mjs`.
 *
 * The monitor itself is plain JavaScript on purpose: it must run under bare
 * `node` in a CI job with no install step and no build, so that monitoring keeps
 * working when everything else is broken. This declaration gives the test suite
 * real types without compromising that, following the same pattern as
 * `check-node-version.d.ts`.
 */

export type MonitorState = 'PASS' | 'FAIL' | 'UNKNOWN_UNREACHABLE';

export interface MonitorCheck {
  /** Stable identifier, e.g. `M03`. */
  id: string;
  state: MonitorState;
  detail: string;
  /** Present only for a PASS that still deserves attention. */
  warning?: string;
}

export interface MonitorReport {
  result: MonitorState;
  target: string;
  checks: MonitorCheck[];
  warnings: string[];
  durationMs: number;
}

export interface MonitorOptions {
  url?: string;
  /** Also check the Geogram WASM. Off by default: it is ~1.2 MB. */
  deep?: boolean;
  /** Pause before the single transport retry. Shortened in tests. */
  retryDelayMs?: number;
}

/** A peer certificate as returned by Node's TLS socket. */
export interface PeerCertificateLike {
  valid_to?: string;
  valid_from?: string;
}

export declare const DEFAULT_MONITOR_URL: string;
export declare const DEFAULT_RETRY_DELAY_MS: number;
export declare const PASS: 'PASS';
export declare const FAIL: 'FAIL';
export declare const UNKNOWN: 'UNKNOWN_UNREACHABLE';
export declare const EXIT_CODE: Record<MonitorState, number>;
export declare const CERT_WARN_DAYS: number;
export declare const CERT_FAIL_DAYS: number;
export declare const REQUIRED_HEADERS: Record<string, string>;

export declare function evaluateCertificate(
  peerCertificate: PeerCertificateLike | undefined | null,
  now?: number,
): MonitorCheck;

export declare function evaluateHeaders(
  headers: Record<string, string | string[] | undefined>,
): MonitorCheck[];

export declare function combine(checks: readonly { state: MonitorState }[]): MonitorState;

export declare function findRuntimeAsset(html: string): string | undefined;

export declare function runMonitor(options?: MonitorOptions): Promise<MonitorReport>;
