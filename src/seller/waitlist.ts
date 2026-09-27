import Fastify from "fastify";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { ResetRequest } from "../types";

export interface WaitlistSellerOptions {
  port?: number;
  dbPath?: string;
  reservationTimeoutMs?: number; // Default 30,000ms (30s)
}

export function createWaitlistSellerServer(options: WaitlistSellerOptions = {}) {
  const port = options.port ?? 3004;
  const reservationTimeoutMs = options.reservationTimeoutMs ?? 30000;
  const dbFile = options.dbPath ?? path.join(__dirname, `../../data/waitlist_${port}.db`);

  const dir = path.dirname(dbFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbFile, { timeout: 10000 });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_number INTEGER PRIMARY KEY,
      user_id TEXT,
      request_id TEXT,
      reservation_id TEXT UNIQUE,
      status TEXT CHECK(status IN ('RESERVED', 'CONFIRMED', 'EXPIRED')),
      expires_at INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS waitlist (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      request_id TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const app = Fastify({ logger: false });

  // Background state machine processor: Cleanup expired reservations & promote waitlist
  const processExpirations = db.transaction(() => {
    const now = Date.now();
    // Find all expired reservations
    const expiredTickets = db
      .prepare("SELECT ticket_number, user_id FROM tickets WHERE status = 'RESERVED' AND expires_at <= ?")
      .all(now) as Array<{ ticket_number: number; user_id: string }>;

    for (const ticket of expiredTickets) {
      // Check if there is someone in the waitlist
      const nextWaitlisted = db
        .prepare("SELECT position, user_id, request_id FROM waitlist ORDER BY position ASC LIMIT 1")
        .get() as { position: number; user_id: string; request_id: string } | undefined;

      if (nextWaitlisted) {
        // Remove from waitlist
        db.prepare("DELETE FROM waitlist WHERE position = ?").run(nextWaitlisted.position);
        
        // Re-assign ticket to next waitlisted user
        const newReservationId = `res_${nextWaitlisted.request_id}`;
        const newExpiresAt = now + reservationTimeoutMs;

        db.prepare(`
          UPDATE tickets 
          SET user_id = ?, request_id = ?, reservation_id = ?, status = 'RESERVED', expires_at = ?
          WHERE ticket_number = ?
        `).run(nextWaitlisted.user_id, nextWaitlisted.request_id, newReservationId, newExpiresAt, ticket.ticket_number);
      } else {
        // No one in waitlist, mark ticket as expired/reclaimed
        db.prepare(`
          UPDATE tickets 
          SET status = 'EXPIRED', user_id = NULL, request_id = NULL, reservation_id = NULL, expires_at = NULL
          WHERE ticket_number = ?
        `).run(ticket.ticket_number);
      }
    }
  });

  // Run cleanup every 1 second
  const timer = setInterval(() => {
    try {
      processExpirations();
    } catch (e) {
      // Ignore background transient locks
    }
  }, 1000);

  app.post<{ Body: ResetRequest }>("/reset", async (req, reply) => {
    const total = req.body?.total_tickets ?? 100;
    
    db.transaction(() => {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('total_tickets', ?)").run(total.toString());
      db.prepare("DELETE FROM tickets").run();
      db.prepare("DELETE FROM waitlist").run();
    })();

    return {
      success: true,
      message: "Waitlist seller reset.",
      total_tickets: total,
    };
  });

  app.post<{ Body: { user_id: string; request_id: string } }>("/reserve", async (req, reply) => {
    const { user_id, request_id } = req.body || {};
    const now = Date.now();

    if (!user_id || !request_id) {
      return reply.code(400).send({ success: false, reason: "INVALID_REQUEST" });
    }

    const totalRow = db.prepare("SELECT value FROM meta WHERE key = 'total_tickets'").get() as { value: string } | undefined;
    const totalTickets = totalRow ? parseInt(totalRow.value, 10) : 100;

    // Run reservation in atomic transaction
    const result = db.transaction(() => {
      // Process any pending expirations first
      processExpirations();

      // Check idempotency: Did request already get a ticket or waitlist?
      const existingTicket = db.prepare("SELECT ticket_number, reservation_id, status, expires_at FROM tickets WHERE request_id = ?").get(request_id) as any;
      if (existingTicket && existingTicket.status !== 'EXPIRED') {
        return {
          success: true,
          status: existingTicket.status,
          ticket_number: existingTicket.ticket_number,
          reservation_id: existingTicket.reservation_id,
          expires_at: existingTicket.expires_at,
          is_duplicate: true,
        };
      }

      const existingWaitlist = db.prepare("SELECT position FROM waitlist WHERE request_id = ?").get(request_id) as any;
      if (existingWaitlist) {
        return {
          success: true,
          status: "WAITLISTED",
          waitlist_position: existingWaitlist.position,
          is_duplicate: true,
        };
      }

      // Count active tickets (RESERVED or CONFIRMED)
      const activeCountRow = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status IN ('RESERVED', 'CONFIRMED')").get() as { count: number };
      
      if (activeCountRow.count < totalTickets) {
        // Allocate ticket
        const nextTicketNumber = activeCountRow.count + 1;
        const reservation_id = `res_${request_id}`;
        const expires_at = now + reservationTimeoutMs;

        db.prepare(`
          INSERT OR REPLACE INTO tickets (ticket_number, user_id, request_id, reservation_id, status, expires_at)
          VALUES (?, ?, ?, ?, 'RESERVED', ?)
        `).run(nextTicketNumber, user_id, request_id, reservation_id, expires_at);

        return {
          success: true,
          status: "RESERVED",
          ticket_number: nextTicketNumber,
          reservation_id,
          expires_at,
        };
      } else {
        // Waitlist user
        db.prepare("INSERT INTO waitlist (user_id, request_id) VALUES (?, ?)").run(user_id, request_id);
        const posRow = db.prepare("SELECT COUNT(*) as pos FROM waitlist").get() as { pos: number };

        return {
          success: true,
          status: "WAITLISTED",
          waitlist_position: posRow.pos,
          message: "All tickets reserved/sold. Added to waitlist.",
        };
      }
    })();

    return result;
  });

  app.post<{ Body: { reservation_id: string; user_id: string } }>("/confirm", async (req, reply) => {
    const { reservation_id, user_id } = req.body || {};
    const now = Date.now();

    const result = db.transaction(() => {
      const ticket = db.prepare("SELECT ticket_number, status, expires_at FROM tickets WHERE reservation_id = ? AND user_id = ?").get(reservation_id, user_id) as any;
      
      if (!ticket) {
        return { success: false, reason: "NOT_FOUND", message: "Reservation not found." };
      }

      if (ticket.status === 'CONFIRMED') {
        return { success: true, status: "CONFIRMED", ticket_number: ticket.ticket_number, is_duplicate: true };
      }

      if (ticket.status === 'EXPIRED' || ticket.expires_at <= now) {
        return { success: false, reason: "EXPIRED", message: "Reservation has expired and returned to pool." };
      }

      db.prepare("UPDATE tickets SET status = 'CONFIRMED', expires_at = NULL WHERE reservation_id = ?").run(reservation_id);

      return {
        success: true,
        status: "CONFIRMED",
        ticket_number: ticket.ticket_number,
      };
    })();

    return result;
  });

  app.get("/status", async (req, reply) => {
    processExpirations();

    const totalRow = db.prepare("SELECT value FROM meta WHERE key = 'total_tickets'").get() as { value: string } | undefined;
    const totalTickets = totalRow ? parseInt(totalRow.value, 10) : 100;

    const confirmedRow = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'CONFIRMED'").get() as { count: number };
    const reservedRow = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'RESERVED'").get() as { count: number };
    const waitlistRow = db.prepare("SELECT COUNT(*) as count FROM waitlist").get() as { count: number };

    const allTickets = db.prepare("SELECT ticket_number, user_id, status, expires_at FROM tickets ORDER BY ticket_number ASC").all();

    return {
      total_tickets: totalTickets,
      confirmed_count: confirmedRow.count,
      reserved_count: reservedRow.count,
      waitlist_length: waitlistRow.count,
      tickets: allTickets,
    };
  });

  return {
    app,
    db,
    stopTimer: () => clearInterval(timer),
    start: async () => {
      await app.listen({ port, host: "0.0.0.0" });
      return `http://127.0.0.1:${port}`;
    },
    stop: async () => {
      clearInterval(timer);
      await app.close();
      db.close();
    },
  };
}

if (require.main === module) {
  const server = createWaitlistSellerServer({ port: 3004 });
  server.start().then((url) => {
    console.log(`[Waitlist Seller] Running at ${url}`);
  });
}
