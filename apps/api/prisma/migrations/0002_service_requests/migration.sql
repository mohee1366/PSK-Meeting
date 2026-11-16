CREATE TYPE "ServiceRequestType" AS ENUM ('CATERING','CLEANING','MAINTENANCE','OTHER');
CREATE TYPE "ServiceRequestStatus" AS ENUM ('OPEN','IN_PROGRESS','DONE','REJECTED');
CREATE TABLE "ServiceRequest" (
  "id" TEXT PRIMARY KEY,
  "type" "ServiceRequestType" NOT NULL,
  "status" "ServiceRequestStatus" NOT NULL DEFAULT 'OPEN',
  "description" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3),
  "requesterId" TEXT NOT NULL REFERENCES "User"("id"),
  "roomId" TEXT NOT NULL REFERENCES "Room"("id"),
  "siteId" TEXT NOT NULL REFERENCES "Site"("id"),
  "reservationId" TEXT REFERENCES "Reservation"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ServiceRequest_siteId_status_createdAt_idx" ON "ServiceRequest"("siteId","status","createdAt");
CREATE INDEX "ServiceRequest_requesterId_createdAt_idx" ON "ServiceRequest"("requesterId","createdAt");
