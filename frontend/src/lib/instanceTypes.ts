/**
 * Static lookup table: EC2 instance type → vCPUs / memory / network spec.
 *
 * Covers the families most commonly used for personal accounts (t / m / c / r,
 * across Intel x86_64 and Graviton ARM64). Unknown types degrade gracefully
 * to showing just the type code.
 *
 * Source values match the public EC2 instance spec sheet
 * (https://aws.amazon.com/ec2/instance-types/). Network is the "up to" rated
 * burst on smaller sizes — sufficient for a UI label.
 *
 * Memory unit is GiB but we label it as "GB" because that's what the AWS
 * console shows in customer-facing places, and the user asked for the format
 * "t3.micro (2 vCPUs, 1.02 GB 内存, 625 MB 带宽)".
 */

export interface InstanceTypeSpec {
  vcpus: number;
  /** Memory in GiB. */
  memoryGiB: number;
  /** Network bandwidth, free-form label (e.g. "625 MB", "5 Gbps"). */
  network: string;
}

// prettier-ignore
const SPECS: Record<string, InstanceTypeSpec> = {
  // ---- T2 (Intel x86_64, burstable) ----------------------------------------
  't2.nano':      { vcpus: 1,  memoryGiB: 0.5,  network: '低' },
  't2.micro':     { vcpus: 1,  memoryGiB: 1,    network: '低到中' },
  't2.small':     { vcpus: 1,  memoryGiB: 2,    network: '低到中' },
  't2.medium':    { vcpus: 2,  memoryGiB: 4,    network: '低到中' },
  't2.large':     { vcpus: 2,  memoryGiB: 8,    network: '低到中' },
  't2.xlarge':    { vcpus: 4,  memoryGiB: 16,   network: '中' },
  't2.2xlarge':   { vcpus: 8,  memoryGiB: 32,   network: '中' },

  // ---- T3 (Intel x86_64, burstable) ----------------------------------------
  't3.nano':      { vcpus: 2,  memoryGiB: 0.5,  network: '5 Gbps' },
  't3.micro':     { vcpus: 2,  memoryGiB: 1,    network: '5 Gbps' },
  't3.small':     { vcpus: 2,  memoryGiB: 2,    network: '5 Gbps' },
  't3.medium':    { vcpus: 2,  memoryGiB: 4,    network: '5 Gbps' },
  't3.large':     { vcpus: 2,  memoryGiB: 8,    network: '5 Gbps' },
  't3.xlarge':    { vcpus: 4,  memoryGiB: 16,   network: '5 Gbps' },
  't3.2xlarge':   { vcpus: 8,  memoryGiB: 32,   network: '5 Gbps' },

  // ---- T3a (AMD x86_64, burstable) -----------------------------------------
  't3a.nano':     { vcpus: 2,  memoryGiB: 0.5,  network: '5 Gbps' },
  't3a.micro':    { vcpus: 2,  memoryGiB: 1,    network: '5 Gbps' },
  't3a.small':    { vcpus: 2,  memoryGiB: 2,    network: '5 Gbps' },
  't3a.medium':   { vcpus: 2,  memoryGiB: 4,    network: '5 Gbps' },
  't3a.large':    { vcpus: 2,  memoryGiB: 8,    network: '5 Gbps' },
  't3a.xlarge':   { vcpus: 4,  memoryGiB: 16,   network: '5 Gbps' },
  't3a.2xlarge':  { vcpus: 8,  memoryGiB: 32,   network: '5 Gbps' },

  // ---- T4g (Graviton ARM64, burstable) -------------------------------------
  't4g.nano':     { vcpus: 2,  memoryGiB: 0.5,  network: '5 Gbps' },
  't4g.micro':    { vcpus: 2,  memoryGiB: 1,    network: '5 Gbps' },
  't4g.small':    { vcpus: 2,  memoryGiB: 2,    network: '5 Gbps' },
  't4g.medium':   { vcpus: 2,  memoryGiB: 4,    network: '5 Gbps' },
  't4g.large':    { vcpus: 2,  memoryGiB: 8,    network: '5 Gbps' },
  't4g.xlarge':   { vcpus: 4,  memoryGiB: 16,   network: '5 Gbps' },
  't4g.2xlarge':  { vcpus: 8,  memoryGiB: 32,   network: '5 Gbps' },

  // ---- M5 (Intel x86_64, general-purpose) ----------------------------------
  'm5.large':     { vcpus: 2,  memoryGiB: 8,    network: '10 Gbps' },
  'm5.xlarge':    { vcpus: 4,  memoryGiB: 16,   network: '10 Gbps' },
  'm5.2xlarge':   { vcpus: 8,  memoryGiB: 32,   network: '10 Gbps' },
  'm5.4xlarge':   { vcpus: 16, memoryGiB: 64,   network: '10 Gbps' },
  'm5.8xlarge':   { vcpus: 32, memoryGiB: 128,  network: '10 Gbps' },
  'm5.12xlarge':  { vcpus: 48, memoryGiB: 192,  network: '12 Gbps' },

  // ---- M6i (Intel Ice Lake) ------------------------------------------------
  'm6i.large':    { vcpus: 2,  memoryGiB: 8,    network: '12.5 Gbps' },
  'm6i.xlarge':   { vcpus: 4,  memoryGiB: 16,   network: '12.5 Gbps' },
  'm6i.2xlarge':  { vcpus: 8,  memoryGiB: 32,   network: '12.5 Gbps' },
  'm6i.4xlarge':  { vcpus: 16, memoryGiB: 64,   network: '12.5 Gbps' },
  'm6i.8xlarge':  { vcpus: 32, memoryGiB: 128,  network: '12.5 Gbps' },

  // ---- M6g (Graviton2 ARM64) -----------------------------------------------
  'm6g.medium':   { vcpus: 1,  memoryGiB: 4,    network: '10 Gbps' },
  'm6g.large':    { vcpus: 2,  memoryGiB: 8,    network: '10 Gbps' },
  'm6g.xlarge':   { vcpus: 4,  memoryGiB: 16,   network: '10 Gbps' },
  'm6g.2xlarge':  { vcpus: 8,  memoryGiB: 32,   network: '10 Gbps' },
  'm6g.4xlarge':  { vcpus: 16, memoryGiB: 64,   network: '10 Gbps' },

  // ---- M7g (Graviton3 ARM64) -----------------------------------------------
  'm7g.medium':   { vcpus: 1,  memoryGiB: 4,    network: '12.5 Gbps' },
  'm7g.large':    { vcpus: 2,  memoryGiB: 8,    network: '12.5 Gbps' },
  'm7g.xlarge':   { vcpus: 4,  memoryGiB: 16,   network: '12.5 Gbps' },
  'm7g.2xlarge':  { vcpus: 8,  memoryGiB: 32,   network: '15 Gbps' },

  // ---- C5 (Intel x86_64, compute-optimized) --------------------------------
  'c5.large':     { vcpus: 2,  memoryGiB: 4,    network: '10 Gbps' },
  'c5.xlarge':    { vcpus: 4,  memoryGiB: 8,    network: '10 Gbps' },
  'c5.2xlarge':   { vcpus: 8,  memoryGiB: 16,   network: '10 Gbps' },
  'c5.4xlarge':   { vcpus: 16, memoryGiB: 32,   network: '10 Gbps' },
  'c5.9xlarge':   { vcpus: 36, memoryGiB: 72,   network: '12 Gbps' },

  // ---- C6i (Intel Ice Lake) ------------------------------------------------
  'c6i.large':    { vcpus: 2,  memoryGiB: 4,    network: '12.5 Gbps' },
  'c6i.xlarge':   { vcpus: 4,  memoryGiB: 8,    network: '12.5 Gbps' },
  'c6i.2xlarge':  { vcpus: 8,  memoryGiB: 16,   network: '12.5 Gbps' },
  'c6i.4xlarge':  { vcpus: 16, memoryGiB: 32,   network: '12.5 Gbps' },

  // ---- C7g (Graviton3 ARM64) -----------------------------------------------
  'c7g.medium':   { vcpus: 1,  memoryGiB: 2,    network: '12.5 Gbps' },
  'c7g.large':    { vcpus: 2,  memoryGiB: 4,    network: '12.5 Gbps' },
  'c7g.xlarge':   { vcpus: 4,  memoryGiB: 8,    network: '12.5 Gbps' },
  'c7g.2xlarge':  { vcpus: 8,  memoryGiB: 16,   network: '15 Gbps' },

  // ---- R5 (Intel x86_64, memory-optimized) ---------------------------------
  'r5.large':     { vcpus: 2,  memoryGiB: 16,   network: '10 Gbps' },
  'r5.xlarge':    { vcpus: 4,  memoryGiB: 32,   network: '10 Gbps' },
  'r5.2xlarge':   { vcpus: 8,  memoryGiB: 64,   network: '10 Gbps' },
  'r5.4xlarge':   { vcpus: 16, memoryGiB: 128,  network: '10 Gbps' },

  // ---- R6i (Intel Ice Lake) ------------------------------------------------
  'r6i.large':    { vcpus: 2,  memoryGiB: 16,   network: '12.5 Gbps' },
  'r6i.xlarge':   { vcpus: 4,  memoryGiB: 32,   network: '12.5 Gbps' },
  'r6i.2xlarge':  { vcpus: 8,  memoryGiB: 64,   network: '12.5 Gbps' },
  'r6i.4xlarge':  { vcpus: 16, memoryGiB: 128,  network: '12.5 Gbps' },

  // ---- R7g (Graviton3 ARM64) -----------------------------------------------
  'r7g.medium':   { vcpus: 1,  memoryGiB: 8,    network: '12.5 Gbps' },
  'r7g.large':    { vcpus: 2,  memoryGiB: 16,   network: '12.5 Gbps' },
  'r7g.xlarge':   { vcpus: 4,  memoryGiB: 32,   network: '12.5 Gbps' },
  'r7g.2xlarge':  { vcpus: 8,  memoryGiB: 64,   network: '15 Gbps' },
};

