CREATE TABLE `bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmarks_user_session_idx` ON `bookmarks` (`user_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`project_id` text,
	`opportunity_id` text,
	`message` text NOT NULL,
	`next_action` text DEFAULT '' NOT NULL,
	`due_date` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feedback` (
	`user_id` text PRIMARY KEY NOT NULL,
	`learning` text NOT NULL,
	`next_step` text NOT NULL,
	`rating` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`details` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`organisation` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'attendee' NOT NULL,
	`attendance` text DEFAULT 'in_person' NOT NULL,
	`interests` text DEFAULT '' NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`share_contact` integer DEFAULT 0 NOT NULL,
	`registered_at` text,
	`checked_in_at` text,
	`pass_code` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_pass_code_idx` ON `profiles` (`pass_code`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`team` text NOT NULL,
	`category` text NOT NULL,
	`problem` text NOT NULL,
	`solution` text NOT NULL,
	`stage` text NOT NULL,
	`support` text NOT NULL,
	`demo_url` text DEFAULT '' NOT NULL,
	`business_model` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`award` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`body` text NOT NULL,
	`anonymous` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scores` (
	`id` text PRIMARY KEY NOT NULL,
	`judge_id` text NOT NULL,
	`project_id` text NOT NULL,
	`relevance` integer NOT NULL,
	`innovation` integer NOT NULL,
	`feasibility` integer NOT NULL,
	`business` integer NOT NULL,
	`impact` integer NOT NULL,
	`feedback` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scores_judge_project_idx` ON `scores` (`judge_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`sort_order` integer NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`lead` text NOT NULL,
	`outcome` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `votes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`question_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `votes_user_question_idx` ON `votes` (`user_id`,`question_id`);