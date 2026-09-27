import Fastify from "fastify";
import { BuyRequest, BuyResponse, ResetRequest, StatusResponse } from "../types";

export function createNaiveSellerServer(port: number = 3001) {
  const app = Fastify({ logger: false });

  let totalTickets = 100;
  let soldCount = 0;
  const tickets: Record<string, string> = {}; // ticket_number -> user_id
  const requestHistory: Record<string, number> = {}; // request_id -> ticket_number
  let requestsProcessed = 0;

  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  app.post<{ Body: ResetRequest }>("/reset", async (req, reply) => {
    totalTickets = req.body?.total_tickets ?? 100;
    soldCount = 0;
    for (const key of Object.keys(tickets)) delete tickets[key];
    for (const key of Object.keys(requestHistory)) delete requestHistory[key];
    requestsProcessed = 0;

    return {
      success: true,
      message: "State wiped. Ready for fresh sale.",
      total_tickets: totalTickets,
    };
  });

  // Naive POST /buy with deliberate race condition window
  app.post<{ Body: BuyRequest }>("/buy", async (req, reply): Promise<BuyResponse> => {
    requestsProcessed++;
    const { user_id, request_id } = req.body || {};

    if (!user_id || !request_id) {
      return reply.code(400).send({
        success: false,
        reason: "INVALID_REQUEST",
        message: "user_id and request_id are required",
      });
    }

    // NAIVE FLAW 1: Non-atomic check of available tickets
    if (soldCount >= totalTickets) {
      return {
        success: false,
        reason: "SOLD_OUT",
        message: "All tickets have been sold out.",
      };
    }

    // NAIVE FLAW 2: Non-atomic idempotency lookup
    if (requestHistory[request_id]) {
      return {
        success: true,
        ticket_number: requestHistory[request_id],
        user_id,
        request_id,
        is_duplicate: true,
      };
    }

    // Artificial async tick simulating database lookup / IO delay window where race condition hits
    await sleep(15);

    // NAIVE FLAW 3: Non-atomic read-modify-write state mutation
    soldCount = soldCount + 1;
    const ticketNumber = soldCount;

    // Overwrite risk & duplicate ticket issuance
    tickets[ticketNumber.toString()] = user_id;
    requestHistory[request_id] = ticketNumber;

    return {
      success: true,
      ticket_number: ticketNumber,
      user_id,
      request_id,
    };
  });

  app.get("/status", async (req, reply): Promise<StatusResponse> => {
    return {
      total_tickets: totalTickets,
      sold_count: soldCount,
      tickets,
      requests_processed: requestsProcessed,
    };
  });

  return {
    app,
    start: async () => {
      await app.listen({ port, host: "0.0.0.0" });
      return `http://127.0.0.1:${port}`;
    },
    stop: async () => {
      await app.close();
    },
  };
}

if (require.main === module) {
  const server = createNaiveSellerServer(3001);
  server.start().then((url) => {
    console.log(`[Naive Seller] Running at ${url}`);
  });
}
