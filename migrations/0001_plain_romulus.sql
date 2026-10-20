CREATE TABLE `abstract_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`reviewer_id` text NOT NULL,
	`abstract_id` text NOT NULL,
	`submission_version` integer DEFAULT 1 NOT NULL,
	`relevance` integer NOT NULL,
	`originality` integer NOT NULL,
	`clarity` integer NOT NULL,
	`rigour` integer NOT NULL,
	`impact` integer NOT NULL,
	`recommendation` text NOT NULL,
	`author_feedback` text NOT NULL,
	`confidential_notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `abstract_reviews_reviewer_abstract_version_idx` ON `abstract_reviews` (`reviewer_id`,`abstract_id`,`submission_version`);--> statement-breakpoint
CREATE TABLE `abstracts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`authors` text NOT NULL,
	`affiliations` text NOT NULL,
	`category` text NOT NULL,
	`keywords` text NOT NULL,
	`body` text NOT NULL,
	`presentation` text NOT NULL,
	`project_id` text,
	`attachment_id` text,
	`public_consent` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`decision_note` text DEFAULT '' NOT NULL,
	`award` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`submission_type` text NOT NULL,
	`submission_id` text NOT NULL,
	`submission_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'assigned' NOT NULL,
	`decline_reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_user_submission_version_idx` ON `assignments` (`user_id`,`submission_type`,`submission_id`,`submission_version`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`object_key` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_grants_user_role_idx` ON `role_grants` (`user_id`,`role`);--> statement-breakpoint
DROP INDEX `scores_judge_project_idx`;--> statement-breakpoint
ALTER TABLE `scores` ADD `submission_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `scores_judge_project_idx` ON `scores` (`judge_id`,`project_id`,`submission_version`);--> statement-breakpoint
ALTER TABLE `projects` ADD `attachment_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `public_consent` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `version` integer DEFAULT 1 NOT NULL;