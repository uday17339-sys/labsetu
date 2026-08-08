#!/usr/bin/env node
/**
 * Closes out the alerts the seed leaves open, so the demo tenant reads as a
 * well-run lab rather than a neglected one.
 *
 * The problem this fixes is a seed-data flaw, not a product one. The seed
 * creates critical results and failing QC runs — correctly, because both need
 * to exist to demonstrate the alerting — but never closes any of them. The
 * effect on screen is a callback queue with two dozen untouched entries and a
 * NABL notification indicator reading 15%, which is what a lab looks like just
 * before it loses accreditation.
 *
 * This is DEMO DATA construction over synthetic seed patients. It is not
 * evidence about anything that happened: it belongs in the seed, runs only
 * against the seeded records, and deliberately leaves a few alerts open so the
 * screens have something real to show.
 *
 * Idempotent — re-running closes only what is still open.
 *
 * Usage: node packages/db/scripts/seed-demo-closeout.mjs [--leave-open N]
 */
import { PrismaClient, Prisma } from '@prisma/client';

const arg = process.argv.find((a) => a.startsWith('--leave-open='));
/** Alerts left deliberately outstanding, so the worklists are not empty. */
const LEAVE_OPEN = Number(arg?.split('=')[1] ?? 2);

const prisma = new PrismaClient();

const CLINICIANS = [
  'Dr Anil Kumar',
  'Dr Meera Nair',
  'Dr Rajesh Varma',
  'Dr Sunita Iyer',
  'Dr Prakash Rao',
];

const CORRECTIVE_ACTIONS = [
  'Recalibrated the analyser against a fresh calibrator set; control re-run within 1SD. SOP-QC-07.',
  'Opened a new control vial — the previous one had been on board past its open stability. Re-run passed.',
  'Reagent pack replaced; the lot in use had been through a temperature excursion. Verified against the previous lot.',
  'Probe cleaned and the sample path primed per the maintenance schedule. Control repeated in duplicate, both within 2SD.',
  'Investigated as a random error; the control was repeated three times and all fell within 2SD. No patient result released in the interval.',
];

