CREATE TABLE `inventory_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sku` text NOT NULL,
	`revision` integer NOT NULL,
	`before_stock_kg` integer NOT NULL,
	`after_stock_kg` integer NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "inventory_changes_revision_check" CHECK("inventory_changes"."revision" >= 1),
	CONSTRAINT "inventory_changes_before_stock_kg_check" CHECK("inventory_changes"."before_stock_kg" >= 0),
	CONSTRAINT "inventory_changes_after_stock_kg_check" CHECK("inventory_changes"."after_stock_kg" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_changes_sku_revision_idx` ON `inventory_changes` (`sku`,`revision`);--> statement-breakpoint
CREATE INDEX `inventory_changes_created_at_idx` ON `inventory_changes` (`created_at`);--> statement-breakpoint
CREATE TABLE `inventory_items` (
	`sku` text PRIMARY KEY NOT NULL,
	`stock_kg` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "inventory_items_stock_kg_check" CHECK("inventory_items"."stock_kg" >= 0),
	CONSTRAINT "inventory_items_revision_check" CHECK("inventory_items"."revision" >= 1)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `inventory_items` (`sku`, `stock_kg`, `revision`) VALUES
	('КР-001', 300, 1),
	('КР-002', 900, 1),
	('КР-003', 420, 1),
	('КР-004', 1260, 1),
	('КР-005', 180, 1);
--> statement-breakpoint
ALTER TABLE `orders` ADD `attachment_json` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `conversation_json` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `round_no` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `inventory_snapshot_json` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `manager_option_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `manager_decided_at` text;
