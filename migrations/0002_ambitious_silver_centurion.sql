CREATE TABLE `role_allowlist` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_allowlist_email_role_idx` ON `role_allowlist` (`email`,`role`);