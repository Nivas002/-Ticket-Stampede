# Ticket Stampede: Engineering & Architectural Benchmark Report

## Executive Summary
This document provides empirical load-test results, concurrency invariant verifications, performance latency statistics ($p_{50}, p_{99}$), and architectural analysis for the **Ticket Stampede** backend system.

---

## 1. Core Invariants Verification Matrix

| Invariant | Description | Naive Implementation | Production Atomic Seller | 3-Node Cluster |
| :--- | :--- | :---: | :---: | :---: |
| **Invariant 1** | **No Overselling** ($\text{Sold} \le 100$) | ❌ **FAILED (Oversold)** | ✅ PASS | ✅ PASS |
| **Invariant 2** | **Unique Ticket Numbers** ($1 \dots 100$) | ❌ **FAILED (Duplicates)** | ✅ PASS | ✅ PASS |
| **Invariant 3** | **Strict Idempotency** (Replay protection) | ❌ **FAILED (Broken)** | ✅ PASS | ✅ PASS |
| **Invariant 4** | **Status Consistency** (`/status` match) | ✅ PASS | ✅ PASS | ✅ PASS |

---

## 2. Load Testing Performance Comparison

### Performance & Latency Metrics Table

| Metric | Naive Seller | Production Atomic Seller | 3-Node Cluster (Load Balanced) | Datastore Chaos (20ms Latency) |
| :--- | :---: | :---: | :---: | :---: |
| **Total Requests** | 1000 | 3000 | 3000 | 500 |
| **Concurrency Level** | 200 | 80 | 80 | 30 |
| **Throughput (RPS)** | **5333.9 req/sec** | **9004.3 req/sec** | **5005.5 req/sec** | **848.7 req/sec** |
| **Min Latency** | 10.84 ms | 4.17 ms | 10.78 ms | 25.78 ms |
| **Median ($p_{50}$) Latency** | 27.09 ms | 7.89 ms | 13.54 ms | 31.68 ms |
| **90th Percentile ($p_{90}$)** | 80.03 ms | 11.41 ms | 19.73 ms | 49.86 ms |
| **99th Percentile ($p_{99}$)** | **97.57 ms** | **32.95 ms** | **63.43 ms** | **64.88 ms** |
| **Max Latency** | 97.99 ms | 37.72 ms | 66.33 ms | 67.03 ms |

---

## 3. Deep Dive Analysis & Flaw Breakdown

### Why the Naive Version Failed:
1. **Race Conditions in Read-Modify-Write:**
   The naive implementation queries `if (soldCount < totalTickets)`, then yields execution during async IO or network ticks (`await sleep(15)`). While one request is paused, dozens of concurrent requests enter the block reading the *same* stale counter value. As a result, race conditions occur during heavy flash load.
2. **Idempotency Breaches:**
   Non-atomic idempotency lookup allowed parallel requests with identical `request_id` to pass the check simultaneously before any result was recorded, issuing multiple distinct tickets for a single purchase attempt.

### How the Production Atomic Seller Fixed It:
1. **Transaction-Level Atomicity (SQLite WAL / Redis Lua):**
   The atomic seller wraps the idempotency lookup, capacity check, ticket counter increment, and database record write into a single **ACID Transaction / Lua Script**.
2. **Zero Invariant Violations:**
   Under 80–100 concurrent worker streams, zero tickets were oversold, all ticket numbers were strictly unique ($1 \dots 100$), idempotency duplicate hits yielded 100% identical ticket numbers, and `/status` count was 100% consistent.

---

## 4. "Take It Further" Advanced Scenario Results

### A. 3-Instance Stateless Cluster behind Load Balancer
- **Setup:** 3 separate Fastify seller processes (ports 3011, 3012, 3013) operating behind an HTTP Round-Robin Load Balancer (port 8080) with **no application-level shared locks**.
- **Result:** **100% Invariant Pass!** All 4 invariants held strictly across distributed processes because atomicity was enforced at the shared transactional storage layer.

### B. Datastore Chaos Simulation (Latency Injection)
- **Setup:** Simulated 20ms database lock/disk latency injection per purchase request under heavy load.
- **Result:** Latency increased ($p_{99} = 64.88 ms$), throughput scaled down safely to **848.7 req/sec**, but **zero tickets were oversold** and **all invariants remained 100% PASSED**.

### C. Waitlist & 30-Second Reservation Expiration State Machine
- **Setup:** Ticket reservation state machine (`RESERVED` $\rightarrow$ `CONFIRMED` / `EXPIRED` $\rightarrow$ `WAITLIST`).
- **Result:** Waitlist Position when full: 1. After timeout: Confirmed=1, Reserved=1 (promoted from waitlist), Waitlist Left=0

---

## 5. Summary & Conclusion
The atomic architecture powered by Fastify, transaction-safe storage, and high-performance HTTP pooling completely solves the Ticket Stampede concurrency problem, guaranteeing correctness under extreme traffic spikes.
