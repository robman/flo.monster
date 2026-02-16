# Messaging and Push Notifications

[flo.monster](https://flo.monster) supports push notifications so agents can reach you even when the browser is closed. Combined with PWA installation, agents become app-like experiences on your device.

Of course, your agents can just create this for you if you ask them.

## Push Notifications

Agents can send you notifications in several ways:

### From Agent Code

Inside page JavaScript, an agent can call:

```javascript
flo.notify('alert', { message: 'Your report is ready' });
```

This fires an event to the agent, which can then use it to trigger a browser notification or update the in-app notification panel.

### From a Hub

When a hub-persisted agent needs your attention -- for example, a scheduled task has completed or a monitored condition has been triggered -- it sends a push notification to your browser. This works even if the browser tab is closed, as long as the PWA is installed or the page has been visited recently.

### Notification Panel

The in-app notification centre displays notifications per agent, with badges indicating unread counts. You can review notification history and clear items from within the panel.

## Setting Up Push

Push notifications require a hub connection. Here is how to get them working:

1. **Connect to a hub** -- See [Installing a Hub](Installing-A-Hub.md) for setup instructions
2. **VAPID keys are generated automatically** -- The hub creates a VAPID key pair on first start, used for web-push authentication
3. **Browser subscribes on connection** -- When you connect to a hub, the browser automatically subscribes to push notifications
4. **Hub sends push** -- When an agent needs your attention, the hub sends a push notification via the web-push protocol

**PIN verification** -- During setup, a PIN verification step ensures the push subscription is securely associated with your browser session.

> **Note:** Browser-local notifications (the in-app notification panel) work without a hub. Push notifications that arrive when the browser is closed require a hub connection.

## PWA Installation

[flo.monster](https://flo.monster) can be installed as a Progressive Web App (PWA), giving it an app-like presence on your device.

### Chrome / Edge (Desktop and Android)

An install button appears in the address bar when the site meets PWA criteria. You can also install via the browser menu: **Settings > Install flo.monster**.

### iOS / iPadOS (Safari)

1. Tap the **Share** button (the square with an upward arrow)
2. Scroll down and tap **Add to Home Screen**
3. Confirm the name and tap **Add**

A guided modal within [flo.monster](https://flo.monster) explains this process if it detects you are on iOS and have not yet installed.

### Benefits of PWA Installation

- **Full-screen experience** -- No browser chrome, just your agents
- **App icon on home screen / dock** -- Launch [flo.monster](https://flo.monster) like any other app
- **Offline support** -- Cached assets load instantly, even without a network connection
- **Push notifications** -- Receive alerts from hub agents even when the app is not open

## Offline Support

[flo.monster](https://flo.monster)'s Service Worker caches all application assets for offline resilience.

### When Offline

- The app loads normally from cache
- An offline indicator appears in the UI
- Actions are queued and will be processed when connectivity returns
- Browser-only agents continue to function (they run entirely in your browser)

### When Back Online

- The app reconnects automatically
- Queued state is synchronised
- Hub connections are re-established

### Hub Agents While Offline

Hub-persisted agents show a "Hub Offline" indicator when the hub is unreachable. The browser retries with exponential backoff. There is no local fallback for hub agents -- this is intentional, to avoid split-brain state conflicts between the browser and the hub.

## flo.notify() Details

The `flo.notify()` API is the primary way page JavaScript communicates events to the agent:

```javascript
flo.notify('task_complete', { result: 'success', records: 1247 });
```

- Fires an event to the agent with the given name and data
- Shows in the notification panel with the agent's badge
- If push is configured and the browser is closed, the hub can send a push notification
- Users can review notifications per agent in the notification panel

## Use Cases

- **Scheduled task completion** -- "Your daily report is ready"
- **Monitoring alerts** -- "Server CPU above 90%"
- **Reminders** -- "Meeting with Sarah in 15 minutes"
- **Background task progress** -- "Data import complete (1,247 records)"
- **State escalations** -- "Shopping list has more than 10 items"
- **Browser connect/disconnect** -- "A new browser just connected to your agent"

## See Also

- [Installing a Hub](Installing-A-Hub.md) -- Set up a hub for persistence and push
- [Scheduling Tasks](Scheduling-Tasks.md) -- Cron jobs and event triggers for autonomous agents
- [Getting Started](Getting-Started.md) -- First steps with [flo.monster](https://flo.monster) 
- [Storage and State](Storage-And-State.md) -- Reactive state and escalation rules
