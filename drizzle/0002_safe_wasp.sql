ALTER TABLE `tasks` ADD `art_progress_url` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `art_final_url` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `art_source_url` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `test_planned_cases` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `test_actual_cases` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `test_new_bugs` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `test_valid_bugs` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `test_regression_bugs` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `test_severe_bugs` integer;--> statement-breakpoint
CREATE INDEX `idx_tasks_planned_date` ON `tasks` (`planned_date`);--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `art_requirements`;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `art_reference_url`;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `test_scope`;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `test_environment`;--> statement-breakpoint
PRAGMA optimize;
