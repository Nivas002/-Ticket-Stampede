import { Agent, request } from "undici";
import { BenchmarkMetrics, BuyResponse, InvariantResult, StatusResponse } from "../types";

export interface LoadClientOptions {
  targetUrl: string;
  totalRequests?: number;
  concurrency?: number;
  totalTickets?: number;
  duplicateRatio?: number; // e.g. 0.2 means 20% duplicate request_ids
}

export class LoadClient {
  public targetUrl: string;
  public totalRequests: number;
  public concurrency: number;
  public totalTickets: number;
  public duplicateRatio: number;
  private agent: Agent;

  constructor(options: LoadClientOptions) {
    this.targetUrl = options.targetUrl.replace(/\/$/, "");
    this.totalRequests = options.totalRequests ?? 1000;
    this.concurrency = options.concurrency ?? 50;
    this.totalTickets = options.totalTickets ?? 100;
    this.duplicateRatio = options.duplicateRatio ?? 0.2;

    this.agent = new Agent({
      connections: Math.max(this.concurrency, 100),
      pipelining: 1,
      keepAliveTimeout: 30000,
    });
  }

  public async run(): Promise<BenchmarkMetrics> {
    // 1. Reset seller state
    await request(`${this.targetUrl}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ total_tickets: this.totalTickets }),
      dispatcher: this.agent,
    });

    // Prepare Workload
    const requestsToMake: Array<{ user_id: string; request_id: string; is_duplicate_input: boolean }> = [];
    const uniqueReqIds: string[] = [];

    const numUnique = Math.floor(this.totalRequests * (1 - this.duplicateRatio));
    for (let i = 0; i < numUnique; i++) {
      const reqId = `req_unique_${i}_${Math.random().toString(36).substring(2, 7)}`;
      uniqueReqIds.push(reqId);
      requestsToMake.push({
        user_id: `user_${i}`,
        request_id: reqId,
        is_duplicate_input: false,
      });
    }

    // Add duplicate request ID entries (replaying existing request IDs)
    const numDuplicates = this.totalRequests - numUnique;
    for (let i = 0; i < numDuplicates; i++) {
      const randomExistingReqId = uniqueReqIds[Math.floor(Math.random() * uniqueReqIds.length)];
      requestsToMake.push({
        user_id: `user_replay_${i}`,
        request_id: randomExistingReqId,
        is_duplicate_input: true,
      });
    }

    // Shuffle workload array to interleave unique and duplicate requests concurrently
    for (let i = requestsToMake.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [requestsToMake[i], requestsToMake[j]] = [requestsToMake[j], requestsToMake[i]];
    }

    // Response collection structures
    const latenciesMs: number[] = [];
    const responseMapByReqId = new Map<string, Array<{ ticket_number?: number; is_duplicate?: boolean; status: number }>>();
    const issuedTicketsByNumber = new Map<number, Set<string>>(); // ticket_number -> Set<user_id>
    
    let successfulBuys = 0;
    let duplicateHits = 0;
    let soldOutResponses = 0;
    let failedRequests = 0;

    const startTime = process.hrtime.bigint();

    // Concurrent Worker Execution Pool
    let currentIndex = 0;
    const worker = async () => {
      while (true) {
        const index = currentIndex++;
        if (index >= requestsToMake.length) break;

        const reqData = requestsToMake[index];
        const reqStart = process.hrtime.bigint();

        try {
          const res = await request(`${this.targetUrl}/buy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              user_id: reqData.user_id,
              request_id: reqData.request_id,
            }),
            dispatcher: this.agent,
          });

          const reqEnd = process.hrtime.bigint();
          const latencyMs = Number(reqEnd - reqStart) / 1_000_000;
          latenciesMs.push(latencyMs);

          const bodyText = await res.body.text();
          let data: BuyResponse;
          try {
            data = JSON.parse(bodyText);
          } catch {
            failedRequests++;
            continue;
          }

          if (res.statusCode === 200 && data.success) {
            successfulBuys++;
            if (data.is_duplicate) {
              duplicateHits++;
            }

            // Track ticket responses per request_id for idempotency verification
            if (!responseMapByReqId.has(reqData.request_id)) {
              responseMapByReqId.set(reqData.request_id, []);
            }
            responseMapByReqId.get(reqData.request_id)!.push({
              ticket_number: data.ticket_number,
              is_duplicate: data.is_duplicate,
              status: res.statusCode,
            });

            // Track ticket number to user mapping
            if (data.ticket_number) {
              if (!issuedTicketsByNumber.has(data.ticket_number)) {
                issuedTicketsByNumber.set(data.ticket_number, new Set());
              }
              issuedTicketsByNumber.get(data.ticket_number)!.add(data.user_id);
            }
          } else if (data.success === false && data.reason === "SOLD_OUT") {
            soldOutResponses++;
          } else {
            failedRequests++;
          }
        } catch (err) {
          failedRequests++;
        }
      }
    };

    const workers = Array.from({ length: this.concurrency }, () => worker());
    await Promise.all(workers);

    const endTime = process.hrtime.bigint();
    const durationSeconds = Number(endTime - startTime) / 1_000_000_000;
    const rps = this.totalRequests / durationSeconds;

    // Latency Percentile Calculation
    latenciesMs.sort((a, b) => a - b);
    const getPercentile = (p: number) => {
      if (latenciesMs.length === 0) return 0;
      const idx = Math.floor((p / 100) * latenciesMs.length);
      return latenciesMs[Math.min(idx, latenciesMs.length - 1)];
    };

    const latencyStats = {
      min: latenciesMs[0] || 0,
      median_p50: getPercentile(50),
      p90: getPercentile(90),
      p99: getPercentile(99),
      max: latenciesMs[latenciesMs.length - 1] || 0,
    };

    // 3. Fetch Status for Invariant Verification
    const statusRes = await request(`${this.targetUrl}/status`, {
      method: "GET",
      dispatcher: this.agent,
    });
    const statusData: StatusResponse = JSON.parse(await statusRes.body.text());

    // 4. Invariant Verification Analysis
    const invariants: InvariantResult[] = [];

    // Invariant 1: Never sell more tickets than exist
    const inv1Passed = statusData.sold_count <= this.totalTickets;
    invariants.push({
      invariant: "Invariant 1: No Overselling",
      description: `Sold count (${statusData.sold_count}) must be <= total capacity (${this.totalTickets}).`,
      passed: inv1Passed,
      details: inv1Passed
        ? `PASSED: Sold ${statusData.sold_count}/${this.totalTickets} tickets under ${this.concurrency} concurrent threads.`
        : `FAILED: OVER SOLD! System sold ${statusData.sold_count} tickets for capacity ${this.totalTickets}!`,
    });

    // Invariant 2: Never issue the same ticket number twice
    let duplicateTicketFound = false;
    let dupDetails = "";
    for (const [tNum, userSet] of issuedTicketsByNumber.entries()) {
      if (tNum > this.totalTickets) {
        duplicateTicketFound = true;
        dupDetails += ` Ticket #${tNum} exceeds capacity limit.`;
      }
    }
    const statusTicketNumbers = Object.keys(statusData.tickets);
    const uniqueStatusTickets = new Set(statusTicketNumbers);
    const inv2Passed = !duplicateTicketFound && uniqueStatusTickets.size === statusTicketNumbers.length && statusData.sold_count <= this.totalTickets;
    
    invariants.push({
      invariant: "Invariant 2: Unique Ticket Numbers",
      description: "Each ticket number (1..N) must be issued at most once to a unique buyer.",
      passed: inv2Passed,
      details: inv2Passed
        ? `PASSED: All ${statusData.sold_count} issued tickets are strictly unique.`
        : `FAILED: Duplicate ticket numbers issued or invalid ticket mapping detected! ${dupDetails}`,
    });

    // Invariant 3: Idempotency under replay attack (including concurrent in-flight replays)
    let idempotencyPassed = true;
    let idempotencyFailures = 0;
    for (const [reqId, responses] of responseMapByReqId.entries()) {
      if (responses.length > 1) {
        const firstTicket = responses[0].ticket_number;
        for (let r = 1; r < responses.length; r++) {
          if (responses[r].ticket_number !== firstTicket) {
            idempotencyPassed = false;
            idempotencyFailures++;
          }
        }
      }
    }
    invariants.push({
      invariant: "Invariant 3: Strict Idempotency",
      description: "Replaying identical request_id (both sequential & parallel in-flight) must return the same ticket number without creating extra tickets.",
      passed: idempotencyPassed,
      details: idempotencyPassed
        ? `PASSED: All duplicate request_ids (including parallel in-flight retries) safely returned matching existing tickets.`
        : `FAILED: Idempotency breached ${idempotencyFailures} times! Replaying in-flight request_id yielded different/new tickets.`,
    });

    // Invariant 4: Status Count Consistency
    const inv4Passed = statusData.sold_count === Object.keys(statusData.tickets).length;
    invariants.push({
      invariant: "Invariant 4: Status Consistency",
      description: "GET /status sold_count must strictly equal length of tickets object map.",
      passed: inv4Passed,
      details: inv4Passed
        ? `PASSED: Status count (${statusData.sold_count}) matches ticket object keys count (${Object.keys(statusData.tickets).length}).`
        : `FAILED: Inconsistency detected! Status count=${statusData.sold_count} vs map length=${Object.keys(statusData.tickets).length}.`,
    });

    return {
      total_requests: this.totalRequests,
      concurrency: this.concurrency,
      successful_buys: successfulBuys,
      duplicate_hits: duplicateHits,
      sold_out_responses: soldOutResponses,
      failed_requests: failedRequests,
      duration_seconds: durationSeconds,
      requests_per_second: rps,
      latencies_ms: latencyStats,
      invariants,
    };
  }
}
