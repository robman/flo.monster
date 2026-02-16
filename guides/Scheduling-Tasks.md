# Scheduling Tasks

Cron-like jobs and event triggers for autonomous agent execution on the hub.

Of course, your agents can just create this for you if you ask them.

## Overview

Hub-persisted agents can run on schedules -- recurring cron-like jobs for periodic tasks and event triggers for reactive execution. When a schedule fires, the agent receives the configured message as if a user had sent it, triggering a full agent turn.

Scheduling requires a [hub connection](Installing-A-Hub.md). Browser-only agents cannot use the `schedule` tool.

## The schedule Tool

The `schedule` tool is available to hub-persisted agents. It supports five actions:

| Action | Description |
|--------|-------------|
| `add` | Create a new schedule (cron-like or event trigger) |
| `list` | List all schedules for the current agent |
| `enable` | Re-enable a disabled schedule |
| `disable` | Pause a schedule without deleting it |
| `remove` | Permanently delete a schedule |

### Limits

- Maximum **10 schedules** per agent
- Minimum cron-like interval: **1 minute**
- Each agent manages only its own schedules

## Cron Schedules

Cron schedules fire periodically based on a standard five-field cron-like expression.

### Creating a Cron Schedule

```
schedule({
  action: 'add',
  type: 'cron',
  cron: '0 9 * * *',
  message: 'Generate the daily report and save it to daily-report.md'
})
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `'add'` |
| `type` | Yes | `'cron'` |
| `cron` | Yes | Cron expression (see syntax below) |
| `message` | Yes | Message sent to the agent when the schedule fires |
| `maxRuns` | No | Stop after N executions (unlimited if not set) |

### Cron Syntax

The cron-like expression uses five fields: `minute hour day month weekday`.

| Field | Values | Special Characters |
|-------|--------|-------------------|
| Minute | 0-59 | `*` (every), `*/N` (every N), `N-M` (range), `N,M` (list) |
| Hour | 0-23 | Same as above |
| Day of month | 1-31 | Same as above |
| Month | 1-12 | Same as above |
| Day of week | 0-6 (0 = Sunday) | Same as above |

### Common Examples

| Expression | Meaning |
|-----------|---------|
| `0 9 * * *` | Every day at 9:00 AM |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 * * 1` | Every Monday at midnight |
| `0 */6 * * *` | Every 6 hours |
| `30 9 * * 1-5` | Weekdays at 9:30 AM |
| `0 8,12,18 * * *` | Three times daily (8 AM, noon, 6 PM) |
| `0 0 1 * *` | First day of every month at midnight |

### Limiting Runs

Use `maxRuns` to create schedules that expire after a set number of executions:

```
schedule({
  action: 'add',
  type: 'cron',
  cron: '0 9 * * 1-5',
  message: 'Daily standup summary',
  maxRuns: 5
})
```

This runs five times (one work week), then automatically stops.

## Event Triggers

Event triggers fire when a specific condition is met, rather than on a fixed schedule. They are ideal for reactive behaviour.

### Creating an Event Trigger

