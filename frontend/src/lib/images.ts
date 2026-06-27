/**
 * Frontend image catalog — mirror of `backend/src/services/images.py`.
 *
 * Slugs MUST stay in sync with the backend. The backend authoritatively
 * validates the slug; the frontend uses this catalog to render the dropdown
 * and decide which images are available for the chosen architecture.
 *
 * Each entry exposes:
 *   - slug    : opaque ID sent to the backend
 *   - display : Chinese label shown in the dropdown
 *   - archs   : architectures the publisher provides AMIs for
 *   - os      : 'linux' | 'windows' — drives UI hints (e.g. RDP vs SSH)
 *   - user    : default OS user (informational; password applies to this user)
 */

export type Arch = 'x86_64' | 'arm64';
export type OsType = 'linux' | 'windows';

export interface ImageOption {
  slug: string;
  display: string;
  archs: readonly Arch[];
  os: OsType;
  user: string;
}

export const IMAGES: readonly ImageOption[] = [
  // Amazon Linux 2023
  { slug: 'al2023',       display: 'Amazon Linux 2023',                                   archs: ['x86_64', 'arm64'], os: 'linux',   user: 'ec2-user' },

  // Ubuntu LTS
  { slug: 'ubuntu-20.04', display: 'Ubuntu 20.04 LTS',                                    archs: ['x86_64', 'arm64'], os: 'linux',   user: 'ubuntu' },
  { slug: 'ubuntu-22.04', display: 'Ubuntu 22.04 LTS',                                    archs: ['x86_64', 'arm64'], os: 'linux',   user: 'ubuntu' },
  { slug: 'ubuntu-24.04', display: 'Ubuntu 24.04 LTS',                                    archs: ['x86_64', 'arm64'], os: 'linux',   user: 'ubuntu' },

  // Debian
  { slug: 'debian-10',    display: 'Debian 10 (Buster)',                                  archs: ['x86_64', 'arm64'], os: 'linux',   user: 'admin' },
  { slug: 'debian-11',    display: 'Debian 11 (Bullseye)',                                archs: ['x86_64', 'arm64'], os: 'linux',   user: 'admin' },
  { slug: 'debian-12',    display: 'Debian 12 (Bookworm)',                                archs: ['x86_64', 'arm64'], os: 'linux',   user: 'admin' },
  { slug: 'debian-13',    display: 'Debian 13 (Trixie)',                                  archs: ['x86_64', 'arm64'], os: 'linux',   user: 'admin' },

  // Windows Server (x86_64 only)
  { slug: 'win-2022-en',  display: 'Windows Server 2022 (English, Full Base)',            archs: ['x86_64'],          os: 'windows', user: 'Administrator' },
  { slug: 'win-2022-zh',  display: 'Windows Server 2022 (中文简体, Full Base)',           archs: ['x86_64'],          os: 'windows', user: 'Administrator' },
  { slug: 'win-2025-en',  display: 'Windows Server 2025 (English, Full Base)',            archs: ['x86_64'],          os: 'windows', user: 'Administrator' },
];

const INDEX = new Map(IMAGES.map((i) => [i.slug, i]));

export function imageInfo(slug: string): ImageOption | undefined {
  return INDEX.get(slug);
}

/** Filter the catalog to images that ship for the given CPU architecture. */
export function imagesForArch(arch: Arch): ImageOption[] {
  return IMAGES.filter((i) => i.archs.includes(arch));
}
