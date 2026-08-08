-- Pharmaceutical QC departments.
--
-- A pharma QC lab is organised by technique (chemical, instrumentation) rather
-- than by clinical discipline. Written by hand because ALTER TYPE ... ADD VALUE
-- is the whole change and a generated migration would be no clearer.
--
-- IF NOT EXISTS makes this safe to re-apply against a database that already has
-- them, which matters when the same migration runs across dev and production.
ALTER TYPE "LabDepartment" ADD VALUE IF NOT EXISTS 'CHEMICAL';
ALTER TYPE "LabDepartment" ADD VALUE IF NOT EXISTS 'INSTRUMENTATION';
ALTER TYPE "LabDepartment" ADD VALUE IF NOT EXISTS 'PACKAGING_DEVELOPMENT';
ALTER TYPE "LabDepartment" ADD VALUE IF NOT EXISTS 'STABILITY';
