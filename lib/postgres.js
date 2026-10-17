const { Pool } = require('pg');

class PostgresDatabase {
  constructor(connectionString) {
    // Supabase pooler on port 6543 uses transaction mode which prevents session starvation
    const resolvedUrl = connectionString.includes('pooler.supabase.com:5432')
      ? connectionString.replace(':5432', ':6543')
      : connectionString;

    this.pool = new Pool({
      connectionString: resolvedUrl,
      ssl: { rejectUnauthorized: false },
      max: process.env.NETLIFY ? 5 : 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      keepAlive: true
    });

    this.pool.on('error', (err) => {
      console.warn('Postgres pool notice (handled):', err.message);
    });
  }

  prepare(statement) {
    let parameterIndex = 0;
    const sql = statement
      .replace(/datetime\('now',\s*'(-?\d+) day'\)/gi, "(NOW() + INTERVAL '$1 day')")
      .replace(/datetime\(['"]now['"]\)/gi, 'NOW()')
      .replace(/\?/g, () => `$${++parameterIndex}`);

    const query = async (values) => {
      const mapped = values.map((value) => value === undefined ? null : value);
      try {
        return await this.pool.query(sql, mapped);
      } catch (err) {
        if (/timeout|connection|closed|econnreset/i.test(err.message || '')) {
          return await this.pool.query(sql, mapped);
        }
        throw err;
      }
    };

    return {
      all: async (...values) => (await query(values)).rows,
      get: async (...values) => (await query(values)).rows[0],
      run: async (...values) => {
        const insertSql = /^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql) ? `${sql} RETURNING id` : sql;
        const result = await query([insertSql, ...values]);
        // handle result
        const runRes = await (async () => {
          try {
            return await this.pool.query(insertSql, values.map((value) => value === undefined ? null : value));
          } catch (e) {
            if (/timeout|connection|closed|econnreset/i.test(e.message || '')) {
              return await this.pool.query(insertSql, values.map((value) => value === undefined ? null : value));
            }
            throw e;
          }
        })();
        return { changes: runRes.rowCount, lastInsertRowid: runRes.rows[0]?.id };
      }
    };
  }

  async exec(statement) {
    try {
      await this.pool.query(statement);
    } catch (e) {
      if (/timeout|connection|closed|econnreset/i.test(e.message || '')) {
        await this.pool.query(statement);
        return;
      }
      throw e;
    }
  }

  pragma() {}
}

module.exports = PostgresDatabase;