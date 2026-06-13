# Changelog

All notable changes to the **SQL Server Agent Jobs** extension are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.9.1] — 2026-06-13

### Fixed
- **Job editor failed to load with _"Invalid column name 'type'"_.** The alerts
  query selected a `type` column from `msdb.dbo.sysalerts`, but that column only
  exists in `sp_help_alert`'s result set, not the base table — so the error broke
  the entire job load. The alert trigger is now derived from
  `performance_condition` / `severity` / `message_id` instead.

## [0.9.0] — 2026-06-13

### Added
- **Notifications** in the job editor — e-mail an operator and/or write to the
  Windows Application event log on success, failure, or completion. Operators are
  read live from `msdb.dbo.sysoperators`, and settings are saved through
  `sp_update_job`.
- E-mail notification can also be set up while **creating a new job**.
- **Alerts** section (read-only) listing the SQL Agent alerts that run a job when
  they fire, with each alert's trigger and operator notification methods.

## [0.8.0] — 2026-06-13

### Added
- The connected **SQL Server instance** now sits at the root of the tree, with all
  jobs nested beneath it.
- Create a **New Job** from the instance row, the view title bar, or the dashboard.

## [0.7.2]

### Added
- **Next job** navigation in the job editor.

### Changed
- Redrew the activity bar icon to match the marketplace icon.

## [0.7.1]

### Added
- **Back to dashboard** navigation on the job editor page.

## [0.7.0]

### Added
- Initial release: dashboard with run statistics, job tree with live status, and a
  full editor for job options, schedules, and steps.

[0.9.1]: https://github.com/vmatausic/mssql-agent-jobs/releases
[0.9.0]: https://github.com/vmatausic/mssql-agent-jobs/releases
[0.8.0]: https://github.com/vmatausic/mssql-agent-jobs/releases
[0.7.2]: https://github.com/vmatausic/mssql-agent-jobs/releases
[0.7.1]: https://github.com/vmatausic/mssql-agent-jobs/releases
[0.7.0]: https://github.com/vmatausic/mssql-agent-jobs/releases
