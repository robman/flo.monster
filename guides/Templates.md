# Templates

How pre-built agent configurations work in [flo.monster](https://flo.monster), and how to create your own.

## What Are Templates?

Templates are pre-built agent configurations that give you a starting point. Instead of describing what you want from scratch, a template provides:

- **A system prompt** -- instructions that shape the agent's behaviour, personality, and capabilities
- **An initial UI skin** (optional) -- a pre-built web page that appears immediately, so you get value in seconds rather than waiting for the agent to build from scratch

Templates are the "three seconds to value" on-ramp. Open a template URL, and you're using a purpose-built agent immediately.

## Using Templates

There are two ways to create an agent from a template:

### From the Dashboard

1. Open [flo.monster](https://flo.monster) (the multi-agent dashboard at `/`)
2. Click **+** to create a new agent
3. Browse or search the template gallery
4. Select a template -- the agent is created with the template's prompt and (if provided) its initial skin

## The `.srcdoc` Format

Agents can save their UI as `.srcdoc` files -- full HTML snapshots that can be restored later. This is the foundation for templates with pre-built skins.

### How It Works

A saved skin consists of two files:

**`dashboard.srcdoc`** -- The complete HTML of the page:
```html
<!DOCTYPE html>
<html>
<head>
  <style>/* all styles */</style>
</head>
<body>
  <!-- full UI markup -->
  <script>/* all interactivity */</script>
</body>
</html>
```

**`dashboard.srcdoc.md`** -- A companion metadata file with YAML frontmatter:
```markdown
---
title: Personal Dashboard
description: A categorised life board with smart classification
tags: [productivity, lists, dashboard]
---

A personal dashboard that classifies spoken or typed input
into categorised lists automatically.
```

### Saving a Skin

An agent saves its current UI using the `files` tool:

```
files({ action: 'write_file', path: 'dashboard.srcdoc', content: '<html>...' })
files({ action: 'write_file', path: 'dashboard.srcdoc.md', content: '---\ntitle: ...' })
```

### Loading a Skin

An agent restores a saved skin by reading the file and applying it:

```
files({ action: 'read_file', path: 'dashboard.srcdoc' })
dom({ action: 'create', html: '<the loaded content>' })
```

### Listing Available Skins

An agent can discover all saved skins using frontmatter queries:

```
files({ action: 'frontmatter', pattern: '*.srcdoc.md' })
```

This returns the metadata for all `.srcdoc.md` files, letting the agent present a list of available skins to switch between.

## Multi-Skin Management

A single agent can maintain multiple saved UIs and switch between them. For example, a data explorer agent might have:

- `overview.srcdoc` -- High-level charts and summary statistics
- `detail.srcdoc` -- Deep-dive view for a selected data segment
- `comparison.srcdoc` -- Side-by-side comparison of two periods
- `export.srcdoc` -- Clean, printable report layout

The agent saves each view as it builds it, and can restore any of them on request: *"Show me the comparison view."*

This pattern is especially useful for agents that serve multiple purposes or offer different perspectives on the same data.

## Creating Your Own Templates

To create a template that others can use:

1. **Start with a new agent** and build the experience you want through conversation
2. **Refine the system prompt** -- ask the agent to show you its current prompt, then iterate until the behaviour is right
3. **Save the UI as a `.srcdoc`** -- ask the agent: *"Save your current UI as a template"*
4. **Test it** -- create a fresh agent from your template and verify the experience works from a cold start

A good template:

- **Works immediately** -- the user sees something useful within seconds
- **Has a clear purpose** -- one well-defined use case, not a general-purpose agent
- **Is self-documenting** -- the UI makes it obvious what to do next
- **Uses `flo.state`** -- so user data persists across sessions
- **Follows the architect-subagents pattern** -- so ongoing interactions are cost-efficient

## Multi-Agent Dashboard (`/`)

Shows a dashboard with all your agents as cards. You can:

- Run multiple agents simultaneously
- Switch between agents
- Create, configure, and manage agents
- Minimise agents you're not actively using

## Further Reading

- **[Getting Started](Getting-Started.md)** -- First-time setup and your first agent
- **[Living Lists](Living-Lists.md)** -- Detailed walkthrough of the Personal Dashboard template
- **[Files](Files.md)** -- How the agent filesystem works (OPFS and hub-backed)
- **[Web UI](Web-UI.md)** -- How agents build and manipulate pages with DOM tools
