# TaskForge

TaskForge is a private, local-first desktop workspace for organizing tasks, planning a daily schedule, using Pomodoro focus sessions, and reviewing productivity analytics.

## Features

- **Local profiles:** Keep separate workspaces for different areas of life on the same device. Each profile owns its tasks, schedule, habits, goals, focus history, and appearance settings. Profiles support a name, color avatar, optional 4–8 digit PIN, and an in-app lock screen. Existing v2 data is migrated automatically into a **Default** profile.
- **Dashboard:** Live local clock and date, task counts, today's tasks, today's schedule, and focus summaries.
- **Tasks:** Create, edit, complete, reopen, search, filter, and delete tasks with priority and optional due dates.
- **Recurring tasks and activities:** Daily, selected-weekday weekly, monthly, and custom intervals. Every occurrence has its own completion and skip state. Edit one occurrence or this and future unfinished occurrences, restore a skipped occurrence, or end a series after the selected occurrence without losing completed/skipped history. Schedule overlap confirmation checks every occurrence, not just the first.
- **Undo and redo:** Every task and schedule change — including quick capture and bulk actions — can be undone with **Ctrl+Z** and redone with **Ctrl+Y** or **Ctrl+Shift+Z**, from the top-bar buttons, or from the command palette. History is per profile, lives only for the current app session, and holds up to 20 steps (25 MB total).
- **Bulk actions:** Select tasks or activities with row checkboxes to complete, delete, or reschedule up to 1,000 items at once. Each bulk action is atomic and counts as one undo step. Bulk delete skips recurring occurrences instead of removing them; bulk reschedule shifts reminders with the due date and leaves recurring occurrences to their editor.
- **Drag to schedule:** Drag a task onto the dashboard's today panel or the schedule timeline to open a prefilled activity dialog, or use **Add to schedule…** in task details. The schedule view lists pending tasks in a "Tasks to schedule" strip. Overlap confirmation works exactly as for manually created activities.
- **Quick capture:** Press **Ctrl+Alt+N** anywhere while TaskForge is running, or choose **Quick capture** from the system tray. Type a title and press Enter to save a medium-priority task to the active profile. Existing editing drafts stay intact, and locked profiles require their PIN first. Shortcut conflicts are reported in Settings; the tray remains available.
- **System tray:** Closing the window hides it to the tray, keeping capture and timers available. Choose **Open TaskForge** to return or **Quit TaskForge** to exit completely. Only one app instance can own the same data directory.
- **Schedule:** Create and manage dated activities, navigate between days, detect overlapping activities, and view a live timeline.
- **Habits:** Track daily or selected-weekday routines, dated completions, current and longest streaks, and weekly/monthly history. Archived habits retain their completion history.
- **Goals:** Track short- and long-term goals, deadlines, priority, manual or milestone-based progress, and completed/archived goal history.
- **Focus timer:** Focus, short-break, and long-break sessions with pause, resume, reset, skip, custom durations, session statistics, and native desktop notifications. Running and paused sessions survive application restarts for every profile. A running session uses its original deadline; if it finishes while the app is closed, it is credited once and the next session waits paused.
- **Smart reminders:** Native notifications for task deadlines/custom reminders, activities, scheduled habits, goal deadlines, and focus completion. Per-category switches and local-time schedules are configurable in Settings; reminders missed by more than 15 minutes are skipped, and delivery IDs persist across restarts.
- **Notification center and snoozes:** The top-bar bell shows an unread badge and opens two tabs. **Upcoming** lists enabled reminders for the next seven days; **Recent** keeps a per-profile inbox of delivered reminders with read state, mark-all-read, and clear-history controls. Each reminder can be opened, completed (task or activity), marked done today (habit), or snoozed for 10 minutes, 1 hour, or 09:00 tomorrow. Snoozing suppresses the original toast and re-fires once at the chosen time, and unsnoozing restores normal delivery. Clicking a native toast restores the window and opens the reminder's target.
- **Calendar and spreadsheet export:** Export the active profile's schedule and dated tasks as an RFC 5545 iCalendar file, or export tasks and schedule items as UTF-8 CSV. Calendar events keep local wall-clock times, carry categories and reminder alarms, and mark completed items. CSV files include recurrence summaries, skip state, and timestamps; spreadsheet formula prefixes are neutralized.
- **Accessibility and input support:** A skip link, focusable main landmark, labelled dialogs, item-specific control names, polite/assertive status announcements, page titles, and keyboard navigation work throughout the workspace. Reduced-motion preferences disable transitions and animation, forced-colors mode keeps focus and state indicators visible, and every icon-only control exposes an accessible name.
- **Universal search:** Search task, activity, habit, goal, and upcoming reminder titles, descriptions, categories, and statuses. Filter by type, navigate results with the keyboard, and revisit up to six explicitly submitted or selected recent searches.
- **Analytics:** Daily statistics, current-week charts (Monday through Sunday), habit completion and streak summaries, goal statistics, and a transparent productivity score.
- **Settings:** Dark, Light, Toxic Green, Crimson Reactor, Cyber Blue, Purple Haze, Solar Flare, and Arctic Frost themes with persistent accent color, glow, density, card shape, animation, and background-effect controls; clock and notification preferences with a **Send test notification** button; focus durations; per-profile backup/restore plus calendar and CSV export; searchable keyboard shortcut reference; application information; and an explicit current-profile data reset.
- **Keyboard shortcuts:** Ctrl+K search, Ctrl+N new task, Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo, Ctrl+Shift+H habits, Ctrl+Shift+G goals, Ctrl+, settings, Ctrl+Shift+A new activity, Ctrl+Shift+P command palette, and Escape to close the topmost dialog or clear/exit search.
- **Command palette:** Press Ctrl+Shift+P to search and run navigation, quick-action, and appearance commands. Arrow keys, Enter, and mouse selection are supported; recent history stores only command IDs.
- **Branding:** Reusable TaskForge SVG wordmark and sidebar mark, a matching 256px PNG, and a multi-size Windows ICO used by the Electron window and Windows packaging.
- **Creator signature:** “Designed & Developed by AnonymousVillain35” appears unobtrusively in About and the dashboard footer, styled by the active theme.
- **Backup and restore:** Versioned JSON exports contain the active profile's tasks, schedules, focus statistics/preferences, habits and completion history, goals and milestones, and application settings. Restore validates the file, requests confirmation, creates a safety backup, and rolls back failed writes.

