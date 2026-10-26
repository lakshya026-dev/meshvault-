import { ProtocolVersionMismatchError } from './../errors.js';
export const CURRENT_PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;
export type ProtocolVersion = typeof CURRENT_PROTOCOL_VERSION;

export interface ProtocolCapabilities {
  currentVersion: number;
  supportedVersions: number[];
}

export function validateProtocolCapabilities(
  value: unknown
): asserts value is ProtocolCapabilities {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid protocol capabilities: must be an object.');
  }
  const { currentVersion, supportedVersions } = value as Record<string, unknown>;
  if (
    typeof currentVersion !== 'number' ||
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 1
  ) {
    throw new Error('Invalid protocol capabilities: currentVersion must be a positive integer.');
  }
  if (
    !Array.isArray(supportedVersions) ||
    supportedVersions.length === 0 ||
    !supportedVersions.every(
      (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    )
  ) {
    throw new Error(
      'Invalid protocol capabilities: supportedVersions must be a non-empty array of positive integers.'
    );
  }
}

// Compute highest common protocol version without mutating inputs
export function commonProtocolVersions(
  local: ProtocolCapabilities,
  remote: ProtocolCapabilities
): number {
  validateProtocolCapabilities(local);
  validateProtocolCapabilities(remote);

  const common = local.supportedVersions.filter((v) =>
    remote.supportedVersions.includes(v)
  );
  if (common.length === 0) {
    throw new ProtocolVersionMismatchError(
      [...local.supportedVersions],
      [...remote.supportedVersions]
    );
  }

  return Math.max(...common);
}