```
schedule({
  action: 'add',
  type: 'event',
  event: 'state:inventory.count',
  condition: '< 5',
  message: 'Inventory is low -- check stock levels and send a reorder notification'
})
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `'add'` |
| `type` | Yes | `'event'` |
| `event` | Yes | Event name to listen for (see event types below) |
| `condition` | No | Condition that must be true for the trigger to fire |
| `message` | Yes | Message sent to the agent when the trigger fires |
| `maxRuns` | No | Stop after N executions (unlimited if not set) |

### Event Types

| Event | When It Fires |
|-------|---------------|
| `state:<key>` | When the specified `flo.state` key changes (e.g., `state:score`, `state:inventory.count`) |
| `browser:connected` | When a browser connects to this agent |
| `browser:disconnected` | When a browser disconnects from this agent |

### Condition Operators

Conditions are evaluated safely -- no `eval()` or `Function()` is used. The following operators are supported:

| Operator | Example | Meaning |
|----------|---------|---------|
| `>` | `> 100` | Value is greater than 100 |
| `>=` | `>= 50` | Value is greater than or equal to 50 |
| `<` | `< 5` | Value is less than 5 |
| `<=` | `<= 0` | Value is less than or equal to 0 |
| `==` | `== done` | Value equals "done" |
| `!=` | `!= pending` | Value does not equal "pending" |
| `changed` | `changed` | Fires whenever the value changes (any change) |
| `always` | `always` | Fires on every event occurrence |

### Event Trigger Examples

**Monitor a score threshold:**

```
schedule({
  action: 'add',
  type: 'event',
  event: 'state:score',
  condition: '> 100',
  message: 'Score exceeded 100! Congratulate the user and update the leaderboard.'
})
```

**React when a browser connects:**

```
schedule({
  action: 'add',
  type: 'event',
  event: 'browser:connected',
  message: 'A browser just connected. Update the UI with the latest data and greet the user.'
})
```

**Prepare for disconnection:**

```
schedule({
  action: 'add',
  type: 'event',
  event: 'browser:disconnected',
  message: 'Browser disconnected. Save current state summary to memory.md and switch to autonomous mode.'
})
```

**Track any state change:**

```
schedule({
  action: 'add',
  type: 'event',
  event: 'state:status',
  condition: 'changed',
  message: 'Status changed -- check the new value and take appropriate action.'
})
```

## Managing Schedules

### Listing All Schedules

```
schedule({ action: 'list' })
```

Returns a JSON object with the count and details of each schedule, including: ID, type, enabled status, cron-like expression or event name, condition, message, run count, max runs, and last run time.

### Disabling and Enabling

Pause a schedule without deleting it:

```
schedule({ action: 'disable', id: 'sched-1' })
```

Resume it later:

```
schedule({ action: 'enable', id: 'sched-1' })
```

### Deleting a Schedule

Permanently remove a schedule:

```
schedule({ action: 'remove', id: 'sched-1' })
```

## Use Cases

### Daily and Weekly Reports

An agent that generates a summary report every morning:

```
schedule({
  action: 'add',
  type: 'cron',
  cron: '0 8 * * *',
  message: 'Generate the daily summary. Read data files, compute statistics, update the dashboard, and save the report to daily-report.md.'
})
```

### Periodic Data Collection

An agent that scrapes or polls data at regular intervals:

```
schedule({
  action: 'add',
  type: 'cron',
  cron: '0 */2 * * *',
  message: 'Fetch the latest data from the API, compare with previous readings, and update flo.state with any changes.'
})
```

### Monitoring and Alerting

An event trigger that fires when a metric crosses a threshold:

```
schedule({
  action: 'add',
  type: 'event',
  event: 'state:cpu_usage',
  condition: '> 90',
  message: 'CPU usage is above 90%. Check system health, identify the cause, and send an alert notification.'
})
```

### Automated Maintenance

Periodic cleanup and housekeeping:

```
schedule({
  action: 'add',
  type: 'cron',
  cron: '0 3 * * 0',
  message: 'Weekly maintenance: clean up temporary files, archive old logs, update memory.md with the week summary.'
})
```

### Scheduled Reminders

An agent that sends reminders at specific times:

```
schedule({
  action: 'add',
  type: 'cron',
  cron: '0 9 * * 1',
  message: 'Monday morning. Review the weekly schedule, check for upcoming deadlines, and send a summary notification.',
  maxRuns: 4
})
```

## Combining with Push Notifications

The most powerful scheduling pattern combines scheduled triggers with push notifications. When a schedule fires, the agent runs its task and can then send a push notification to your phone or browser -- even if no browser tab is open.

```
Schedule fires (cron: every morning at 8am)
    |
    v
Agent wakes up, generates daily summary
    |
    v
Agent sends push notification: "3 items on your schedule today"
    |
    v
You receive the notification on your phone
```

See [Messaging and Push Notifications](Messaging-Push-Notifications.md) for setup details.

## Best Practices

**Use descriptive messages.** The `message` field is what the agent receives as its prompt when the schedule fires. Be specific about what the agent should do. *"Check for updates"* is vague; *"Fetch the latest price data from the API, compare with yesterday, and update the dashboard"* is actionable.

**Use event triggers for state-dependent actions.** If you want to react when a value crosses a threshold, use an event trigger rather than polling with a cron-like job. Event triggers are more efficient -- they only fire when the condition is met, not on a fixed interval.

**Consider cost.** Each schedule firing is a full agent turn, which consumes tokens. A cron-like job running every minute creates 1,440 turns per day. For most use cases, hourly or daily schedules are sufficient.

**Use `maxRuns` for finite tasks.** If you need a schedule to run a specific number of times (e.g., send 5 daily reminders), set `maxRuns` rather than creating the schedule and hoping to remember to delete it.

**Combine cron-like and event triggers.** Use cron-like jobs for regular maintenance and reporting. Use event triggers for reactive behaviour. Together they give agents both proactive and responsive autonomy.

## Further Reading

- **[Installing a Hub](Installing-A-Hub.md)** -- How to set up the hub server
- **[Messaging and Push Notifications](Messaging-Push-Notifications.md)** -- Sending notifications from scheduled tasks
- **[Storage and State](Storage-And-State.md)** -- The reactive state system that powers event triggers
