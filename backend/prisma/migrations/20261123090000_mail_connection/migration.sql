-- CreateTable
CREATE TABLE "MailConnection" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "account" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailConnection_pkey" PRIMARY KEY ("id")
);
