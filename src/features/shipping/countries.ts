/**
 * The one country catalogue: Admin's zone selector, the cart destination selector,
 * and catch-all expansion at the provider boundary all read it, so a code can never
 * be valid in one place and rejected in another.
 *
 * Codes are ISO 3166-1 alpha-2. Names come from `Intl.DisplayNames` (Workers ship a
 * full ICU) rather than a hand-maintained table that would drift and only ever be
 * English — the code is the stored value, the name is presentation.
 */

const CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
  'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
  'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
  'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

/** Every assigned alpha-2 code, uppercase. */
export const COUNTRY_CODES: readonly string[] = Object.freeze(CODES.split(' '));

const CODE_SET = new Set(COUNTRY_CODES);

/** The catch-all marker used in a zone's `countries`. Not a real ISO code. */
export const CATCH_ALL = '*';

export function isCountryCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_SET.has(value.toUpperCase());
}

let displayNames: Intl.DisplayNames | null | undefined;

/** Human label for a code, falling back to the code itself if ICU has no name. */
export function countryName(code: string): string {
  const cc = code.toUpperCase();
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      displayNames = null;
    }
  }
  return displayNames?.of(cc) ?? cc;
}

/** Codes with names, sorted for a picker. Built on demand; callers may cache. */
export function countryOptions(): Array<{ code: string; name: string }> {
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