## Recurrence behavior

- A series needs a task due date or activity date. Choose an end count (1–1,000, default 30) or an inclusive end date within five years. Intervals range from 1 to 365 days, weeks, or months; weekly rules can select several weekdays. A series is finite, not endless.
- Occurrences are generated once and saved atomically with stable identifiers. Reopening the app does not duplicate or regenerate them. Existing one-off records need no data rewrite.
- Weekly intervals use Sunday-based calendar weeks. Monthly series skip months without the anchor day (January 31 continues on March 31). Calendar-date generation is independent of daylight-saving transitions. Activity times and recurring task reminders keep local clock time; nonexistent reminder times in a spring-forward gap advance by the clock gap, and ambiguous fall-back times use the earlier offset.
- Single-occurrence edits keep that occurrence's original series identity. Future edits start from the selected unfinished occurrence, cannot move the segment before its original date, preserve earlier/completed/skipped history, and reuse matching occurrence IDs. The count applies to the new unfinished segment, excluding preserved history; the entire series remains limited to 1,000 records.
- **Skip** replaces Delete for recurring items and can be reversed. Skipped items stay visible in history but do not send reminders, occupy schedule time, or count as pending/productivity work. A skipped activity cannot be restored into a conflict; change its time first. Completed occurrences must be reopened before skipping.
- **End series after this occurrence** keeps the selected occurrence and historical records, removes later unfinished occurrences, and prevents further series regeneration. Individual retained records remain editable. Export a backup before ending a series if you might need its future occurrences again.

## Undo and bulk editing

