CREATE TABLE `order_result_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`round_no` integer DEFAULT 1 NOT NULL,
	`zone` text NOT NULL,
	`route` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`reply_subject` text DEFAULT '' NOT NULL,
	`reply_body` text DEFAULT '' NOT NULL,
	`zone_reason` text DEFAULT '' NOT NULL,
	`options_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `order_result_history_order_id_idx` ON `order_result_history` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_result_history_created_at_idx` ON `order_result_history` (`created_at`);