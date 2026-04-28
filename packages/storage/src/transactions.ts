import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  CurrencyCode,
  TickerSymbol,
  Timestamp,
  Transaction,
  TransactionAction,
  TransactionSource,
} from '@finclaw/types';

// ─── Row types ───

interface TransactionRow {
  id: string;
  portfolio_id: string;
  symbol: string;
  action: string;
  quantity: number;
  price: number | null;
  fee: number;
  currency: string;
  executed_at: number;
  source: string;
  note: string | null;
  created_at: number;
}

// ─── Public types ───

export type { Transaction } from '@finclaw/types';

/** addTransaction 입력 — id/createdAt 은 함수 내부에서 생성 */
export interface AddTransactionInput {
  portfolioId: string;
  symbol: TickerSymbol;
  action: TransactionAction;
  quantity: number;
  price?: number;
  fee?: number;
  currency: CurrencyCode;
  executedAt: Timestamp;
  source: TransactionSource;
  note?: string;
}

export interface ListTransactionsOptions {
  portfolioId?: string;
  symbol?: TickerSymbol;
  from?: Timestamp;
  to?: Timestamp;
  limit?: number;
}

export interface UpdateTransactionInput {
  portfolioId?: string;
  symbol?: TickerSymbol;
  action?: TransactionAction;
  quantity?: number;
  price?: number | null;
  fee?: number;
  currency?: CurrencyCode;
  executedAt?: Timestamp;
  source?: TransactionSource;
  note?: string | null;
}

// ─── Helpers ───

function rowToTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    symbol: row.symbol as TickerSymbol,
    action: row.action as TransactionAction,
    quantity: row.quantity,
    price: row.price === null ? undefined : row.price,
    fee: row.fee,
    currency: row.currency as CurrencyCode,
    executedAt: row.executed_at as Timestamp,
    source: row.source as TransactionSource,
    note: row.note === null ? undefined : row.note,
    createdAt: row.created_at as Timestamp,
  };
}

// ─── recomputeHoldings ───

/**
 * (portfolioId) 의 holdings 를 transactions 로부터 재계산.
 * - quantity = Σ buy.qty + Σ split.qty - Σ sell.qty (dividend/fee 는 영향 없음)
 * - average_cost = weighted avg of buy prices (sell 은 평균 유지)
 * - quantity ≤ 0 인 (portfolio_id, symbol) 은 holdings 에서 삭제
 *
 * BEGIN IMMEDIATE 로 감싸서 동시 실행 시 충돌 차단.
 */
export function recomputeHoldings(db: DatabaseSync, portfolioId: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 1) 현재 holdings 전부 비우기 (이 portfolio 한정)
    db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ?').run(portfolioId);

    // 2) 심볼별 누적값 계산
    const rows = db
      .prepare(
        `SELECT symbol, action, quantity, price
         FROM transactions
         WHERE portfolio_id = ?
         ORDER BY executed_at ASC, created_at ASC`,
      )
      .all(portfolioId) as unknown as Array<{
      symbol: string;
      action: string;
      quantity: number;
      price: number | null;
    }>;

    // 심볼별 quantity / weighted-avg cost 누적
    interface Acc {
      qty: number;
      buyQtySum: number; // Σ buy.qty
      buyCostSum: number; // Σ buy.qty × buy.price
    }
    const accBySymbol = new Map<string, Acc>();

    for (const r of rows) {
      const acc = accBySymbol.get(r.symbol) ?? { qty: 0, buyQtySum: 0, buyCostSum: 0 };
      switch (r.action) {
        case 'buy':
          acc.qty += r.quantity;
          if (r.price !== null) {
            acc.buyQtySum += r.quantity;
            acc.buyCostSum += r.quantity * r.price;
          }
          break;
        case 'sell':
          acc.qty -= r.quantity;
          // average_cost 변경 없음 (이미 산 평균 유지)
          break;
        case 'split':
          acc.qty += r.quantity;
          // price 는 본 단계에서 무시 (위임 명세)
          break;
        case 'dividend':
        case 'fee':
          // quantity 영향 없음
          break;
      }
      accBySymbol.set(r.symbol, acc);
    }

    // 3) UPSERT
    const insert = db.prepare(
      `INSERT INTO portfolio_holdings (portfolio_id, symbol, quantity, average_cost)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [symbol, acc] of accBySymbol) {
      if (acc.qty <= 0) {
        continue; // holdings 에 안 남김
      }
      const avgCost = acc.buyQtySum > 0 ? acc.buyCostSum / acc.buyQtySum : 0;
      insert.run(portfolioId, symbol, acc.qty, avgCost);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ─── CRUD ───

export function addTransaction(db: DatabaseSync, input: AddTransactionInput): Transaction {
  const id = randomUUID();
  const createdAt = Date.now() as Timestamp;
  const fee = input.fee ?? 0;
  const price = input.price ?? null;
  const note = input.note ?? null;

  db.prepare(
    `INSERT INTO transactions
     (id, portfolio_id, symbol, action, quantity, price, fee, currency,
      executed_at, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.portfolioId,
    input.symbol as string,
    input.action,
    input.quantity,
    price,
    fee,
    input.currency as string,
    input.executedAt as number,
    input.source,
    note,
    createdAt as number,
  );

  recomputeHoldings(db, input.portfolioId);

  const row = db
    .prepare('SELECT * FROM transactions WHERE id = ?')
    .get(id) as unknown as TransactionRow;
  return rowToTransaction(row);
}

