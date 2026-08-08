import { Module, Global } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CatalogAdminService } from './catalog-admin.service';
import { CatalogController } from './catalog.controller';

/** Global: reference-range resolution is needed by results and ingest alike. */
@Global()
@Module({
  controllers: [CatalogController],
  providers: [CatalogService, CatalogAdminService],
  exports: [CatalogService],
})
export class CatalogModule {}
