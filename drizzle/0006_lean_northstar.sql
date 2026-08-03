ALTER TABLE `orders` ADD `claim_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `claimed_by` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `attempt_no` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `lease_until` text;--> statement-breakpoint
CREATE INDEX `orders_status_lease_until_idx` ON `orders` (`status`,`lease_until`);