- Undo history tracks task and schedule datasets only; habits, goals, focus timers, and settings are not undoable. History is kept in memory for the current session and profile: it is cleared by restarting the app, switching or creating a profile, restoring a backup, or resetting data, and it is unavailable while the profile is locked.
- Each entry stores full before/after snapshots, capped at 20 entries and 25 MB total (oldest entries drop first; a single change larger than the cap is not recorded). If the data changes outside the history — for example a file edited by another tool — the history resets itself rather than overwriting newer data.
- A new change clears the redo tail. Rejected changes (such as a declined schedule overlap) record nothing. Undo and redo restore exact rows, including completion timestamps and recurrence metadata.
- Bulk selections accept 1–1,000 unique rows and apply all-or-nothing: if any selected row is invalid for the action, nothing is written. Skipped occurrences cannot change completion status; completed recurring occurrences must be reopened before they can be skipped by a bulk delete.
- Bulk reschedule moves due dates and shifts existing reminders to the same local clock time on the new date. An empty date clears due dates and keeps reminders unchanged. Recurring occurrences are rejected and must be rescheduled from their editor.

## Notification center and snoozes

- Delivered reminders are recorded per profile with their title, body, category, and target. The **Recent** tab is an inbox, newest first, retaining up to 2,000 entries for 180 days. Unread state drives the bell badge and the Recent tab count; **Mark all read** and **Clear history** act only on the active profile.
- Snooze presets are local-time based: 10 minutes, 1 hour, or 09:00 tomorrow. A snoozed reminder suppresses its original toast and fires once when the snooze expires, even if the original event is already past. Up to 500 reminders can be snoozed per profile; expired and stale snoozes are pruned automatically. **Unsnooze** restores the original upcoming reminder, and clearing delivered history leaves active snoozes in place.
- Quick actions reuse the regular validated stores: **Complete** for pending tasks and activities, **Mark done** for a habit due today, and **Open** to jump to the item. A quick action marks the inbox entry read. Actions and snoozes are rejected while the profile is locked.
- Native toast clicks restore and focus the window before opening the matching task, activity, habit, or goal. The Settings **Send test notification** button verifies that the operating system allows TaskForge notifications; test toasts are not added to the inbox.

## Export and interchange

- **Export calendar (.ics)** writes one iCalendar file containing schedule activities (excluding skipped occurrences) and tasks that have a due date. Activities use floating local start/end times so they follow the importing calendar's time zone; tasks are all-day events on their due date. Titles and descriptions are escaped per RFC 5545, long lines are folded at 75 octets without splitting UTF-8 characters, and activity reminder lead times become display alarms.
- **Tasks CSV** and **Schedule CSV** write one row per item with a UTF-8 BOM and CRLF line endings for spreadsheet compatibility. Fields include priority, due/start/end times, completion and skip state, reminders, timestamps, and a human-readable recurrence summary.
- Cells that begin with `=`, `+`, `-`, or `@` are prefixed with an apostrophe so spreadsheet software does not execute them as formulas. Exports read the active profile only, run through the same lock guard as other data actions, and are written through a native save dialog in the main process.
- Exports are snapshots: they do not include habits, goals, focus history, or app settings.

## Accessibility

- Workspace pages use landmarks and a **Skip to main content** link. Dialogs are labelled, modal focus containment comes from the native dialog element, and Escape closes the topmost interface. Navigation updates `aria-current`, the page title, and the breadcrumb live region.
- List controls name their item (for example, “Mark ‘Write report’ as completed”), selection checkboxes name the task or activity, icons are hidden from assistive technology, and status messages are announced politely while errors use an assertive alert region.
- `prefers-reduced-motion` removes transitions and animations, and `forced-colors` keeps pressed states, current navigation, priority badges, and checkmarks visible. Focus rings use the active accent color with a 3px offset.

## Testing

```sh
npm test
npm run test:e2e
```

`npm test` runs the Node test suite for storage, profiles, recurrence, reminders, export, and accessibility. `npm run test:e2e` opens the real Electron window with temporary data and checks the main flows without touching your normal profile.

## Technology

- Electron
- Node.js
- Vanilla JavaScript
- HTML5 and CSS3
- JSON files for local persistence

No frontend framework or runtime package beyond Electron is used.

## Installation and use

