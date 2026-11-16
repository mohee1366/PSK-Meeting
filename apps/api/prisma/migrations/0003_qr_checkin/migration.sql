CREATE TABLE "QrCheckIn" (
  "id" TEXT PRIMARY KEY,
  "reservationId" TEXT NOT NULL UNIQUE REFERENCES "Reservation"("id"),
  "nonce" TEXT NOT NULL UNIQUE,
  "checkedById" TEXT NOT NULL REFERENCES "User"("id"),
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "QrCheckIn_checkedById_checkedAt_idx" ON "QrCheckIn"("checkedById","checkedAt");
