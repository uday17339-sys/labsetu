-- Part 11 §11.300: password aging, reuse prevention, and periodic access review.
--
-- password_history keeps only hashes. It cannot authenticate anyone; its sole
-- purpose is answering "has this password been used before".
CREATE TABLE "password_history" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "password_history_tenantId_userId_changedAt_idx"
    ON "password_history"("tenantId", "userId", "changedAt");

ALTER TABLE "password_history"
    ADD CONSTRAINT "password_history_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- access_review records that somebody examined who holds what, and when.
CREATE TABLE "access_review" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "reviewedBy" UUID NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userCount" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "actions" TEXT,

    CONSTRAINT "access_review_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "access_review_tenantId_reviewedAt_idx"
    ON "access_review"("tenantId", "reviewedAt");
