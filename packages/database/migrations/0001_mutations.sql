CREATE TABLE "mutations" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mutations" ADD CONSTRAINT "mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mutations_user_created_idx" ON "mutations" USING btree ("user_id","created_at");