PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`assignee` text,
	`title` text NOT NULL,
	`type` text DEFAULT '其他' NOT NULL,
	`status` text DEFAULT '今日待办' NOT NULL,
	`priority` text DEFAULT '普通' NOT NULL,
	`planned_date` text,
	`deadline_at` integer,
	`estimated_minutes` integer NOT NULL,
	`planned_points` real NOT NULL,
	`deliverable_expectation` text,
	`acceptance_criteria` text,
	`result_summary` text,
	`acceptance_result` text,
	`blocked_reason` text,
	`notes` text,
	`art_requirements` text,
	`art_reference_url` text,
	`test_scope` text,
	`test_environment` text,
	`rework_count` integer DEFAULT 0 NOT NULL,
	`is_paused` integer DEFAULT false NOT NULL,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`submitted_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "assignee", "title", "type", "status", "priority", "planned_date", "deadline_at", "estimated_minutes", "planned_points", "deliverable_expectation", "acceptance_criteria", "result_summary", "acceptance_result", "blocked_reason", "notes", "art_requirements", "art_reference_url", "test_scope", "test_environment", "rework_count", "is_paused", "claimed_at", "created_at", "updated_at", "submitted_at", "completed_at") SELECT "id", "assignee", "title", "type", "status", "priority", "planned_date", "deadline_at", "estimated_minutes", "planned_points", "deliverable_expectation", "acceptance_criteria", "result_summary", "acceptance_result", "blocked_reason", "notes", NULL, NULL, NULL, NULL, "rework_count", "is_paused", NULL, "created_at", "updated_at", "submitted_at", "completed_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_tasks_assignee_planned_date` ON `tasks` (`assignee`,`planned_date`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_updated_at` ON `tasks` (`status`,`updated_at`);--> statement-breakpoint
PRAGMA optimize;
