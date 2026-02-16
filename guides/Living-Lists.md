# Living Lists -- The Personal Dashboard

A walkthrough of a simple [flo.monster](https://flo.monster) demo: a personal dashboard where you speak naturally and the agent classifies and organises everything for you.

## The Idea

Imagine a single page that replaces your todo app, shopping list, calendar reminders, and sticky notes. You don't pick a list or fill out a form. You just say what's on your mind:

- *"buy eggs"* -- appears in **Shopping**
- *"follow up with Steve"* -- appears in **Todo**
- *"go for a run tomorrow"* -- appears in **Exercise** with tomorrow's date
- *"dentist at 3pm Thursday"* -- appears in **Schedule**
- *"remember to call Sarah"* -- appears in **Notes**

The agent classifies each input automatically. Context and intent are enough -- you never have to specify which list an item belongs to.

## The Template

To create one for yourself you can use the template included in your own [flo.monster](https://flo.monster). Just create a new agent and then select the "Templates" tab and select the "Living Lists" template - and you're done.

## The Prompt

To see how this template was created here's the prompt we used.

```
Create a Personal Dashboard — "The Living List"     

A clean, mobile-first dashboard with categorised todo lists. The primary input is speech — tap a mic button, speak naturally, and the input is automatically classified into the right list. Set view state to ui-only.

Lists & Persistence
- Default lists: Shopping, Todo, Exercise, Schedule, Notes
- Users can add, rename, and delete lists via the UI (delete requires confirmation)
- All data persists via flo.state — lists and items survive page reloads
- Load the flo-media skill for speech recognition (flo.speech)

Dashboard View (main screen)
- Summary grid: each list shown as a card with name and item count (e.g. "Shopping (3)"). Tapping a card navigates to that list's detail view.
- Persistent footer bar with a large, prominent "Tap to Speak" mic button — this is the hero interaction. Also a small "+" to add a new list, and a small "manage lists" button (rename/delete).

Speech Input Flow
1. Tap mic → mic button becomes "Cancel" and "Save" buttons
2. Speech recognition runs — show recognised text in a large readable font centered on screen so the user can verify it
3. Tapping the text area makes it editable (brings up soft keyboard for manual correction) — but don't show a text input field by default, keep the viewport clean
4. Save → brief "Processing..." state → classify the input into the right list based on context and intent (pick from existing list names, default to Todo if unclear) → brief confirmation showing which list it was added to → return to dashboard
5. Cancel → discard and return to dashboard
6. The mic footer stays visible in list detail view too, so you can add items from anywhere

List Detail View
- Shows all items in the selected list
- Each item: checkbox (toggles done), text, delete button
- Done items: checked, greyed out, remain visible until manually deleted
- Back button returns to dashboard

Design Notes
- Mobile-first, clean, minimal — this is a demo template people can extend
- The mic button is the visual centerpiece
- Keep the summary grid scannable, list items easy to interact with
- Remember this runs in ui-only so you have the full viewport
```

The agent then built the entire dashboard in one go -- layout, styling, interactivity, and persistence. Just like with Claude Code or similar agentic coding systems a more complex solution may take a few minutes to complete.

And of course, you can use your [flo.monster](https://flo.monster) agent to help you create this prompt. You can chat with it to refine your idea, ask it to interview you to get the details right, or even get it to create an interactive form that it uses to collect structure information from you about what you want.

## What the Agent Builds

After a few moments, you'll see:

- **A dashboard grid** with a card for each category (Shopping, Todo, Exercise, Schedule, Notes) showing the list name and active item count
- **Tap a card** to navigate to that list's detail view -- each item has a checkbox toggle and a delete button
- **A persistent footer** with a large microphone button (the hero interaction), a "+" button to add new lists, and a settings button to manage (rename/delete) lists
- **A full-screen speech input overlay** -- tap the mic, speak, see the recognised text, then save or cancel

The dashboard is fully interactive from the moment it appears. Tap the mic, speak an item, and it gets classified and added to the right list instantly.

## How It Works Under the Hood

### State Management with `flo.state`

The dashboard stores all data in two `flo.state` keys -- [flo.monster](https://flo.monster)'s reactive persistence layer:

```
lists: ["Shopping", "Todo", "Exercise", "Schedule", "Notes"]
items: {
  Shopping: [{ text: "eggs", done: false }, ...],
  Todo:     [{ text: "follow up with Steve", done: false }, ...],
  ...
}
```

Page JavaScript reads and writes state directly, then re-renders the UI after each change. `flo.state` persists automatically -- data survives page reloads with no extra work.

### Classification with `flo.ask()`

When you speak an item, the page JavaScript asks the agent to classify it:

1. **Page JS calls `flo.ask('classify', { text, lists })`** -- this sends the text and current list names to the agent.
2. **The agent wakes**, reads the text and list names, and decides which list the item belongs to.
3. **The agent responds** with `agent_respond({ result: { list: "Shopping", item: "Buy some eggs" } })`.
4. **Page JS receives the response**, adds the item to the correct list in `flo.state`, and updates the UI.

This is the simplest pattern for agent-powered interactions: page JavaScript handles routine UI (toggling checkboxes, deleting items, navigating between views) without involving the agent at all, and only calls on the agent when AI classification is needed.

### Interaction Handling

Toggling items done, deleting items, adding/renaming/deleting lists -- all of this is handled entirely by page JavaScript. The agent is only involved for classification. This keeps the UI snappy and avoids unnecessary agent calls.

## Scaling Up with Subagents

This template keeps things simple -- the main agent handles classification directly via `flo.ask()`. For a dashboard you use heavily (dozens of items per day), you could switch to the **architect-subagents pattern** for better cost efficiency:

- Replace `flo.ask('classify', ...)` with `flo.callTool('subagent', { task: 'Classify this item: ...' })`
- Each subagent gets a tiny, focused prompt (~200 tokens) instead of the main agent's full conversation context
- The main agent stays idle after the initial build -- zero token cost until an escalation fires

See [Subagents](Subagents.md) for the full architect-subagents pattern.

## Voice Input

Tap the microphone button, say *"buy eggs"*, and see *"Added to Shopping"* appear as a toast notification. The full loop -- speech-to-text input, classification, state update, visual confirmation -- takes a couple of seconds.

Voice is especially useful hands-free: while cooking, driving, or exercising. It's as quick as sending a voice note, but with a visual dashboard you can glance at instead of scrolling through a chat thread.

See [Voice](Voice.md) for setup details.

## Customising It

The dashboard is a living surface -- you can reshape it by talking to the agent:

- *"Add a Work category"* -- new card appears in the grid
- *"Remove the Exercise list"* -- gone
- *"Add priority levels to todo items"* -- items gain High/Medium/Low badges
- *"Colour-code the categories"* -- each section gets a distinct colour
- *"Show due dates on schedule items"* -- date badges appear
- *"Add a weekly summary view"* -- agent builds a second skin you can switch to
- *"Sort shopping items by when I added them"* -- sort order changes

The agent modifies the page structure, styles, and logic in response. The dashboard evolves to match how you use it. And when you're happy you can save your updated agent as a template - in case you want to create another agent like this, keep a backup, or share your template with other people (just download and send it to them).

## Persistence

`flo.state` survives page reloads automatically. Close the tab, come back later -- your lists are exactly where you left them.

If you connect to a **hub**, persistence extends further:

- **Survives browser close entirely** -- the hub stores state server-side
- **Works across devices** -- same dashboard on your phone and laptop
- **Agent continues running** -- can send proactive notifications (e.g., morning summary of your schedule)

See [Installing a Hub](Installing-A-Hub.md) for how to set this up.

## Progressive Enhancement

As you use the dashboard over days and weeks, the agent accumulates knowledge:

- It learns your categories and may suggest adding new ones (*"You mention work tasks a lot -- want a separate Work list?"*)
- It spots patterns (*"You usually run on Tuesdays and Thursdays"*)
- It can summarise (*"You completed 12 tasks this week"*)
- It can offer alternative views (*"Show me a weekly calendar"* produces a new skin layout)

Asking an agent to review data you've collected to provide more insights is a great way to get more value out of your creations. And of course you can ask it to schedule tasks (especially if you're running a hub) so it can process these tasks at specific times in the future, and even send you push notifications as required.

## Further Reading

- **[Getting Started](Getting-Started.md)** -- First-time setup if you haven't done it yet
- **[Templates](Templates.md)** -- How templates and the `.srcdoc` format work
- **[Storage and State](Storage-And-State.md)** -- Deep dive into `flo.state` and persistence
- **[Subagents](Subagents.md)** -- Scaling up with the architect-subagents pattern
- **[Voice](Voice.md)** -- Setting up speech input and output
- **[Bidirectional Interactions](Bidirectional-Interactions.md)** -- How agents see and respond to UI clicks
