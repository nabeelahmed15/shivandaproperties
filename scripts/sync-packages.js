#!/usr/bin/env node
// Push the canonical turnkey package sheets (lib/package-specs.js) into the
// configured database: rates, badges and every accordion section and spec line.
// Safe to run repeatedly - packages are matched by name, then by order.

require('dotenv').config();

const { db, storageInfo, ensureTables } = require('../lib/db');
const { PACKAGE_PLANS, specRows } = require('../lib/package-specs');

function sameSheet(existing, rows) {
  if (existing.length !== rows.length) return false;
  return existing.every((spec, index) => {
    const row = rows[index];
    return (
      (spec.group_name || '') === (row.group_name || '') &&
      spec.label === row.label &&
      spec.content === row.content
    );
  });
}

async function main() {
  await ensureTables();

  const packages = await db.prepare('SELECT * FROM packages ORDER BY id').all();
  const used = new Set();
  const report = [];

  for (const [planIndex, plan] of PACKAGE_PLANS.entries()) {
    let target = packages.find((pkg) => !used.has(pkg.id) && pkg.name.toLowerCase() === plan.name.toLowerCase());
    if (!target) {
      const fallback = packages.filter((pkg) => !used.has(pkg.id))[planIndex] ||
        packages.find((pkg) => !used.has(pkg.id));
      target = fallback;
    }

    if (!target) {
      await db.prepare('INSERT INTO packages (name, rate, badge, active) VALUES (?, ?, ?, 1)')
        .run(plan.name, plan.rate, plan.badge);
      const inserted = await db.prepare('SELECT * FROM packages WHERE name = ? ORDER BY id DESC LIMIT 1').get(plan.name);
      target = inserted;
      report.push(`${plan.name}: created (₹${plan.rate}/sq ft)`);
    } else {
      used.add(target.id);
      const renamed = target.name !== plan.name ? `${target.name} -> ${plan.name}` : plan.name;
      await db.prepare('UPDATE packages SET name = ?, rate = ?, badge = ?, active = 1 WHERE id = ?')
        .run(plan.name, plan.rate, plan.badge, target.id);
      report.push(`${renamed}: ₹${plan.rate}/sq ft${plan.badge ? ` (${plan.badge})` : ''}`);
    }

    const rows = specRows(plan);
    const existing = await db.prepare('SELECT * FROM package_specs WHERE package_id = ? ORDER BY sort_order, id').all(target.id);
    if (sameSheet(existing, rows)) {
      report.push(`${plan.name}: sheet already current (${rows.length} specs)`);
      continue;
    }

    await db.prepare('DELETE FROM package_specs WHERE package_id = ?').run(target.id);
    for (const row of rows) {
      await db.prepare('INSERT INTO package_specs (package_id, group_name, label, content, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(target.id, row.group_name, row.label, row.content, row.sort_order);
    }
    report.push(`${plan.name}: ${rows.length} specs written in ${plan.groups.length} sections`);
  }

  // Duplicate rows left over from older seeds would show twice on the website.
  const leftovers = packages.filter((pkg) => !used.has(pkg.id) && PACKAGE_PLANS.some(
    (plan) => plan.name.toLowerCase() === pkg.name.toLowerCase()
  ));
  for (const leftover of leftovers) {
    await db.prepare('UPDATE packages SET active = 0 WHERE id = ?').run(leftover.id);
    report.push(`${leftover.name} (id ${leftover.id}, ₹${leftover.rate}): duplicate hidden (active = 0)`);
  }

  console.log(`Storage: ${storageInfo.label}`);
  report.forEach((line) => console.log(`  - ${line}`));

  const final = await db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY id').all();
  console.log('Active packages:', final.map((pkg) => `${pkg.name} ₹${pkg.rate}`).join(', '));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
