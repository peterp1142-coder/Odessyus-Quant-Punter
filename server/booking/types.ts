// Known platform IDs — additional platforms handled generically
export type PlatformId =
  | 'sportybet'
  | 'football.com'
  | 'bet365'
  | '1xbet'
  | 'betway'
  | 'betika'
  | 'parimatch'
  | 'melbet'
  | 'betwinner'
  | string; // allow any custom platform

export interface BookingRequest {
  platform: string;          // platform id or custom name
  fixture: string;           // "Arsenal vs Chelsea"
  market: string;            // "Over 2.5 Goals"
  selection: string;         // "Over 2.5"
  minOdds: number;           // reject booking if odds dropped below this
  stakeUnits: number;        // multiply by BOOKING_STAKE_UNIT env var
  stakeOverride?: number;    // explicit amount, ignores units
  sessionId?: string;        // for logging/db
  predictionId?: string;     // link back to prediction
}

export interface BookingResult {
  success: boolean;
  platform: string;
  fixture: string;
  market: string;
  selection: string;
  oddsObtained?: number;
  stakeAmount?: number;
  potentialReturn?: number;
  betId?: string;
  betslipRef?: string;
  confirmationText?: string;
  screenshotBase64?: string;
  error?: string;
  reason?: string;           // human-readable reason on failure
  timestamp: string;
}

export interface PlatformConfig {
  id: string;
  name: string;
  baseUrl: string;
  loginUrl: string;
  searchable: boolean;       // can search fixtures by name
  selectors: {
    usernameInput: string;
    passwordInput: string;
    loginButton: string;
    searchBox?: string;
    betslipStakeInput: string;
    betslipConfirmButton: string;
    oddsDisplay?: string;
    confirmationMsg?: string;
    cookieBanner?: string;
  };
}
