-- Messenger conversations (page DMs) + messages

-- CreateTable
CREATE TABLE "social_conversations" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "participant_id" TEXT,
    "participant_name" TEXT NOT NULL,
    "snippet" TEXT,
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "can_reply" BOOLEAN NOT NULL DEFAULT true,
    "last_customer_message_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3) NOT NULL,
    "status" "SocialCommentStatus" NOT NULL DEFAULT 'NEW',
    "ai_draft" TEXT,
    "ai_draft_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "from_id" TEXT,
    "from_name" TEXT,
    "is_page" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT NOT NULL,
    "attachments" JSONB,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_conversations_account_id_external_id_key" ON "social_conversations"("account_id", "external_id");

-- CreateIndex
CREATE INDEX "social_conversations_status_idx" ON "social_conversations"("status");

-- CreateIndex
CREATE INDEX "social_conversations_last_message_at_idx" ON "social_conversations"("last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "social_messages_external_id_key" ON "social_messages"("external_id");

-- CreateIndex
CREATE INDEX "social_messages_conversation_id_idx" ON "social_messages"("conversation_id");

-- CreateIndex
CREATE INDEX "social_messages_sent_at_idx" ON "social_messages"("sent_at");

-- AddForeignKey
ALTER TABLE "social_conversations" ADD CONSTRAINT "social_conversations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_messages" ADD CONSTRAINT "social_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "social_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
