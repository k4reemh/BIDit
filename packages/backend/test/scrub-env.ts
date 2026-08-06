/**
 * Runs before every test file (vitest setupFiles). A dev machine with the AWS
 * CLI configured exports real AWS credentials, which would flip the email seam
 * live and make tests POST actual mail to SES. Tests always run in the no-op
 * (log-only) email mode.
 */
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_SESSION_TOKEN;
