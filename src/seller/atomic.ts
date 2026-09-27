import Fastify from "fastify";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { BuyRequest, BuyResponse, ResetRequest, StatusResponse } from "../types";

export interface AtomicSellerOptions {
  port?: number;
  dbPath?: string;
  chaosDelayMs?: number; // Simulated database latency for chaos testing
}

export function createAtomicSellerServer(options: AtomicSellerOptions = {}) {
  const port = options.port ?? 3002;
  const dbFile = options.dbPath ?? path.join(__dirname, `../../data/tickets_${port}.db`);

  // Ensure data directory exists
  const dir = path.dirname(dbFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Initialize SQLite with WAL mode & busy_timeout for multi-process safety
  const db = new Database(dbFile, { timeout: 10000 });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  let chaosDelayMs = options.chaosDelayMs ?? 0;
  let requestsProcessed = 0;

  // Ensure schema exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_number INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS requests (
      request_id TEXT PRIMARY KEY,
      ticket_number INTEGER NOT NULL,
      user_id TEXT NOT NULL
    );
  `);

  // Prepared SQL Statements for peak throughput
  const resetMetaStmt = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('total_tickets', ?)");
  const getMetaStmt = db.prepare("SELECT value FROM meta WHERE key = 'total_tickets'");
  const wipeTicketsStmt = db.prepare("DELETE FROM tickets");
  const wipeRequestsStmt = db.prepare("DELETE FROM requests");

  const getRequestStmt = db.prepare("SELECT ticket_number, user_id FROM requests WHERE request_id = ?");
  const countTicketsStmt = db.prepare("SELECT COUNT(*) as count FROM tickets");
  const insertTicketStmt = db.prepare("INSERT INTO tickets (ticket_number, user_id) VALUES (?, ?)");
  const insertRequestStmt = db.prepare("INSERT INTO requests (request_id, ticket_number, user_id) VALUES (?, ?, ?)");

  const getAllTicketsStmt = db.prepare("SELECT ticket_number, user_id FROM tickets ORDER BY ticket_number ASC");

  // ATOMIC BUY TRANSACTION
  // SQLite IMMEDIATE transaction acquires a write lock before reading state,
  // preventing any race condition across processes or threads.
  const executeBuyTransaction = db.transaction((user_id: string, request_id: string, totalTickets: number) => {
    // 1. Idempotency Check
    const existingReq = getRequestStmt.get(request_id) as { ticket_number: number; user_id: string } | undefined;
    if (existingReq) {
      return {
        success: true as const,
        ticket_number: existingReq.ticket_number,
        user_id,
        request_id,
        is_duplicate: true,
      };
    }

    // 2. Count Check
    const soldRow = countTicketsStmt.get() as { count: number };
    const currentSold = soldRow.count;

    if (currentSold >= totalTickets) {
      return {
        success: false as const,
        reason: "SOLD_OUT" as const,
        message: "All tickets have been sold out.",
      };
    }

    // 3. Ticket Allocation
    const nextTicketNumber = currentSold + 1;

    insertTicketStmt.run(nextTicketNumber, user_id);
    insertRequestStmt.run(request_id, nextTicketNumber, user_id);

    return {
      success: true as const,
      ticket_number: nextTicketNumber,
      user_id,
      request_id,
    };
  });

  const app = Fastify({ logger: false });

  // Endpoint to set artificial latency (Datastore Chaos Simulation)
  app.post<{ Body: { delay_ms: number } }>("/simulate-chaos", async (req, reply) => {
    chaosDelayMs = req.body?.delay_ms ?? 0;
    return { success: true, chaos_delay_ms: chaosDelayMs };
  });

  app.post<{ Body: ResetRequest }>("/reset", async (req, reply) => {
    const total = req.body?.total_tickets ?? 100;
    
    // Execute reset in a clean transaction
    db.transaction(() => {
      resetMetaStmt.run(total.toString());
      wipeTicketsStmt.run();
      wipeRequestsStmt.run();
    })();

    requestsProcessed = 0;

    return {
      success: true,
      message: "State wiped. Ready for fresh sale.",
      total_tickets: total,
    };
  });

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

    // Datastore Chaos injection if configured
    if (chaosDelayMs > 0) {
      await new Promise((res) => setTimeout(res, chaosDelayMs));
    }

    const row = getMetaStmt.get() as { value: string } | undefined;
    const totalTickets = row ? parseInt(row.value, 10) : 100;

    try {
      // Execute atomic transaction
      const result = executeBuyTransaction(user_id, request_id, totalTickets);
      return result;
    } catch (err: any) {
      // If busy timeout or constraint violation occurs
      return reply.code(500).send({
        success: false,
        reason: "DATASTORE_ERROR",
        message: err.message || "Database transaction error",
      });
    }
  });

  app.get("/status", async (req, reply): Promise<StatusResponse> => {
    const row = getMetaStmt.get() as { value: string } | undefined;
    const totalTickets = row ? parseInt(row.value, 10) : 100;

    const countRow = countTicketsStmt.get() as { count: number };
    const allTickets = getAllTicketsStmt.all() as Array<{ ticket_number: number; user_id: string }>;

    const ticketsMap: Record<string, string> = {};
    for (const t of allTickets) {
      ticketsMap[t.ticket_number.toString()] = t.user_id;
    }

    return {
      total_tickets: totalTickets,
      sold_count: countRow.count,
      tickets: ticketsMap,
      requests_processed: requestsProcessed,
    };
  });

  return {
    app,
    db,
    start: async () => {
      await app.listen({ port, host: "0.0.0.0" });
      return `http://127.0.0.1:${port}`;
    },
    stop: async () => {
      await app.close();
      db.close();
    },
  };
}

if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3002;
  const dbPath = process.env.DB_PATH;
  const server = createAtomicSellerServer({ port, dbPath });
  server.start().then((url) => {
    console.log(`[Atomic Production Seller] Running at ${url}`);
  });
}
