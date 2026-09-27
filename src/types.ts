export interface ResetRequest {
  total_tickets: number;
}

export interface ResetResponse {
  success: boolean;
  message: string;
  total_tickets: number;
}

export interface BuyRequest {
  user_id: string;
  request_id: string;
}

export interface BuyResponseSuccess {
  success: true;
  ticket_number: number;
  user_id: string;
  request_id: string;
  is_duplicate?: boolean;
}

export interface BuyResponseSoldOut {
  success: false;
  reason: "SOLD_OUT";
  message: string;
}

export interface BuyResponseError {
  success: false;
  reason: string;
  message: string;
}

export type BuyResponse = BuyResponseSuccess | BuyResponseSoldOut | BuyResponseError;

export interface StatusResponse {
  total_tickets: number;
  sold_count: number;
  tickets: Record<string, string>; // ticket_number (string) -> user_id
  requests_processed: number;
}

export interface ReserveRequest {
  user_id: string;
  request_id: string;
}

export interface ReserveResponse {
  success: boolean;
  reservation_id?: string;
  ticket_number?: number;
  expires_at?: number;
  reason?: string;
  waitlist_position?: number;
}

export interface ConfirmRequest {
  reservation_id: string;
  user_id: string;
}

export interface InvariantResult {
  invariant: string;
  description: string;
  passed: boolean;
  details: string;
}

export interface BenchmarkMetrics {
  total_requests: number;
  concurrency: number;
  successful_buys: number;
  duplicate_hits: number;
  sold_out_responses: number;
  failed_requests: number;
  duration_seconds: number;
  requests_per_second: number;
  latencies_ms: {
    min: number;
    median_p50: number;
    p90: number;
    p99: number;
    max: number;
  };
  invariants: InvariantResult[];
}