export function getTransaction(db: DatabaseSync, id: string): Transaction | null {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as unknown as
    | TransactionRow
    | undefined;
  return row ? rowToTransaction(row) : null;
}

export function listTransactions(
  db: DatabaseSync,
  options: ListTransactionsOptions = {},
): Transaction[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options.portfolioId) {
    clauses.push('portfolio_id = ?');
    params.push(options.portfolioId);
  }
  if (options.symbol) {
    clauses.push('symbol = ?');
    params.push(options.symbol as string);
  }
  if (options.from !== undefined) {
    clauses.push('executed_at >= ?');
    params.push(options.from as number);
  }
  if (options.to !== undefined) {
    clauses.push('executed_at <= ?');
    params.push(options.to as number);
  }

  let sql = 'SELECT * FROM transactions';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY executed_at DESC, created_at DESC';
  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as unknown as TransactionRow[];
  return rows.map(rowToTransaction);
}

export function updateTransaction(
  db: DatabaseSync,
  id: string,
  partial: UpdateTransactionInput,
): Transaction | null {
  const existing = getTransaction(db, id);
  if (!existing) {
    return null;
  }

  const fields: string[] = [];
  const params: Array<string | number | null> = [];

  if (partial.portfolioId !== undefined) {
    fields.push('portfolio_id = ?');
    params.push(partial.portfolioId);
  }
  if (partial.symbol !== undefined) {
    fields.push('symbol = ?');
    params.push(partial.symbol as string);
  }
  if (partial.action !== undefined) {
    fields.push('action = ?');
    params.push(partial.action);
  }
  if (partial.quantity !== undefined) {
    fields.push('quantity = ?');
    params.push(partial.quantity);
  }
  if (partial.price !== undefined) {
    fields.push('price = ?');
    params.push(partial.price);
  }
  if (partial.fee !== undefined) {
    fields.push('fee = ?');
    params.push(partial.fee);
  }
  if (partial.currency !== undefined) {
    fields.push('currency = ?');
    params.push(partial.currency as string);
  }
  if (partial.executedAt !== undefined) {
    fields.push('executed_at = ?');
    params.push(partial.executedAt as number);
  }
  if (partial.source !== undefined) {
    fields.push('source = ?');
    params.push(partial.source);
  }
  if (partial.note !== undefined) {
    fields.push('note = ?');
    params.push(partial.note);
  }

  if (fields.length === 0) {
    return existing;
  }

  params.push(id);
  db.prepare(`UPDATE transactions SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  // 영향받는 portfolio 들 모두 재계산 (변경 전·후 portfolioId 가 다를 수 있음)
  const affected = new Set<string>([existing.portfolioId]);
  if (partial.portfolioId !== undefined) {
    affected.add(partial.portfolioId);
  }
  for (const pid of affected) {
    recomputeHoldings(db, pid);
  }

  const row = db
    .prepare('SELECT * FROM transactions WHERE id = ?')
    .get(id) as unknown as TransactionRow;
  return rowToTransaction(row);
}

export function deleteTransaction(db: DatabaseSync, id: string): boolean {
  const existing = getTransaction(db, id);
  if (!existing) {
    return false;
  }
  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  recomputeHoldings(db, existing.portfolioId);
  return true;
}
