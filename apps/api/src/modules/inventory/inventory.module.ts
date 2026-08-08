import {
  Body,
  Controller,
  Get,
  Global,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS, reasonSchema } from '@labsetu/contracts';
import { InventoryService } from './inventory.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';

const receiveSchema = z.object({
  itemId: z.string().uuid(),
  lotNumber: z.string().trim().min(1).max(60),
  quantity: z.coerce.number().positive(),
  expiryDate: z.coerce.date().optional(),
  supplier: z.string().trim().max(120).optional(),
  invoiceRef: z.string().trim().max(60).optional(),
  unitCost: z.coerce.number().nonnegative().optional(),
  openStabilityDays: z.coerce.number().int().positive().optional(),
});

const consumeSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  lotId: z.string().uuid().optional(),
  sampleTestId: z.string().uuid().optional(),
  reason: z.string().trim().max(300).optional(),
});

const adjustSchema = z.object({
  quantity: z.coerce.number().nonnegative(),
  reason: reasonSchema,
});

const disposeSchema = z.object({ reason: reasonSchema });

const createItemSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(150),
  category: z.enum(['REAGENT', 'CONTROL', 'CALIBRATOR', 'CONSUMABLE', 'OTHER']),
  unit: z.string().trim().min(1).max(20),
  manufacturer: z.string().trim().max(120).optional(),
  catalogNumber: z.string().trim().max(60).optional(),
  reorderLevel: z.coerce.number().nonnegative().optional(),
  storageCondition: z.string().trim().max(60).optional(),
});

const usageSchema = z.object({
  testDefinitionId: z.string().uuid(),
  inventoryItemId: z.string().uuid(),
  quantityPerTest: z.coerce.number().positive(),
});

@Controller({ path: 'inventory', version: '1' })
class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get('items')
  items(@Query('category') category?: string) {
    return this.inventory.listItems(category);
  }

  /** Expiries, near-expiries and reorder levels — what needs attention today. */
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get('alerts')
  alerts() {
    return this.inventory.alerts();
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get('lots/:id/history')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.lotHistory(id);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('items')
  createItem(@Body(zodPipe(createItemSchema)) body: z.infer<typeof createItemSchema>) {
    return this.inventory.createItem(body);
  }

  /** Links a reagent to a test so running it decrements stock automatically. */
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('usage')
  setUsage(@Body(zodPipe(usageSchema)) body: z.infer<typeof usageSchema>) {
    return this.inventory.setTestUsage(body);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('receive')
  receive(@Body(zodPipe(receiveSchema)) body: z.infer<typeof receiveSchema>) {
    return this.inventory.receive(body);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_CONSUME)
  @Post('consume')
  consume(@Body(zodPipe(consumeSchema)) body: z.infer<typeof consumeSchema>) {
    return this.inventory.consume(body);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('lots/:id/adjust')
  adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(adjustSchema)) body: { quantity: number; reason: string },
  ) {
    return this.inventory.adjust(id, body.quantity, body.reason);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('lots/:id/dispose')
  dispose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(disposeSchema)) body: { reason: string },
  ) {
    return this.inventory.dispose(id, body.reason);
  }
}

/** Global: ResultsService consumes reagents automatically on result entry. */
@Global()
@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
