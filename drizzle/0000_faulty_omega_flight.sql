CREATE TABLE `deliverables` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text DEFAULT '链接' NOT NULL,
	`label` text,
	`url` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_deliverables_task_id` ON `deliverables` (`task_id`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`actor` text NOT NULL,
	`event_type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_events_task_created` ON `task_events` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`assignee` text NOT NULL,
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
	`rework_count` integer DEFAULT 0 NOT NULL,
	`is_paused` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`submitted_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_assignee_planned_date` ON `tasks` (`assignee`,`planned_date`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_updated_at` ON `tasks` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `work_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`assignee` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_work_sessions_task_id` ON `work_sessions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_work_sessions_assignee_started_at` ON `work_sessions` (`assignee`,`started_at`);