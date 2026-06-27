/**
 * Zone naming helpers for the region/zone tree.
 *
 * AWS returns zone codes (e.g. `us-west-2-lax-1a`, `us-west-2-wl1-nrt-wlz-1`)
 * but no friendly city name. The city is encoded as an IATA-style airport
 * code (`lax`, `nrt`). We map those to Chinese city names, infer the
 * Wavelength carrier from the region, and compose a label like the region
 * catalog does.
 *
 * Unknown airport codes fall back to the uppercased code (e.g. `XNA`).
 */

import { regionInfo, countryName, azDisplay } from './regions';

export type ZoneType = 'availability-zone' | 'local-zone' | 'wavelength-zone' | string;
export type ZoneOptIn = 'opted-in' | 'not-opted-in' | 'opt-in-not-required' | string;

export interface ZoneRow {
  zone_name: string;
  zone_id: string | null;
  zone_type: ZoneType;
  group_name: string | null;
  opt_in_status: ZoneOptIn;
  parent_zone_name: string | null;
  network_border_group?: string | null;
  state?: string | null;
}

/* IATA airport code → Chinese city name. Covers AWS Local + Wavelength
   zone cities. Missing codes fall back to the uppercased code. */
const CITY_CN: Record<string, string> = {
  // United States
  atl: '亚特兰大', bos: '波士顿', chi: '芝加哥', ord: '芝加哥',
  clt: '夏洛特', cmh: '哥伦布', dfw: '达拉斯', den: '丹佛',
  dtw: '底特律', hnl: '檀香山', iah: '休斯顿', ind: '印第安纳波利斯',
  mci: '堪萨斯城', las: '拉斯维加斯', lax: '洛杉矶', mia: '迈阿密',
  msp: '明尼阿波利斯', min: '明尼阿波利斯', bna: '纳什维尔', nsh: '纳什维尔',
  msy: '新奥尔良', nyc: '纽约', jfk: '纽约', oma: '奥马哈',
  phl: '费城', phx: '菲尼克斯', pdx: '波特兰', pit: '匹兹堡',
  slc: '盐湖城', sea: '西雅图', sfo: '旧金山', san: '圣地亚哥',
  tpa: '坦帕', was: '华盛顿', iad: '华盛顿', dca: '华盛顿',
  // Canada
  yyz: '多伦多', yul: '蒙特利尔',
  // Latin America
  qro: '克雷塔罗', eze: '布宜诺斯艾利斯', bue: '布宜诺斯艾利斯',
  lim: '利马', scl: '圣地亚哥', bog: '波哥大',
  // Europe
  lon: '伦敦', lhr: '伦敦', man: '曼彻斯特', ber: '柏林', dtm: '多特蒙德',
  ham: '汉堡', muc: '慕尼黑', hel: '赫尔辛基', waw: '华沙', cph: '哥本哈根',
  prg: '布拉格', vie: '维也纳', ath: '雅典', lis: '里斯本', bcn: '巴塞罗那',
  // Asia Pacific
  nrt: '东京', kix: '大阪', icn: '首尔', tpe: '台北',
  bkk: '曼谷', mnl: '马尼拉', akl: '奥克兰', per: '珀斯',
  del: '德里', ccu: '加尔各答', blr: '班加罗尔', maa: '金奈',
  han: '河内', sgn: '胡志明市',
  // Middle East & Africa
  mct: '马斯喀特', ruh: '利雅得', dkr: '达喀尔', los: '拉各斯',
};

/* Wavelength carrier by country (ISO-3166 alpha-2 of the parent region). */
const CARRIER_BY_COUNTRY: Record<string, string> = {
  US: 'Verizon',
  JP: 'KDDI',
  KR: 'SKT',
  CA: 'Bell',
  GB: 'Vodafone',
  DE: 'Vodafone',
  IE: 'Vodafone',
};

function cityCN(code: string): string {
  return CITY_CN[code.toLowerCase()] ?? code.toUpperCase();
}

