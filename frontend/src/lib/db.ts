/**
 * Shared account/group types.
 *
 * Accounts now live server-side (DEK-encrypted in the daemon); the browser no
 * longer stores credentials. This file is types-only — the legacy IndexedDB
 * vault was removed once the server-side migration completed.
 */

/**
 * Cached, non-sensitive metadata from sts.get_caller_identity.
 */
export interface VerifiedMeta {
  accountId: string;
  arn: string;
  iamAlias: string | null;
  isRoot: boolean;
  akPrefix: string;
  /** ISO-3166 two-letter country code of the registered contact address. */
  countryCode?: string | null;
  /** Account creation time (ISO 8601). */
  accountCreatedAt?: string | null;
  verifiedAt: number;
}

/** Cached vCPU quota — non-sensitive, refreshed on demand by the UI. */
export interface QuotaCache {
  usEast1?: number;
  totalAcrossRegions?: number;
  fetchedAt?: number;
}

/** A managed AWS account (metadata; credentials are fetched from the daemon). */
export interface AccountRecord {
  id: string;
  alias: string;
  group?: string | null;
  note?: string | null;
  defaultRegion: string;
  color?: string | null;
  verified?: VerifiedMeta | null;
  quota?: QuotaCache | null;
  /** Egress-node binding (region) — pins this account's requests to a node. */
  pinnedRegion?: string | null;
  /** Periodic vCPU-quota monitoring (default-region) with TG alerts on change. */
  monitorVcpu?: boolean;
  vcpuValue?: number | null;
  vcpuCheckedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** A deployer (host) account used to host worker Lambdas. */
export interface DeployerAccountRecord {
  id: string;
  alias: string;
  defaultRegion: string;
  note?: string | null;
  verified?: VerifiedMeta | null;
  createdAt: number;
  updatedAt: number;
}

/** A named grouping for account cards. */
export interface GroupRecord {
  name: string;
  createdAt: number;
}
