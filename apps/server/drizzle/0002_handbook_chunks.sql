CREATE TABLE "handbook_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_url" text NOT NULL,
	"page_title" text NOT NULL,
	"section" text NOT NULL,
	"url" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer NOT NULL,
	"page_hash" text NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handbook_chunks_page_chunk_unique" UNIQUE("page_url","chunk_index")
);
--> statement-breakpoint
CREATE INDEX "handbook_chunks_embedding_idx" ON "handbook_chunks" USING hnsw ("embedding" vector_cosine_ops);