# PostgreSQL Backup and Restore Runbook

Status: operational procedure draft; no managed database, backup schedule, KMS key, or restore drill has been provisioned.

## Backup requirements

- Use a dedicated least-privilege backup identity; never use the application runtime identity for backup administration.
- Store backups outside the database host and account boundary where possible.
- Encrypt backup objects with the cloud provider KMS key (or an approved envelope-encryption service). Do not place encryption keys or database credentials in the repository, command history, CI logs, or chat.
- Enable managed point-in-time recovery / continuous WAL archiving when the selected provider supports it.
- Define and approve retention, recovery-point objective (RPO), and recovery-time objective (RTO) before production launch.
- Alert on missed backups, failed exports, storage growth, and backup-age thresholds.

## Logical backup

Run from an approved, network-restricted operations environment. Supply credentials through the secret manager or PGPASSFILE, not inline in the command.

```bash
umask 077
pg_dump --format=custom --no-owner --no-acl --file="$BACKUP_DIR/outlet-window-$(date -u +%Y%m%dT%H%M%SZ).dump" "$DATABASE_URL"
```

Immediately encrypt the dump using the approved KMS-backed process and upload the encrypted artifact to the designated private backup bucket. Verify object checksum, encryption metadata, and retention policy. Delete unencrypted temporary files after verification.

## Restore drill

1. Create an isolated, access-restricted restore database; never test by overwriting production.
2. Retrieve and decrypt a selected backup using the approved KMS identity.
3. Restore with `pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"`.
4. Run the versioned migrations only if the recovery procedure requires bringing the restored schema forward; do not blindly replay migrations against a current backup.
5. Verify schema migration versions, identity/session referential integrity, row counts, tenant isolation tests, and application readiness.
6. Record restore start/end time, backup timestamp, data-loss window, validation results, and operator approval.
7. Remove the isolated database and temporary plaintext files according to the approved data-handling policy.

## Production acceptance checklist

- [ ] Managed PostgreSQL instance and private network access provisioned.
- [ ] KMS encryption key, rotation policy, and least-privilege backup role configured.
- [ ] Automated snapshots and point-in-time recovery configured.
- [ ] Retention and RPO/RTO approved by the owner.
- [ ] Backup success/failure alerts tested.
- [ ] First isolated restore drill completed and timed.
- [ ] Restore evidence and responsible operator recorded.

This runbook documents the procedure only. It does not create backups, enable provider snapshots, configure KMS, or prove recoverability until the checklist is executed in the selected cloud account.
