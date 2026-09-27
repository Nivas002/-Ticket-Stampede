# Ticket Stampede 🎫💥

A highly concurrent, fault-tolerant ticket-booking system designed to sell a limited pool of tickets (e.g. 100 tickets) under severe flash-sale stampede conditions (**50,000 requests in 60 seconds**) without overselling, duplicate ticket assignments, or broken idempotency.

Includes an automated load testing client that attacks the seller, validates all 4 concurrency invariants, tracks latency percentiles ($p_{50}, p_{99}$), and evaluates advanced scenarios like multi-instance load balancing, datastore chaos, and waitlist state machines.

---

## ⚡ Quick Start: Run in Under 2 Minutes

### Prerequisites
* **Node.js** (v18+ recommended, tested on v24)
* **npm** (v9+)

### 1. Clone & Install
```bash
git clone https://github.com/Nivas002/-Ticket-Stampede.git
cd -Ticket-Stampede
npm install
```

### 2. Run the Benchmark Suite
```bash
npm test
```

That's it! `npm test` compiles TypeScript on-the-fly and executes all 5 benchmark suites sequentially, displaying real-time colored pass/fail matrix results in your terminal and writing the final report to `TICKET_STAMPEDE_REPORT.md`.

---

## 🧪 What `npm test` Executes

| Suite | Target | Concurrency | Description & Outcome |
| :--- | :--- | :---: | :--- |
| **Suite 1** | **Naive Seller** (`:3001`) | 200 workers | Demonstrates race condition flaws: **Fails** Invariant 1 (Oversells 200/100 tickets) & Invariant 3 (Breaches idempotency). |
| **Suite 2** | **Production Atomic Seller** (`:3002`) | 80 workers | Executes SQLite WAL ACID transactions / Redis Lua scripts: **100% PASS** on all 4 invariants ($8,500+\text{ RPS}$). |
| **Suite 3** | **3-Node Cluster** (`:8080`) | 80 workers | Balances traffic across 3 stateless seller nodes behind a Round-Robin proxy: **100% PASS** with zero app-level locks. |
| **Suite 4** | **Datastore Chaos** (`:3003`) | 30 workers | Injects 20ms database lock latency: **100% PASS** (throughput scales safely down to $\sim 900\text{ RPS}$ without overselling). |
| **Suite 5** | **Waitlist State Machine** (`:3004`) | State Machine | Tests 30-second reservation timeouts, auto-reclaims expired tickets, and promotes waitlisted buyers safely. |

---

## 🏃 Individual Server Commands

You can also run individual seller servers or client components independently:

```bash
# Start Naive Seller (Port 3001)
npm run start:naive

# Start Production Atomic Seller (Port 3002)
npm run start:atomic

# Start Waitlist State Machine Seller (Port 3004)
npm run start:waitlist
```

---

## 🔌 API Endpoints Reference

### Core Seller API
* `POST /reset` — Takes `{ "total_tickets": 100 }`, wipes database state, and starts a fresh sale.
* `POST /buy` — Takes `{ "user_id": "usr_1", "request_id": "req_101" }`. Returns `{ "success": true, "ticket_number": 1 }` or `{ "success": false, "reason": "SOLD_OUT" }`.
* `GET /status` — Returns `{ "total_tickets": 100, "sold_count": 100, "tickets": { "1": "usr_1", ... } }`.

### Waitlist Seller API
* `POST /reserve` — Takes `{ "user_id": "usr_1", "request_id": "req_101" }`. Reserves a ticket for 30s or queues user in waitlist if full.
* `POST /confirm` — Takes `{ "reservation_id": "res_req_101", "user_id": "usr_1" }`. Converts reservation to confirmed ticket.

---

## 📚 Key Architectural Documents

* **[`ENGINEERING_DEEP_DIVE.md`](ENGINEERING_DEEP_DIVE.md)** — Analysis of unasked edge cases solved beyond the basic floor (In-Flight Parallel Idempotency Replays, State Machine Thundering Herd, Empirical Client Proofs).
* **[`DECISIONS.md`](DECISIONS.md)** — Architectural choices, rejected alternatives, time-limit trade-offs, system limits, and 2-week roadmap.
* **[`TICKET_STAMPEDE_REPORT.md`](TICKET_STAMPEDE_REPORT.md)** — Empirical benchmark results and $p_{50}/p_{99}$ latency comparison matrix.
* **[`logs/`](logs/)** — Full session execution transcripts (`transcript_full.jsonl`).
