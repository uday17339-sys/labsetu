import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@labsetu/db';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Read access to the versioned reference data: tests, panels, analytes and the
 * supporting lists the front desk and bench screens need.
 *
 * Reference-range resolution lives here too, because it is catalog logic rather
 * than result logic — and because getting it wrong produces a clinically wrong
 * report rather than a visible error.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listTests(department?: string) {
    return this.prisma.tx.testDefinition.findMany({
      where: { isActive: true, ...(department ? { department: department as never } : {}) },
      orderBy: [{ department: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        shortName: true,
        department: true,
        version: true,
        price: true,
        tatMinutes: true,
        instructions: true,
        requiresVerification: true,
        specimenType: { select: { id: true, code: true, name: true } },
        containerType: { select: { id: true, code: true, name: true, colour: true } },
        method: { select: { code: true, name: true } },
        analytes: {
          orderBy: { sortOrder: 'asc' },
          select: {
            sortOrder: true,
            formula: true,
            analyte: {
              select: {
                id: true,
                code: true,
                name: true,
                valueType: true,
                defaultUnit: true,
                precision: true,
                allowedValues: true,
              },
            },
          },
        },
      },
    });
  }

  async listPanels() {
    return this.prisma.tx.panel.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        price: true,
        items: {
          orderBy: { sortOrder: 'asc' },
          select: {
            testDefinition: { select: { id: true, code: true, name: true, price: true } },
          },
        },
      },
    });
  }

  async referenceData() {
    const tx = this.prisma.tx;
    const [specimenTypes, containerTypes, rejectionReasons, labs, doctors, devices] =
      await Promise.all([
        tx.specimenType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
        tx.containerType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
        tx.rejectionReason.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
        tx.lab.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
        tx.referringDoctor.findMany({
          where: { isActive: true },
          orderBy: { name: 'asc' },
          select: { id: true, code: true, name: true, speciality: true },
        }),
        tx.device.findMany({
          where: { isActive: true },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            code: true,
            name: true,
            department: true,
            status: true,
            isShadowMode: true,
            lastMessageAt: true,
          },
        }),
      ]);

    return { specimenTypes, containerTypes, rejectionReasons, labs, doctors, devices };
  }

  /**
   * Selects the reference range in force for an analyte, given the patient's sex
   * and age in days.
   *
   * Specificity order matters: a range restricted by both sex and age band beats
   * one restricted by only sex, which beats a general one. Picking the wrong one
   * produces a report that looks right and is clinically wrong, which is the
   * worst failure mode in this system — hence the explicit scoring rather than
   * relying on query ordering.
   */
  async resolveReferenceRange(
    tx: Prisma.TransactionClient,
    analyteId: string,
    sex: string,
    ageDays: number | null,
    at: Date = new Date(),
  ) {
    const candidates = await tx.referenceRange.findMany({
      where: {
        analyteId,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
    });

    const applicable = candidates.filter((r) => {
      if (r.sex !== null && r.sex !== sex) return false;
      if (ageDays !== null) {
        if (r.minAgeDays !== null && ageDays < r.minAgeDays) return false;
        if (r.maxAgeDays !== null && ageDays > r.maxAgeDays) return false;
      } else if (r.minAgeDays !== null || r.maxAgeDays !== null) {
        // Age-banded range but no known age: not safely applicable.
        return false;
      }
      return true;
    });

    if (applicable.length === 0) return null;

    const score = (r: (typeof applicable)[number]) =>
      (r.sex !== null ? 2 : 0) + (r.minAgeDays !== null || r.maxAgeDays !== null ? 1 : 0);

    return applicable.sort((a, b) => score(b) - score(a))[0]!;
  }

  async getTestOrThrow(id: string) {
    const test = await this.prisma.tx.testDefinition.findUnique({
      where: { id },
      include: { analytes: { include: { analyte: true }, orderBy: { sortOrder: 'asc' } } },
    });
    if (!test) throw new NotFoundException('Test not found');
    return test;
  }
}