/** Uppercase trailing AZ letter, e.g. 'us-west-2-lax-1a' → 'A'. */
function azLetter(zoneName: string): string {
  const m = zoneName.match(/[a-z]$/i);
  return m ? m[0].toUpperCase() : '';
}

/**
 * Extract the city airport code from a Local/Wavelength zone name.
 *   local:      us-west-2-lax-1a        → 'lax'
 *   wavelength: us-west-2-wl1-nrt-wlz-1 → 'nrt'
 */
function cityCode(zoneName: string, region: string): string | null {
  const wl = zoneName.match(/-wl\d+-([a-z]+)-wlz/i);
  if (wl) return wl[1];
  const rest = zoneName.startsWith(region) ? zoneName.slice(region.length + 1) : zoneName;
  const lz = rest.match(/^([a-z]+)-\d+[a-z]?$/i);
  if (lz) return lz[1];
  return null;
}

/** Short type tag shown after the code: '' | '(local)' | '(wavelength)'. */
export function zoneTypeTag(zoneType: ZoneType): string {
  if (zoneType === 'local-zone') return '(local)';
  if (zoneType === 'wavelength-zone') return '(wavelength)';
  return '';
}

/**
 * Friendly Chinese label for a zone (without the code/tag, which the UI
 * renders separately):
 *   AZ:         "日本 东京 A"
 *   Local:      "美国 洛杉矶 A"
 *   Wavelength: "日本 大阪 KDDI"
 */
export function zoneLabel(zone: ZoneRow, region: string): string {
  const info = regionInfo(region);
  const country = countryName(info.country) ?? info.label.split(' ')[0];

  if (zone.zone_type === 'availability-zone') {
    return `${info.label} ${azLetter(zone.zone_name)}`.trim();
  }

  const code = cityCode(zone.zone_name, region);
  const city = code ? cityCN(code) : zone.zone_name;

  if (zone.zone_type === 'wavelength-zone') {
    const carrier = CARRIER_BY_COUNTRY[info.country] ?? '';
    return `${country} ${city}${carrier ? ` ${carrier}` : ''}`.trim();
  }

  // local-zone — include the AZ letter so multi-zone cities (e.g. LAX a/b)
  // stay distinct.
  return `${country} ${city} ${azLetter(zone.zone_name)}`.trim();
}

/** Sort key so AZ → Local → Wavelength, then by name. */
export function zoneSortKey(zone: ZoneRow): string {
  const rank =
    zone.zone_type === 'availability-zone'
      ? '0'
      : zone.zone_type === 'local-zone'
        ? '1'
        : '2';
  return `${rank}:${zone.zone_name}`;
}

/**
 * Display label for an instance's AZ/zone code (`inst.az`). Handles all
 * three zone types so Wavelength/Local instances don't render as
 * "未知地区":
 *   standard AZ:  "日本 东京 A (ap-northeast-1a)"
 *   local:        "美国 洛杉矶 A (us-west-2-lax-1a) (local)"
 *   wavelength:   "美国 旧金山 Verizon (us-west-2-wl1-sfo-wlz-1) (wavelength)"
 */
export function azNameDisplay(
  zoneName: string | null | undefined,
  region: string,
): string {
  if (!zoneName) return '';
  const rest = zoneName.startsWith(region) ? zoneName.slice(region.length) : zoneName;
  // Standard AZ = region code + a single trailing letter (e.g. 'a').
  if (/^[a-z]$/i.test(rest)) return azDisplay(zoneName);

  const zt: ZoneType = zoneName.includes('wlz') ? 'wavelength-zone' : 'local-zone';
  const fake: ZoneRow = {
    zone_name: zoneName,
    zone_id: null,
    zone_type: zt,
    group_name: null,
    opt_in_status: 'opted-in',
    parent_zone_name: null,
  };
  const tag = zoneTypeTag(zt);
  return `${zoneLabel(fake, region)} (${zoneName})${tag ? ` ${tag}` : ''}`;
}
