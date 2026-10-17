const { Pool } = require('pg');

class PostgresDatabase {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: process.env.NETLIFY ? 5 : 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      keepAlive: true
    });

    this.pool.on('error', (err) => {
      console.warn('Postgres pool error (handled):', err.message);
    });
  }

  prepare(statement) {
    let parameterIndex = 0;
    const sql = statement
      .replace(/datetime\('now',\s*'(-?\d+) day'\)/gi, "(NOW() + INTERVAL '$1 day')")
      .replace(/datetime\(['"]now['"]\)/gi, 'NOW()')
      .replace(/\?/g, () => `$${++parameterIndex}`);

    const query = async (values) => {
      const result = await this.pool.query(sql, values.map((value) => value === undefined ? null : value));
      return result;
    };

    return {
      all: async (...values) => (await query(values)).rows,
      get: async (...values) => (await query(values)).rows[0],
      run: async (...values) => {
        const insertSql = /^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql) ? `${sql} RETURNING id` : sql;
        const result = await this.pool.query(insertSql, values.map((value) => value === undefined ? null : value));
        return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
      }
    };
  }

  async exec(statement) {
    await this.pool.query(statement);
  }

  pragma() {}
}

module.exports = PostgresDatabase;