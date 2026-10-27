-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_account_id_key_key" ON "idempotency_keys"("account_id", "key");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity: keys are never blank, and replay records are immutable like the ledger they protect.
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_key_not_blank" CHECK (length(btrim("key")) > 0);

CREATE TRIGGER "idempotency_keys_immutable"
  BEFORE UPDATE OR DELETE ON "idempotency_keys"
  FOR EACH ROW EXECUTE FUNCTION "prevent_ledger_mutation"();
