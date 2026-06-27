/**
 * Lightsail static constants. Bundle and blueprint catalogs used to live
 * here but are now fetched live from the backend (`/lightsail/catalog`)
 * so price + SKU changes propagate without a redeploy.
 */

/**
 * Lightsail-supported regions (as of 2026). Includes opt-in regions
 * (Hong Kong, Jakarta, Kuala Lumpur, Spain, São Paulo) — we show them all
 * even if the account hasn't enabled them, per user spec. Create attempts
 * in unenabled opt-in regions return a clear error from AWS.
 */
export const LIGHTSAIL_REGIONS: ReadonlyArray<string> = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'ap-east-1',       // Hong Kong (opt-in)
  'ap-south-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',  // Jakarta (opt-in)
  'ap-southeast-5',  // Kuala Lumpur (opt-in)
  'ca-central-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-north-1',
  'eu-south-2',      // Spain (opt-in)
  'sa-east-1',       // São Paulo
];