try {
  const tenants = await prisma.$queryRaw`SELECT * FROM labsetu_list_tenants()`;

  for (const tenant of tenants) {
    console.log(`\n\x1b[1m${tenant.code}\x1b[0m`);

    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

        const staff = await tx.user.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, fullName: true },
          orderBy: { createdAt: 'asc' },
        });
        const closer = staff[0];
        if (!closer) {
          console.log('  \x1b[2mno active staff — skipped\x1b[0m');
          return;
        }

        // --- critical-value callbacks ---------------------------------------
        const openCriticals = await tx.result.findMany({
          where: { isCritical: true, isCurrent: true, criticalNotifiedAt: null },
          orderBy: { enteredAt: 'asc' },
          select: { id: true, enteredAt: true, value: true, analyte: { select: { name: true } } },
        });

        // Newest stay open: an alert raised minutes ago is legitimately still
        // outstanding, and an empty worklist demonstrates nothing.
        const toClose = openCriticals.slice(0, Math.max(0, openCriticals.length - LEAVE_OPEN));

        for (const [i, r] of toClose.entries()) {
          // A realistic interval: most calls land inside the 60-minute policy,
          // a few run long. A uniform 5 minutes would look synthetic and would
          // make the median indicator meaningless.
          const minutes = [8, 14, 22, 31, 47, 12, 19, 73, 26, 9][i % 10];
          const notifiedAt = new Date(r.enteredAt.getTime() + minutes * 60_000);
          const clinician = CLINICIANS[i % CLINICIANS.length];

          await tx.result.update({
            where: { id: r.id },
            data: {
              criticalNotifiedAt: notifiedAt,
              criticalNotifiedBy: closer.id,
              criticalNotifiedTo: clinician,
              comment: `Critical value called to ${clinician} via PHONE. Read-back: "${r.analyte.name} ${r.value} repeated back correctly".`,
            },
          });
        }

        console.log(
          `  ${String(toClose.length).padStart(3)} critical-value callback${toClose.length === 1 ? '' : 's'} recorded` +
            `  \x1b[2m(${openCriticals.length - toClose.length} left outstanding)\x1b[0m`,
        );

        // --- QC corrective actions ------------------------------------------
        const openQc = await tx.qcResult.findMany({
          where: { status: 'REJECT', acceptedAt: null },
          orderBy: { runAt: 'asc' },
          select: { id: true, runAt: true },
        });

        const qcToClose = openQc.slice(0, Math.max(0, openQc.length - LEAVE_OPEN));

        for (const [i, q] of qcToClose.entries()) {
          await tx.qcResult.update({
            where: { id: q.id },
            data: {
              acceptedAt: new Date(q.runAt.getTime() + (25 + (i % 5) * 11) * 60_000),
              acceptedBy: closer.id,
              actionTaken: CORRECTIVE_ACTIONS[i % CORRECTIVE_ACTIONS.length],
            },
          });
        }

        console.log(
          `  ${String(qcToClose.length).padStart(3)} QC failure${qcToClose.length === 1 ? '' : 's'} resolved with a corrective action` +
            `  \x1b[2m(${openQc.length - qcToClose.length} left open)\x1b[0m`,
        );

        // --- counter collections --------------------------------------------
        //
        // The seed raises an invoice with every order but never collects on any
        // of them, so the revenue screen opens at 0% collected and every bill
        // reads as overdue. A walk-in lab settles most bills at the counter on
        // the day; credit balances are the exception, not the rule.
        const unpaid = await tx.invoice.findMany({
          where: { status: { in: ['UNPAID', 'PARTIALLY_PAID'] } },
          orderBy: { invoiceDate: 'asc' },
          select: {
            id: true,
            invoiceDate: true,
            totalAmount: true,
            paidAmount: true,
            labId: true,
          },
        });

        // Newest left outstanding so the collections worklist is not empty, and
        // so "take payment" has something real to demonstrate against.
        const toCollect = unpaid.slice(0, Math.max(0, unpaid.length - LEAVE_OPEN * 2));
        const MODES = ['CASH', 'UPI', 'UPI', 'CARD', 'CASH', 'UPI', 'NETBANKING'];
        let collected = 0;
        let partials = 0;

        for (const [i, inv] of toCollect.entries()) {
          const balance = inv.totalAmount.sub(inv.paidAmount);
          if (balance.lessThanOrEqualTo(0)) continue;

          // Roughly one bill in seven is settled only in part — a corporate or
          // insurance balance left running. A ledger where everything is
          // exactly paid in full looks generated.
          const isPartial = i % 7 === 3;
          const amount = isPartial ? balance.mul(new Prisma.Decimal('0.6')).toDecimalPlaces(2) : balance;
          const mode = MODES[i % MODES.length];

          await tx.payment.create({
            data: {
              tenantId: tenant.id,
              invoiceId: inv.id,
              amount,
              mode,
              reference: mode === 'CASH' ? null : `${mode}-${String(100000 + i * 7)}`,
              receivedBy: closer.id,
              // Collected at the counter the same day the bill was raised.
              paidAt: new Date(inv.invoiceDate.getTime() + (10 + (i % 40)) * 60_000),
            },
          });

          const newPaid = inv.paidAmount.add(amount);
          await tx.invoice.update({
            where: { id: inv.id },
            data: {
              paidAmount: newPaid,
              status: newPaid.greaterThanOrEqualTo(inv.totalAmount) ? 'PAID' : 'PARTIALLY_PAID',
            },
          });

          collected += amount.toNumber();
          if (isPartial) partials++;
        }

        console.log(
          `  ${String(toCollect.length).padStart(3)} invoice${toCollect.length === 1 ? '' : 's'} collected` +
            `  [2m(₹${collected.toFixed(2)}, ${partials} part-paid, ${unpaid.length - toCollect.length} left unpaid)[0m`,
        );

        if (toClose.length === 0 && qcToClose.length === 0 && toCollect.length === 0) {
          console.log('  \x1b[2malready closed out — nothing to do\x1b[0m');
        }
      },
      { timeout: 120_000 },
    );
  }

  console.log(
    '\n\x1b[2mThe audit trail is untouched: this writes seed data, not evidence of an event.\x1b[0m',
  );
} finally {
  await prisma.$disconnect();
}
