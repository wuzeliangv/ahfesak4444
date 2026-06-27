/**
 * Static AWS region catalog used for UI labels.
 *
 * The backend fetches the actual opted-in regions from EC2.DescribeRegions;
 * this list is purely cosmetic (flag emoji + Chinese label for each code).
 */

export interface RegionInfo {
  code: string;
  label: string;     // Chinese label used in the UI
  flag: string;      // emoji flag (fallback / non-Windows)
  country: string;   // ISO-3166 alpha-2 code, for the SVG flag
}

export const REGIONS: RegionInfo[] = [
  // North America
  { code: 'us-east-1',      label: '美国 弗吉尼亚北部',   flag: '🇺🇸', country: 'US' },
  { code: 'us-east-2',      label: '美国 俄亥俄',         flag: '🇺🇸', country: 'US' },
  { code: 'us-west-1',      label: '美国 加州北部',       flag: '🇺🇸', country: 'US' },
  { code: 'us-west-2',      label: '美国 俄勒冈',         flag: '🇺🇸', country: 'US' },
  { code: 'ca-central-1',   label: '加拿大 中部',         flag: '🇨🇦', country: 'CA' },
  { code: 'ca-west-1',      label: '加拿大 卡尔加里',     flag: '🇨🇦', country: 'CA' },
  { code: 'mx-central-1',   label: '墨西哥 中部',         flag: '🇲🇽', country: 'MX' },
  // South America
  { code: 'sa-east-1',      label: '巴西 圣保罗',         flag: '🇧🇷', country: 'BR' },
  // Europe
  { code: 'eu-west-1',      label: '爱尔兰 都柏林',       flag: '🇮🇪', country: 'IE' },
  { code: 'eu-west-2',      label: '英国 伦敦',           flag: '🇬🇧', country: 'GB' },
  { code: 'eu-west-3',      label: '法国 巴黎',           flag: '🇫🇷', country: 'FR' },
  { code: 'eu-central-1',   label: '德国 法兰克福',       flag: '🇩🇪', country: 'DE' },
  { code: 'eu-central-2',   label: '瑞士 苏黎世',         flag: '🇨🇭', country: 'CH' },
  { code: 'eu-north-1',     label: '瑞典 斯德哥尔摩',     flag: '🇸🇪', country: 'SE' },
  { code: 'eu-south-1',     label: '意大利 米兰',         flag: '🇮🇹', country: 'IT' },
  { code: 'eu-south-2',     label: '西班牙 萨拉戈萨',     flag: '🇪🇸', country: 'ES' },
  // Asia Pacific
  { code: 'ap-east-1',      label: '中国香港',           flag: '🇭🇰', country: 'HK' },
  { code: 'ap-east-2',      label: '中国台北',           flag: '🇨🇳', country: 'CN' },
  { code: 'ap-southeast-1', label: '新加坡',             flag: '🇸🇬', country: 'SG' },
  { code: 'ap-southeast-2', label: '澳大利亚 悉尼',       flag: '🇦🇺', country: 'AU' },
  { code: 'ap-southeast-3', label: '印尼 雅加达',         flag: '🇮🇩', country: 'ID' },
  { code: 'ap-southeast-4', label: '澳大利亚 墨尔本',     flag: '🇦🇺', country: 'AU' },
  { code: 'ap-southeast-5', label: '马来西亚 吉隆坡',     flag: '🇲🇾', country: 'MY' },
  { code: 'ap-southeast-6', label: '新西兰 奥克兰',       flag: '🇳🇿', country: 'NZ' },
  { code: 'ap-southeast-7', label: '泰国 曼谷',           flag: '🇹🇭', country: 'TH' },
  { code: 'ap-northeast-1', label: '日本 东京',           flag: '🇯🇵', country: 'JP' },
  { code: 'ap-northeast-2', label: '韩国 首尔',           flag: '🇰🇷', country: 'KR' },
  { code: 'ap-northeast-3', label: '日本 大阪',           flag: '🇯🇵', country: 'JP' },
  { code: 'ap-south-1',     label: '印度 孟买',           flag: '🇮🇳', country: 'IN' },
  { code: 'ap-south-2',     label: '印度 海得拉巴',       flag: '🇮🇳', country: 'IN' },
  // Middle East & Africa
  { code: 'me-south-1',     label: '巴林',               flag: '🇧🇭', country: 'BH' },
  { code: 'me-central-1',   label: '阿联酋',             flag: '🇦🇪', country: 'AE' },
  { code: 'il-central-1',   label: '以色列 特拉维夫',     flag: '🇮🇱', country: 'IL' },
  { code: 'af-south-1',     label: '南非 开普敦',         flag: '🇿🇦', country: 'ZA' },
];

const REGION_INDEX = new Map(REGIONS.map((r) => [r.code, r]));

export function regionInfo(code: string): RegionInfo {
  return REGION_INDEX.get(code) ?? { code, label: code, flag: '🌐', country: '' };
}

/**
 * Human-readable region label: "中文地名 (区域代码)", e.g.
 * "日本 东京 (ap-northeast-1)". Unknown codes degrade to
 * "未知地区 (xx-xxxx-1)" so rendering never breaks.
 */
export function regionDisplay(code: string): string {
  const info = REGION_INDEX.get(code);
  return info ? `${info.label} (${code})` : `未知地区 (${code})`;
}

/**
 * Extract the AZ letter suffix (uppercase) from a full AZ code.
 *   azSuffix('ap-northeast-1a') → 'A'
 *   azSuffix(null)              → ''
 */
export function azSuffix(az?: string | null): string {
  if (!az) return '';
  const m = az.match(/[a-z]$/i);
  return m ? m[0].toUpperCase() : '';
}

/**
 * Human-readable AZ label: "中文地名 A (ap-northeast-1a)".
 * Falls back gracefully when the region is unknown.
 */
export function azDisplay(az?: string | null): string {
  if (!az) return '';
  const region = az.replace(/[a-z]$/i, '');
  const info = REGION_INDEX.get(region);
  const suffix = azSuffix(az);
  if (!info) return `未知地区 ${suffix} (${az})`;
  return `${info.label} ${suffix} (${az})`;
}

/**
 * Turn an ISO-3166 two-letter country code into its flag emoji by mapping
 * each letter to its Regional Indicator Symbol (e.g. "JP" → 🇯🇵).
 */
export function countryFlag(code?: string | null): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '🏳️';
  const cc = code.toUpperCase();
  const base = 0x1f1e6; // 🇦
  return String.fromCodePoint(
    base + (cc.charCodeAt(0) - 65),
    base + (cc.charCodeAt(1) - 65),
  );
}

/** Localized country name for a code, e.g. "JP" → "日本". Falls back to the code. */
export function countryName(code?: string | null): string | null {
  if (!code) return null;
  try {
    return (
      new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code.toUpperCase()) ??
      code.toUpperCase()
    );
  } catch {
    return code.toUpperCase();
  }
}
