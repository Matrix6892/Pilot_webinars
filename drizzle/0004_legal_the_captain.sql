ALTER TABLE `order_result_history` ADD `result_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_result_history` ADD `inventory_snapshot_json` text;--> statement-breakpoint
ALTER TABLE `order_result_history` ADD `agent_model` text;--> statement-breakpoint
ALTER TABLE `order_result_history` ADD `reviewer_model` text;--> statement-breakpoint
ALTER TABLE `order_result_history` ADD `source_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `order_result_history_source_key_idx` ON `order_result_history` (`order_id`,`source_key`);