1. Install Node.js (the project lockfile's Electron dependencies require Node.js 22.12 or newer).
2. From the project folder, install dependencies:

   ```sh
   npm install
   ```

3. Start the desktop application:

   ```sh
   npm start
   ```

4. Run the automated storage, profile, reminder, analytics, search, export, and accessibility tests:

   ```sh
   npm test
   ```

   Run the real-window end-to-end smoke test separately (it starts Electron with isolated data):

   ```sh
   npm run test:e2e
   ```

   When running from source, an isolated data directory can be supplied for manual testing without touching your normal TaskForge data:

   ```sh
   TASKFORGE_USER_DATA_DIR=/path/to/scratch-data npm start
   ```

   This override is meant for development and testing. Installed builds always use the normal `%APPDATA%\TaskForge` data directory.

5. Build the Windows installer and desktop shortcut:

   ```sh
   npm run dist:win
   ```

   The installer is written to `dist/`. The same multi-size `assets/taskforge.ico` is used by the packaged executable and its desktop shortcut.

## Project structure

```text
TaskForge/
├── main.js
├── preload.js
├── package.json
├── package-lock.json
├── LICENSE
├── README.md
├── assets/
│   ├── taskforge-logo.svg  # Reusable vector wordmark
│   ├── taskforge-mark.svg  # Application/sidebar mark
│   ├── taskforge.png       # Electron window icon
│   └── taskforge.ico       # Windows executable and installer icon
├── data/                   # Reserved; runtime JSON is stored in Electron userData
├── src/
│   ├── index.html
│   ├── style.css
│   ├── renderer.js
│   ├── profile-store.js
│   ├── analytics-service.js
│   ├── backup-store.js
│   ├── app-settings-store.js
│   ├── task-store.js
│   ├── recurrence.js
│   ├── schedule-store.js
│   ├── focus-store.js
│   ├── habit-store.js
│   ├── goal-store.js
│   ├── notification-service.js
│   ├── notification-store.js
│   ├── export-service.js
│   ├── search-service.js
│   ├── keyboard-shortcuts.js
│   ├── undo-service.js
│   └── command-palette-service.js
├── scripts/
│   ├── smoke-ui.cjs        # Real Electron E2E smoke test
│   └── verify-package.cjs  # Packaged asar verification
└── test/
    ├── accessibility.test.js
    ├── analytics.test.js
    ├── backup.test.js
    ├── bulk-actions.test.js
    ├── command-palette.test.js
    ├── export.test.js
    ├── keyboard-shortcuts.test.js
    ├── main-process.test.js
    ├── desktop-session.test.js
    ├── focus-timer.test.js
    ├── notifications.test.js
    ├── profile-store.test.js
    ├── recurrence.test.js
    ├── search.test.js
    ├── stores.test.js
    └── undo-service.test.js
```

## Security architecture

- `main.js` owns the Electron window, native notifications, IPC handlers, profile metadata, and access to local application data.
- `preload.js` exposes small, purpose-specific APIs through `contextBridge`; the renderer does not receive Node.js or filesystem APIs.
- Renderer pages load under a restrictive Content Security Policy: local scripts and styles only, no remote connections, objects, or form submissions. Dialogs and the lock screen are excluded from the inert app shell while a profile is locked.
- Profile metadata lives in `profiles.json`. PINs entered in the renderer are sent to the main process and converted to scrypt hashes with a random 16-byte salt; plaintext PINs are never persisted, and stored hash material is never returned to the renderer. Comparing a submitted PIN uses a constant-time comparison.
- A profile PIN is an application-level privacy gate, not encryption. Someone with access to your Windows account and the TaskForge data folder can read the JSON files directly. Use OS disk encryption if at-rest protection is required.
- While a profile is locked, every data, settings, backup, notification, and focus-timer IPC handler rejects requests. Profile switching and unlock remain available through a dedicated set of handlers.
- After five consecutive incorrect PIN attempts, unlock is blocked for 30 seconds. The counter is held in memory and resets after a successful unlock or when the application restarts.
- Deleting a profile is rejected for the active profile. Its data directory is moved to `deleted-profiles/` rather than erased, which preserves recovery options but is not a secure wipe.
- Reminder calculation and native desktop notifications run in the main process. Notification preferences are validated and saved in `settings.json`; a small delivery ledger prevents duplicate reminders after restarts.
- Delivered reminder metadata, read state, and snooze deadlines are validated and stored per profile. Snoozed deliveries use a derived identifier so the original reminder is not shown twice, and stale snooze records are removed when their item is completed, archived, or deleted.
- The notification center receives a limited reminder list and inbox through dedicated preload IPC methods; the renderer has no direct filesystem access.
- Universal search indexes the records already loaded for the workspace and uses the existing reminder IPC bridge for upcoming notification matches. It stores only the most recent six submitted/selected search strings in renderer local storage; it does not duplicate application records.
- The command palette uses the same renderer navigation and actions as the existing interface. Its recent history stores up to eight known command IDs in renderer local storage; command search text is not persisted.
- Native file dialogs and backup file I/O remain in the main process. The renderer can only request export, restore, or last-backup metadata through dedicated IPC methods.
- Calendar and CSV exports are generated in the main process from the active profile after the lock guard. iCalendar text is escaped and folded per RFC 5545; CSV cells that begin with spreadsheet formula characters are prefixed so exported files cannot execute formulas when opened.
- The BrowserWindow keeps `contextIsolation` and `sandbox` enabled and `nodeIntegration` disabled.
- Data sent to task, schedule, focus, and settings stores is validated before it is written.
- JSON updates use temporary files and rename operations to avoid leaving partially written data files.

## Local data

TaskForge stores profile metadata and per-profile data in Electron's platform-specific `app.getPath('userData')` directory:

```text
userData/
├── profiles.json                 # Profile names, colors, salted PIN hashes, active profile
├── profiles/
│   └── <profile-id>/
│       ├── taskforge-tasks.json
│       ├── schedules.json
│       ├── focus.json
│       ├── habits.json
│       ├── goals.json
│       ├── settings.json
│       ├── notification-state.json
│       ├── notification-snoozes.json
│       ├── backup-state.json
│       └── backups/              # Automatic pre-restore safety copies
└── deleted-profiles/
    └── <profile-id>-<timestamp>/ # Data preserved when a profile is deleted
```

On first launch after upgrading from v2, TaskForge creates a **Default** profile and moves the previous root-level dataset files, notification history, last-backup metadata, and `backups/` directory into that profile. If a destination file already exists, the migrated file receives a timestamped suffix instead of being overwritten. Subsequent launches load the active workspace and restore persisted focus timers from every profile's directory.

These files are outside the source tree and are not synchronized to a server. Invalid JSON files are moved aside as timestamped `.corrupt-*` backups before defaults are restored. Habit and goal archive actions preserve their records. Focus timer preferences, statistics, and the active timer persist together per profile in `focus.json`. Timer transitions are saved atomically before being acknowledged; completion statistics and the successor timer are committed together to prevent duplicate credits after restart. Running sessions count elapsed wall-clock time, while paused sessions retain their exact remainder. Offline completion is credited to the original local completion date; the next session starts paused so time away cannot generate unattended cycles. Existing focus files are upgraded with a `null` active timer after preserving their original bytes in a unique `.pre-v3.1-*` safety copy. A damaged timer is cleared without discarding valid statistics.

Backup exports are one JSON document with `application`, `backupVersion`, `createdAt`, and a `data` object containing the active profile's six datasets. Portable format 2 preserves recurrence rules, occurrence identities, and skipped/ended history while intentionally excluding active timers. Legacy format-1 backups remain importable; new format-2 exports require TaskForge v3.2 or later. Avoid opening recurring data in older app versions, which do not understand skip/series semantics. Restoring replaces only the active profile's datasets after validation and confirmation and clears its running or paused timer. A copy of the pre-restore data is written to that profile's `backups/` directory; the selected source backup is never changed. The profile's `backup-state.json` stores the most recent successful export's filename and timestamp.

The Settings page's **Reset profile data** action requires confirmation and removes the current profile's six dataset files, delivered notification history, reminder snoozes, last-export metadata, and focus statistics, then recreates empty defaults. Other profiles and preserved safety backups are not affected.

The test suite covers the data stores, recurrence, profiles and PIN handling, reminders, notifications, undo/redo, bulk actions, backups, exports, and accessibility.

## License

TaskForge is released under the ISC License. See [LICENSE](LICENSE) for the full text.

Copyright (c) 2026 AnonymousVillain35.

## Author

Designed & Developed by AnonymousVillain35