export function instanceTypeSpec(type: string | null | undefined): InstanceTypeSpec | null {
  if (!type) return null;
  return SPECS[type] ?? null;
}

/**
 * Families that run on AWS Graviton (ARM64). Everything else is x86_64.
 * Hard-coded from the table above to avoid heuristic mistakes on edge cases
 * like `g4dn` (GPU, x86_64) where `g` is a marketing letter, not Graviton.
 */
const ARM64_FAMILIES = new Set(['t4g', 'm6g', 'm7g', 'c7g', 'r7g']);

export function instanceArch(type: string): 'arm64' | 'x86_64' {
  const family = type.split('.')[0];
  return ARM64_FAMILIES.has(family) ? 'arm64' : 'x86_64';
}

/** All known instance types sorted by family, then by "size weight". */
export const INSTANCE_TYPES: readonly string[] = Object.freeze(
  Object.keys(SPECS).sort((a, b) => {
    const [fa, sa] = a.split('.');
    const [fb, sb] = b.split('.');
    if (fa !== fb) return fa.localeCompare(fb);
    return sizeWeight(sa) - sizeWeight(sb);
  }),
);

/** Sort order for size labels (nano < micro < small < … < 24xlarge). */
function sizeWeight(size: string): number {
  const order = ['nano', 'micro', 'small', 'medium', 'large'];
  const idx = order.indexOf(size);
  if (idx >= 0) return idx;
  // xlarge, 2xlarge, 4xlarge, … — sort by the numeric prefix
  const m = size.match(/^(\d*)xlarge$/);
  if (!m) return 999;
  const n = m[1] ? Number(m[1]) : 1;
  return 100 + n;
}

/**
 * Format memory like AWS: integers stay integers, halves round to 2 decimals,
 * everything else rounds to 1 decimal. e.g. 0.5 → "0.5", 1 → "1", 1.02 → "1.02".
 */
function formatMemory(g: number): string {
  if (Number.isInteger(g)) return String(g);
  // Show 2 decimals only when the value is < 10 (small instances), otherwise 1.
  return g < 10 ? g.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : g.toFixed(1);
}

/**
 * UI-ready label: `t3.micro (2 vCPUs, 1 GB 内存, 5 Gbps 带宽)`.
 * Falls back to just the type when not in the table.
 */
export function instanceTypeDisplay(type: string | null | undefined): string {
  if (!type) return '';
  const spec = SPECS[type];
  if (!spec) return type;
  return `${type} (${spec.vcpus} vCPUs, ${formatMemory(spec.memoryGiB)} GB 内存, ${spec.network} 带宽)`;
}
