/**
 * State selector for address forms.
 *
 * For US addresses this renders a dropdown of states keyed by the two-letter
 * code, and every selection writes BOTH `province` (full name) and
 * `provinceCode` (two-letter code). That pairing is the whole point: the save
 * path (normalizeMailingAddress) prefers provinceCode over the typed name, so
 * a free-text state edit that leaves a stale provinceCode behind ships the OLD
 * state to Shopify ("Enter a valid ZIP code for Tennessee" on a Wisconsin
 * address).
 *
 * For non-US addresses it falls back to a text input that clears provinceCode
 * on every keystroke for the same reason.
 */

import { cn } from '@/lib/utils';

export const US_STATES: { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
  // Territories + military - Shopify ships to these as US provinces
  { code: 'AS', name: 'American Samoa' },
  { code: 'GU', name: 'Guam' },
  { code: 'MP', name: 'Northern Mariana Islands' },
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'VI', name: 'U.S. Virgin Islands' },
  { code: 'AA', name: 'Armed Forces Americas' },
  { code: 'AE', name: 'Armed Forces Europe' },
  { code: 'AP', name: 'Armed Forces Pacific' },
];

const US_COUNTRY_RE = /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i;

export function isUsCountry(country?: string, countryCode?: string): boolean {
  const code = (countryCode || '').trim().toUpperCase();
  if (code) return code === 'US';
  const name = (country || '').trim();
  // No country at all on the address: the store is US-first, default to the
  // dropdown so the common case never needs typing.
  if (!name) return true;
  return US_COUNTRY_RE.test(name);
}

function resolveSelectedCode(province?: string, provinceCode?: string): string {
  const code = (provinceCode || '').trim().toUpperCase();
  if (US_STATES.some((s) => s.code === code)) return code;
  const name = (province || '').trim().toLowerCase();
  if (name) {
    const byName = US_STATES.find(
      (s) => s.name.toLowerCase() === name || s.code.toLowerCase() === name
    );
    if (byName) return byName.code;
  }
  return '';
}

export interface StateSelectProps {
  province?: string;
  provinceCode?: string;
  country?: string;
  countryCode?: string;
  /** Always called with the matched pair - name and code stay in sync. */
  onChange: (value: { province: string; provinceCode: string }) => void;
  className?: string;
  placeholder?: string;
}

export function StateSelect({
  province,
  provinceCode,
  country,
  countryCode,
  onChange,
  className,
  placeholder = 'State',
}: StateSelectProps) {
  const baseClass = cn(
    'block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm bg-white text-gray-900',
    'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
    className
  );

  if (!isUsCountry(country, countryCode)) {
    return (
      <input
        className={cn(baseClass, 'placeholder:text-gray-500')}
        placeholder={placeholder}
        value={province || ''}
        onChange={(e) =>
          // Clear the code so the typed name is what actually ships.
          onChange({ province: e.target.value, provinceCode: '' })
        }
      />
    );
  }

  const selected = resolveSelectedCode(province, provinceCode);

  return (
    <select
      className={cn(baseClass, selected ? '' : 'text-gray-500')}
      value={selected}
      onChange={(e) => {
        const state = US_STATES.find((s) => s.code === e.target.value);
        onChange(
          state
            ? { province: state.name, provinceCode: state.code }
            : { province: '', provinceCode: '' }
        );
      }}
    >
      <option value="">{placeholder}</option>
      {US_STATES.map((s) => (
        <option key={s.code} value={s.code}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
